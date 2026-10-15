#!/usr/bin/env python3
"""Score onboarding signals with Jev (TypeSafe System One).

One API call per signal with 4 batched questions (Choice + 2 Scores + 2 Nouls).
Caches results to data/scores.json and rolls up hire / team / category risk.
"""
from __future__ import annotations

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SIGNALS_PATH = DATA / "example_signals.json"
SCORES_PATH = DATA / "scores.json"
API_KEY_PATH = Path.home() / ".config" / "typesafe" / "api_key"
API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
PRICE_PER_MTOK = 0.042  # USD per million input tokens; output is free
AS_OF = date(2026, 10, 15)
MAX_WORKERS = 8

QUESTIONS = {
    "category": {
        "type": "choice",
        "instructions": (
            "You are scoring a signal from a new hire in their first 90 days. "
            "What is the primary issue category this signal is about?"
        ),
        "criteria": {
            "access_tools": "Blocked or delayed access to tools, accounts, repos, VPN, SaaS, hardware",
            "role_clarity": "Unclear expectations, mandate, goals, ownership or decision rights",
            "manager_support": "Manager unavailable, unhelpful, or not giving feedback/direction",
            "social_isolation": "Loneliness, timezone exclusion, weak buddy/team connection",
            "workload": "Overloaded, catching up after delays, burnout risk, unsustainable pace",
            "admin_payroll": "Payroll, benefits, visas, expenses, HR admin paperwork",
            "none": "Positive, neutral, or no onboarding problem",
        },
    },
    "frustration": {
        "type": "score",
        "instructions": "How frustrated is the new hire (or how much frustration does this signal express)?",
        "criteria": [
            "Calm / positive / no frustration",
            "Mild annoyance",
            "Clearly frustrated",
            "Highly frustrated or angry",
        ],
    },
    "confusion": {
        "type": "score",
        "instructions": "How confused is the new hire about their role, tools, or how things work?",
        "criteria": [
            "Clear / confident",
            "Slightly unsure",
            "Moderately confused",
            "Very confused or lost",
        ],
    },
    "intent_to_leave": {
        "type": "noul",
        "instructions": "Does this signal show intent to leave, regret joining, or active job searching?",
        "criteria": {
            "true": "Explicit or strongly implied desire to quit, regret joining, or looking elsewhere",
            "false": "No leave intent; may be unhappy but not signalling exit",
        },
    },
    "blocked_from_work": {
        "type": "noul",
        "instructions": "Is this person currently blocked from doing their core work?",
        "criteria": {
            "true": "Cannot perform primary job duties due to missing access, unclear ownership, or similar",
            "false": "Able to do meaningful work despite friction",
        },
    },
}


def load_api_key() -> str:
    env = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if env:
        return env
    if API_KEY_PATH.is_file():
        return API_KEY_PATH.read_text().strip()
    raise SystemExit(f"No API key: set TYPESAFE_API_KEY or create {API_KEY_PATH}")


def tenure_days(start: str, as_of: date = AS_OF) -> int:
    return (as_of - date.fromisoformat(start)).days


def tenure_week(day: int) -> int:
    return max(1, min(13, (day // 7) + 1))


def score_signal(session: requests.Session, api_key: str, hire: dict, signal: dict) -> dict:
    state = {
        "hire": {
            "name": hire["name"],
            "role": hire["role"],
            "team": hire["team"],
            "location": hire["location"],
            "days_since_start_when_signal": signal["day"],
        },
        "signal": {
            "channel": signal["channel"],
            "text": signal["text"],
        },
        "context": (
            "This is an onboarding health signal from a new employee's first 90 days. "
            "Judge only what the signal itself shows."
        ),
    }
    payload = {"state": state, "model": MODEL, "questions": QUESTIONS}
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    for attempt in range(5):
        resp = session.post(API_URL, headers=headers, json=payload, timeout=60)
        if resp.status_code == 429:
            wait = float(resp.headers.get("retry-after", 2 ** attempt))
            time.sleep(wait)
            continue
        if resp.status_code >= 500:
            time.sleep(1 + attempt)
            continue
        resp.raise_for_status()
        body = resp.json()
        answers = body["answers"]
        usage = body.get("usage", {})
        return {
            "signal_id": signal["id"],
            "hire_id": hire["id"],
            "day": signal["day"],
            "week": tenure_week(signal["day"]),
            "channel": signal["channel"],
            "text": signal["text"],
            "model": body.get("model"),
            "category": answers["category"]["choice"],
            "category_probabilities": answers["category"]["probabilities"],
            "category_confidence": answers["category"]["confidence"],
            "frustration": answers["frustration"]["score"],
            "frustration_probabilities": answers["frustration"]["probabilities"],
            "confusion": answers["confusion"]["score"],
            "confusion_probabilities": answers["confusion"]["probabilities"],
            "intent_to_leave": answers["intent_to_leave"]["noul"],
            "blocked_from_work": answers["blocked_from_work"]["noul"],
            "usage": {
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            },
        }
    raise RuntimeError(f"Failed after retries for {signal['id']}: {resp.status_code} {resp.text[:200]}")


# Risk weights (code-owned composite scoring)
W_FRUSTRATION = 0.20
W_CONFUSION = 0.15
W_INTENT = 0.40
W_BLOCKED = 0.25
# frustration/confusion scores are 0..3 → normalize /3


def signal_risk(s: dict) -> float:
    fru = float(s["frustration"]) / 3.0
    conf = float(s["confusion"]) / 3.0
    intent = float(s["intent_to_leave"])
    blocked = float(s["blocked_from_work"])
    return (
        W_FRUSTRATION * fru
        + W_CONFUSION * conf
        + W_INTENT * intent
        + W_BLOCKED * blocked
    )


def rollup(hires: list, scored: list) -> dict:
    by_hire: dict[str, list] = {h["id"]: [] for h in hires}
    for s in scored:
        by_hire[s["hire_id"]].append(s)

    hire_summaries = []
    for h in hires:
        sigs = sorted(by_hire[h["id"]], key=lambda x: x["day"])
        risks = [signal_risk(s) for s in sigs]
        avg = sum(risks) / len(risks) if risks else 0.0
        # Recency-weighted: last 3 signals count more
        if risks:
            recent = risks[-3:]
            recent_avg = sum(recent) / len(recent)
            peak = max(risks)
            risk_score = round(0.45 * avg + 0.40 * recent_avg + 0.15 * peak, 4)
        else:
            risk_score = 0.0
        # Trend: compare first half vs second half
        if len(risks) >= 4:
            mid = len(risks) // 2
            early = sum(risks[:mid]) / mid
            late = sum(risks[mid:]) / (len(risks) - mid)
            if late - early > 0.08:
                trend = "worsening"
            elif early - late > 0.08:
                trend = "improving"
            else:
                trend = "stable"
        elif len(risks) >= 2:
            trend = "worsening" if risks[-1] > risks[0] + 0.1 else (
                "improving" if risks[0] > risks[-1] + 0.1 else "stable"
            )
        else:
            trend = "stable"

        cats = {}
        for s in sigs:
            c = s["category"]
            cats[c] = cats.get(c, 0) + 1
        top_cat = max(cats, key=cats.get) if cats else "none"
        evidence = sorted(sigs, key=signal_risk, reverse=True)[:3]

        days = tenure_days(h["start_date"])
        hire_summaries.append({
            "id": h["id"],
            "name": h["name"],
            "role": h["role"],
            "team": h["team"],
            "manager": h["manager"],
            "location": h["location"],
            "start_date": h["start_date"],
            "tenure_days": days,
            "tenure_week": tenure_week(days),
            "signal_count": len(sigs),
            "risk_score": risk_score,
            "risk_level": (
                "critical" if risk_score >= 0.45 else
                "high" if risk_score >= 0.28 else
                "medium" if risk_score >= 0.18 else
                "low"
            ),
            "trend": trend,
            "top_category": top_cat,
            "category_counts": cats,
            "max_intent": max((s["intent_to_leave"] for s in sigs), default=0),
            "max_blocked": max((s["blocked_from_work"] for s in sigs), default=0),
            "avg_frustration": round(sum(s["frustration"] for s in sigs) / len(sigs), 3) if sigs else 0,
            "avg_confusion": round(sum(s["confusion"] for s in sigs) / len(sigs), 3) if sigs else 0,
            "evidence": [
                {
                    "signal_id": e["signal_id"],
                    "day": e["day"],
                    "channel": e["channel"],
                    "text": e["text"],
                    "category": e["category"],
                    "category_prob": e["category_probabilities"].get(e["category"], 0),
                    "frustration": e["frustration"],
                    "confusion": e["confusion"],
                    "intent_to_leave": e["intent_to_leave"],
                    "blocked_from_work": e["blocked_from_work"],
                    "risk": round(signal_risk(e), 4),
                }
                for e in evidence
            ],
            "weekly": [
                {
                    "week": w,
                    "avg_risk": round(
                        sum(signal_risk(s) for s in sigs if s["week"] == w)
                        / max(1, sum(1 for s in sigs if s["week"] == w)),
                        4,
                    ),
                    "count": sum(1 for s in sigs if s["week"] == w),
                }
                for w in range(1, 14)
                if any(s["week"] == w for s in sigs)
            ],
            "signals": [{**s, "risk": round(signal_risk(s), 4)} for s in sigs],
        })

    # Team × category heatmap (avg risk of signals in that cell)
    teams = sorted({h["team"] for h in hires})
    categories = [
        "access_tools", "role_clarity", "manager_support",
        "social_isolation", "workload", "admin_payroll", "none",
    ]
    heatmap = []
    for team in teams:
        row = {"team": team}
        team_sigs = [s for s in scored if next(h for h in hires if h["id"] == s["hire_id"])["team"] == team]
        for cat in categories:
            cell = [s for s in team_sigs if s["category"] == cat]
            row[cat] = {
                "count": len(cell),
                "avg_risk": round(sum(signal_risk(s) for s in cell) / len(cell), 4) if cell else None,
            }
        team_hires = [hs for hs in hire_summaries if hs["team"] == team]
        row["team_avg_risk"] = round(
            sum(hs["risk_score"] for hs in team_hires) / len(team_hires), 4
        ) if team_hires else 0
        row["hires_at_risk"] = sum(1 for hs in team_hires if hs["risk_level"] in ("high", "critical"))
        heatmap.append(row)

    # Risk over tenure week (cohort)
    by_week = {}
    for s in scored:
        by_week.setdefault(s["week"], []).append(signal_risk(s))
    weekly_curve = [
        {"week": w, "avg_risk": round(sum(by_week[w]) / len(by_week[w]), 4), "n": len(by_week[w])}
        for w in sorted(by_week)
    ]

    # Category totals
    cat_totals = {}
    for s in scored:
        c = s["category"]
        cat_totals.setdefault(c, {"count": 0, "risk_sum": 0.0})
        cat_totals[c]["count"] += 1
        cat_totals[c]["risk_sum"] += signal_risk(s)
    category_summary = [
        {
            "category": c,
            "count": v["count"],
            "avg_risk": round(v["risk_sum"] / v["count"], 4),
        }
        for c, v in sorted(cat_totals.items(), key=lambda x: -x[1]["count"])
    ]

    at_risk = [hs for hs in hire_summaries if hs["risk_level"] in ("high", "critical")]
    top_issue = category_summary[0]["category"] if category_summary else "none"
    # Prefer non-none top issue
    for cs in category_summary:
        if cs["category"] != "none":
            top_issue = cs["category"]
            break

    kpis = {
        "total_hires": len(hire_summaries),
        "hires_at_risk": len(at_risk),
        "avg_risk": round(sum(hs["risk_score"] for hs in hire_summaries) / len(hire_summaries), 4),
        "top_issue": top_issue,
        "critical_count": sum(1 for hs in hire_summaries if hs["risk_level"] == "critical"),
        "high_count": sum(1 for hs in hire_summaries if hs["risk_level"] == "high"),
        "signals_scored": len(scored),
    }

    return {
        "kpis": kpis,
        "hires": sorted(hire_summaries, key=lambda x: -x["risk_score"]),
        "heatmap": heatmap,
        "weekly_curve": weekly_curve,
        "category_summary": category_summary,
        "teams": teams,
        "categories": categories,
    }


def main() -> None:
    api_key = load_api_key()
    raw = json.loads(SIGNALS_PATH.read_text())
    hires = raw["hires"]
    jobs = [(h, s) for h in hires for s in h["signals"]]
    print(f"Scoring {len(jobs)} signals across {len(hires)} hires with Jev ({MODEL})…")

    scored = []
    total_in = 0
    total_out = 0
    errors = []
    t0 = time.time()

    with requests.Session() as session:
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futs = {
                pool.submit(score_signal, session, api_key, h, s): (h["id"], s["id"])
                for h, s in jobs
            }
            done = 0
            for fut in as_completed(futs):
                hid, sid = futs[fut]
                done += 1
                try:
                    result = fut.result()
                    scored.append(result)
                    total_in += result["usage"]["input_tokens"]
                    total_out += result["usage"]["output_tokens"]
                    if done % 10 == 0 or done == len(jobs):
                        print(f"  {done}/{len(jobs)}  tokens_in={total_in}")
                except Exception as e:
                    errors.append({"hire_id": hid, "signal_id": sid, "error": str(e)})
                    print(f"  ERROR {sid}: {e}", file=sys.stderr)

    elapsed = time.time() - t0
    cost_usd = (total_in / 1_000_000) * PRICE_PER_MTOK
    aggregates = rollup(hires, scored)

    out = {
        "meta": {
            "label": "EXAMPLE DATA — scored with Jev",
            "as_of": AS_OF.isoformat(),
            "scored_at": datetime.now().isoformat(timespec="seconds"),
            "model": MODEL,
            "questions": list(QUESTIONS.keys()),
            "risk_weights": {
                "frustration": W_FRUSTRATION,
                "confusion": W_CONFUSION,
                "intent_to_leave": W_INTENT,
                "blocked_from_work": W_BLOCKED,
            },
            "usage": {
                "requests": len(scored),
                "input_tokens": total_in,
                "output_tokens": total_out,
                "elapsed_seconds": round(elapsed, 2),
                "cost_usd": round(cost_usd, 6),
                "price_per_mtok_usd": PRICE_PER_MTOK,
            },
            "errors": errors,
        },
        "aggregates": aggregates,
        "signals": scored,
    }
    SCORES_PATH.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {SCORES_PATH}")
    print(f"Requests: {len(scored)}  input_tokens: {total_in}  cost: ${cost_usd:.6f}")
    print(f"At risk: {aggregates['kpis']['hires_at_risk']} / {aggregates['kpis']['total_hires']}")
    print(f"Top issue: {aggregates['kpis']['top_issue']}")
    if errors:
        print(f"Errors: {len(errors)}")


if __name__ == "__main__":
    main()
