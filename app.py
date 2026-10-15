#!/usr/bin/env python3
"""Onboarding Pulse — FastAPI backend + dashboard."""
from __future__ import annotations

import json
import os
from pathlib import Path

import requests
import asyncio
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
SCORES_PATH = DATA / "scores.json"
API_KEY_PATH = Path.home() / ".config" / "typesafe" / "api_key"
API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"

# Same questions as score_signals.py
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

app = FastAPI(title="Onboarding Pulse", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")


def load_scores() -> dict:
    if not SCORES_PATH.is_file():
        raise HTTPException(503, "scores.json missing — run score_signals.py first")
    return json.loads(SCORES_PATH.read_text())


def api_key() -> str:
    env = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if env:
        return env
    if API_KEY_PATH.is_file():
        return API_KEY_PATH.read_text().strip()
    raise HTTPException(500, "TypeSafe API key not configured on server")


@app.get("/", response_class=HTMLResponse)
def index():
    return (ROOT / "templates" / "index.html").read_text()


@app.get("/api/dashboard")
def dashboard():
    data = load_scores()
    return {
        "meta": data["meta"],
        "aggregates": data["aggregates"],
    }


@app.get("/api/hire/{hire_id}")
def hire_detail(hire_id: str):
    data = load_scores()
    for h in data["aggregates"]["hires"]:
        if h["id"] == hire_id:
            return h
    raise HTTPException(404, "Hire not found")


class ScoreRequest(BaseModel):
    text: str = Field(..., min_length=3, max_length=2000)
    channel: str = Field(default="slack")
    day: int = Field(default=30, ge=1, le=90)
    role: str = Field(default="New hire")
    team: str = Field(default="Unknown")


@app.post("/api/score")
def score_live(body: ScoreRequest):
    key = api_key()
    state = {
        "hire": {
            "role": body.role,
            "team": body.team,
            "days_since_start_when_signal": body.day,
        },
        "signal": {"channel": body.channel, "text": body.text},
        "context": (
            "This is an onboarding health signal from a new employee's first 90 days. "
            "Judge only what the signal itself shows."
        ),
    }
    payload = {"state": state, "model": MODEL, "questions": QUESTIONS}
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    try:
        resp = requests.post(API_URL, headers=headers, json=payload, timeout=45)
        resp.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(502, f"Jev request failed: {e}") from e
    result = resp.json()
    answers = result["answers"]
    fru = answers["frustration"]["score"] / 3.0
    conf = answers["confusion"]["score"] / 3.0
    intent = answers["intent_to_leave"]["noul"]
    blocked = answers["blocked_from_work"]["noul"]
    risk = 0.20 * fru + 0.15 * conf + 0.40 * intent + 0.25 * blocked
    return {
        "model": result.get("model"),
        "category": answers["category"]["choice"],
        "category_probabilities": answers["category"]["probabilities"],
        "category_confidence": answers["category"]["confidence"],
        "frustration": answers["frustration"]["score"],
        "confusion": answers["confusion"]["score"],
        "intent_to_leave": intent,
        "blocked_from_work": blocked,
        "risk": round(risk, 4),
        "usage": result.get("usage"),
    }



def _compute_risk(frustration: float, confusion: float, intent: float, blocked: float) -> float:
    fru = frustration / 3.0
    conf = confusion / 3.0
    return round(0.20 * fru + 0.15 * conf + 0.40 * intent + 0.25 * blocked, 4)


def _load_stream_signals(limit: int = 22) -> list[dict]:
    example = json.loads((DATA / "example_signals.json").read_text())
    scores = json.loads(SCORES_PATH.read_text())
    cache = {}
    for s in scores.get("signals", []):
        cache[s["signal_id"]] = {
            "category": s["category"],
            "category_confidence": s["category_confidence"],
            "frustration": s["frustration"],
            "confusion": s["confusion"],
            "intent_to_leave": s["intent_to_leave"],
            "blocked_from_work": s["blocked_from_work"],
            "risk": _compute_risk(
                s["frustration"], s["confusion"], s["intent_to_leave"], s["blocked_from_work"]
            ),
        }
    flat = []
    for h in example["hires"]:
        for s in h["signals"]:
            flat.append(
                {
                    "signal_id": s["id"],
                    "hire_id": h["id"],
                    "hire": h["name"],
                    "team": h["team"],
                    "role": h["role"],
                    "day": s["day"],
                    "channel": s["channel"],
                    "text": s["text"],
                    "cached": cache.get(s["id"]),
                }
            )
    flat.sort(key=lambda x: ((x["cached"] or {}).get("risk", 0), x["day"]), reverse=True)
    return flat[:limit]


def _snapshot(seen: list[dict]) -> dict:
    n = len(seen)
    avg = sum(x["risk"] for x in seen) / n if n else 0.0
    hire_max: dict[str, float] = {}
    cat_count: dict[str, int] = {}
    for s in seen:
        hire_max[s["hire_id"]] = max(hire_max.get(s["hire_id"], 0.0), s["risk"])
        cat_count[s["category"]] = cat_count.get(s["category"], 0) + 1
    at_risk = critical = high = 0
    for r in hire_max.values():
        if r >= 0.45:
            at_risk += 1
            critical += 1
        elif r >= 0.28:
            at_risk += 1
            high += 1
    top, top_n = "none", -1
    for c, count in cat_count.items():
        if c == "none":
            continue
        if count > top_n:
            top, top_n = c, count
    return {
        "type": "snapshot",
        "kpis": {
            "total_hires": len(hire_max),
            "hires_at_risk": at_risk,
            "avg_risk": round(avg, 4),
            "top_issue": top,
            "critical_count": critical,
            "high_count": high,
            "signals_scored": n,
        },
        "atRiskCount": at_risk,
    }


@app.get("/api/stream")
async def stream_signals(request: Request, live: int = Query(0)):
    """SSE feed of example signals. Finite ~22 events (~25s). Replay from the client."""
    signals = _load_stream_signals(22)
    key = ""
    try:
        key = api_key() if live == 1 else ""
    except HTTPException:
        key = ""

    async def gen():
        def pack(obj: dict) -> str:
            return f"data: {json.dumps(obj)}\n\n"

        yield pack(
            {
                "type": "meta",
                "total": len(signals),
                "interval_ms": 1000,
                "live_jev": bool(key),
                "note": "Finite pass (~22 events). Use Replay to restart.",
            }
        )
        seen: list[dict] = []
        for i, sig in enumerate(signals):
            if await request.is_disconnected():
                break
            scores = sig.get("cached")
            source = "cache" if scores else "none"
            if key:
                try:
                    body = ScoreRequest(
                        text=sig["text"],
                        channel=sig["channel"],
                        day=sig["day"],
                        role=sig["role"],
                        team=sig["team"],
                    )
                    # Run sync Jev call in thread; fall back to cache on failure
                    live_result = await asyncio.to_thread(score_live, body)
                    scores = {
                        "category": live_result["category"],
                        "category_confidence": live_result["category_confidence"],
                        "frustration": live_result["frustration"],
                        "confusion": live_result["confusion"],
                        "intent_to_leave": live_result["intent_to_leave"],
                        "blocked_from_work": live_result["blocked_from_work"],
                        "risk": live_result["risk"],
                    }
                    source = "jev"
                except Exception:
                    pass
            category = (scores or {}).get("category", "none")
            risk = (scores or {}).get("risk", 0.0)
            yield pack(
                {
                    "type": "signal",
                    "id": sig["signal_id"],
                    "hire_id": sig["hire_id"],
                    "hire": sig["hire"],
                    "team": sig["team"],
                    "text": sig["text"],
                    "channel": sig["channel"],
                    "day": sig["day"],
                    "scores": scores,
                    "risk": risk,
                    "source": source,
                    "index": i + 1,
                    "total": len(signals),
                }
            )
            seen.append(
                {
                    "hire_id": sig["hire_id"],
                    "team": sig["team"],
                    "category": category,
                    "risk": risk,
                }
            )
            if (i + 1) % 3 == 0 or i == len(signals) - 1:
                yield pack(_snapshot(seen))
            if i < len(signals) - 1:
                await asyncio.sleep(1.0)
        yield pack({"type": "done", "count": len(seen)})

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/api/health")
def health():
    ok = SCORES_PATH.is_file()
    return {"ok": ok, "scores": ok}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8080, reload=False)
