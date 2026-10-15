#!/usr/bin/env python3
"""Onboarding Pulse — FastAPI backend + dashboard."""
from __future__ import annotations

import json
import os
from pathlib import Path

import requests
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
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


@app.get("/api/health")
def health():
    ok = SCORES_PATH.is_file()
    return {"ok": ok, "scores": ok}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8080, reload=False)
