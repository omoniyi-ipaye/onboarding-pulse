"""Feedback Gauge — standalone FastAPI twin of omoniyios /pulse."""
from __future__ import annotations

import json
import os
import asyncio
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
API_URL = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
INTERVAL_MS = 1000
MAX_EVENTS = 22

app = FastAPI(title="Feedback Gauge")
app.mount("/static", StaticFiles(directory=str(ROOT / "static")), name="static")
templates = Jinja2Templates(directory=str(ROOT / "templates"))

QUESTIONS = {
    "theme": {
        "type": "choice",
        "instructions": "Which Culture Amp–style engagement driver is this feedback primarily about?",
        "criteria": {
            "leadership": "Manager quality, senior leadership trust, decision clarity, sponsorship",
            "belonging": "Inclusion, psychological safety, team connection, remote belonging",
            "growth": "Learning, career path, stretch, promotion readiness",
            "workload": "Pace, burnout, staffing, sustainable capacity",
            "recognition": "Acknowledgement, celebration of wins, feeling valued",
            "enablement": "Tools, resources, training, process support to do the job",
            "alignment": "Strategy clarity, priorities, OKRs, knowing how work connects",
        },
    },
    "engagement_health": {
        "type": "score",
        "instructions": "How healthy/positive is this feedback for employee engagement?",
        "criteria": [
            "Clearly negative or demoralizing for engagement",
            "Mostly concerning with limited positives",
            "Mixed or mildly constructive",
            "Clearly positive / affirming engagement",
        ],
    },
    "flight_risk": {
        "type": "score",
        "instructions": "How much does this suggest attrition or serious disengagement risk?",
        "criteria": [
            "No attrition or disengagement signal",
            "Mild dissatisfaction without exit language",
            "Strong frustration or conditional stay language",
            "Explicit or near-explicit intent to leave / protect health by leaving",
        ],
    },
    "performance_signal": {
        "type": "score",
        "instructions": "Where does this sit between performance strength and performance concern?",
        "criteria": [
            "Clear performance strength or high contribution",
            "Neutral / not about individual performance",
            "Mild performance or enablement concern",
            "Serious performance, capacity, or delivery concern",
        ],
    },
}


def api_key() -> str:
    return (os.environ.get("TYPESAFE_API_KEY") or "").strip() or _file_key()


def _file_key() -> str:
    p = Path.home() / ".config/typesafe/api_key"
    try:
        return p.read_text().strip()
    except OSError:
        return ""


def composite(eng: int, flight: int, perf: int) -> tuple[int, float]:
    e, f, c = eng / 3, flight / 3, perf / 3
    gauge = round((0.5 * e + 0.3 * (1 - f) + 0.2 * (1 - c)) * 100)
    risk = round((0.45 * f + 0.35 * (1 - e) + 0.2 * c) * 10000) / 10000
    return gauge, risk


def load_json(name: str) -> Any:
    return json.loads((DATA / name).read_text())


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    dashboard = load_json("dashboard.json")
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "dashboard": dashboard, "product": "Feedback Gauge"},
    )


@app.get("/api/dashboard")
async def dashboard():
    return load_json("dashboard.json")


@app.post("/api/score")
async def score(body: dict[str, Any]):
    text = (body.get("text") or "").strip()
    if len(text) < 3 or len(text) > 2000:
        return JSONResponse({"error": "text must be 3–2000 chars"}, status_code=400)
    channel = body.get("channel") or "survey"
    key = api_key()
    if not key:
        return _heuristic(text)
    payload = {
        "state": {
            "employee": {"role": body.get("role") or "Employee", "team": body.get("team") or "Unknown"},
            "feedback": {"channel": channel, "text": text},
            "context": "Harbor Labs demo. Culture Amp–style feedback. Judge only the text.",
            "company": "Harbor Labs (fictional)",
        },
        "model": MODEL,
        "questions": QUESTIONS,
    }
    try:
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.post(
                API_URL,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json=payload,
            )
        if resp.status_code != 200:
            out = _heuristic(text)
            out["warning"] = f"Jev {resp.status_code}; heuristic"
            return out
        result = resp.json()
        a = result["answers"]
        eng = a["engagement_health"]["score"]
        flight = a["flight_risk"]["score"]
        perf = a["performance_signal"]["score"]
        gauge, risk = composite(eng, flight, perf)
        return {
            "model": result.get("model"),
            "theme": a["theme"]["choice"],
            "theme_confidence": a["theme"]["confidence"],
            "engagement_health": eng,
            "flight_risk": flight,
            "performance_signal": perf,
            "gauge": gauge,
            "risk": risk,
            "source": "jev",
        }
    except Exception as exc:  # noqa: BLE001
        out = _heuristic(text)
        out["warning"] = f"{exc}; heuristic"
        return out


def _heuristic(text: str) -> dict[str, Any]:
    t = text.lower()
    theme = "alignment"
    for name, needles in [
        ("leadership", ["manager", "leadership", "exec", "decision"]),
        ("belonging", ["belong", "team", "remote", "timezone"]),
        ("growth", ["growth", "career", "promot", "stretch"]),
        ("workload", ["workload", "burn", "exhaust", "unsustainable"]),
        ("recognition", ["recognit", "celebrat", "valued"]),
        ("enablement", ["enable", "tool", "pipeline", "budget"]),
        ("alignment", ["align", "priorit", "okr", "strategy"]),
    ]:
        if any(n in t for n in needles):
            theme = name
            break
    leave = any(x in t for x in ["looking", "quit", "leave", "step down"])
    neg = sum(t.count(w) for w in ["burn", "exhaust", "frustrated", "unsustainable", "waiting"])
    eng = 0 if leave or neg >= 3 else (1 if neg >= 2 else (3 if "excellent" in t or "proud" in t else 2))
    flight = 3 if leave else (2 if neg >= 2 else (1 if neg else 0))
    perf = 3 if leave else (2 if "burn" in t or "exhaust" in t else 1)
    gauge, risk = composite(eng, flight, perf)
    return {
        "model": "heuristic-v1",
        "theme": theme,
        "theme_confidence": 0.65,
        "engagement_health": eng,
        "flight_risk": flight,
        "performance_signal": perf,
        "gauge": gauge,
        "risk": risk,
        "source": "heuristic",
    }


def _flat_signals() -> list[dict[str, Any]]:
    example = load_json("example_signals.json")
    scores = load_json("scores.json")
    people = {p["id"]: p for p in example["people"]}
    cache = {s["signal_id"]: s for s in scores["signals"]}
    flat = []
    for s in example["signals"]:
        person = people.get(s["person_id"])
        if not person:
            continue
        c = cache.get(s["id"])
        flat.append(
            {
                "signal_id": s["id"],
                "person_id": s["person_id"],
                "person": person["name"],
                "team": person["team"],
                "role": person["role"],
                "period": s["period"],
                "channel": s["channel"],
                "text": s["text"],
                "cached": c,
            }
        )
    flat.sort(key=lambda x: (-(x["cached"] or {}).get("risk", 0), -x["period"]))
    return flat[:MAX_EVENTS]


@app.get("/api/stream")
async def stream(request: Request):
    signals = _flat_signals()

    async def gen():
        meta = {
            "type": "meta",
            "total": len(signals),
            "interval_ms": INTERVAL_MS,
            "product": "Feedback Gauge",
        }
        yield f"data: {json.dumps(meta)}\n\n"
        for i, sig in enumerate(signals):
            if await request.is_disconnected():
                break
            c = sig.get("cached") or {}
            evt = {
                "type": "signal",
                "id": sig["signal_id"],
                "person_id": sig["person_id"],
                "person": sig["person"],
                "team": sig["team"],
                "text": sig["text"],
                "channel": sig["channel"],
                "period": sig["period"],
                "scores": {
                    "theme": c.get("theme"),
                    "engagement_health": c.get("engagement_health"),
                    "flight_risk": c.get("flight_risk"),
                    "performance_signal": c.get("performance_signal"),
                    "gauge": c.get("gauge_delta"),
                }
                if c
                else None,
                "risk": c.get("risk", 0),
                "gauge": c.get("gauge_delta", 70),
                "source": "cache",
                "index": i + 1,
                "total": len(signals),
            }
            yield f"data: {json.dumps(evt)}\n\n"
            if i < len(signals) - 1:
                await asyncio.sleep(INTERVAL_MS / 1000)
        yield f"data: {json.dumps({'type': 'done', 'count': len(signals)})}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
