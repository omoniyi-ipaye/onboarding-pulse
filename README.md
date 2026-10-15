# Feedback Gauge

> **Product rename:** this repository previously shipped **Onboarding Pulse** (first-90-day attrition). It is now **Feedback Gauge** — an org engagement / performance gauge from Culture Amp–style survey comments and review feedback.

**Live demo (canonical):** [omoniyios.com/pulse](https://www.omoniyios.com/pulse)  
**Source of truth for the UI:** [`omoniyi-ipaye/omoniyios`](https://github.com/omoniyi-ipaye/omoniyios) (`/pulse` route).

This FastAPI app is a lightweight standalone twin of the same demo data + SSE stream, kept so the GitHub repo is not stale marketing for the old product.

## What it measures

- **Employee gauge (0–100)** from qualitative feedback (engagement survey free-text + manager/peer review notes).
- **Culture Amp–inspired drivers:** Leadership, Belonging, Growth, Workload, Recognition, Enablement, Alignment.
- **Fictional org:** Harbor Labs — ~16 demo people across Product, Engineering, People, Sales. No real employees.

## Jev / TypeSafe

Each feedback snippet is scored with TypeSafe System One (`POST https://api.typesafe.ai/v1/systemone`) using composite questions in one request:

| Question | Primitive | Meaning |
| --- | --- | --- |
| `theme` | Choice | Maps to a driver |
| `engagement_health` | Score | How positive for engagement |
| `flight_risk` | Score | Attrition / disengagement risk |
| `performance_signal` | Score | Strength vs concern |

Code combines normalized scores into a **Gauge 0–100** and a risk level. Without `TYPESAFE_API_KEY`, a deterministic heuristic keeps the stream alive.

## Run locally

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export TYPESAFE_API_KEY="$(cat ~/.config/typesafe/api_key)"  # optional
uvicorn app:app --reload --port 8765
```

Open http://127.0.0.1:8765

## Design

Light Apple / Linear / Tesla tokens from `DESIGN.md` (`#f5f5f7`, Action Blue `#0066cc`). Overview-only auto-streaming dashboard (no Live / Interventions tabs).

## License / demo data

All names and comments are invented for demonstration. Do not treat as real HR data.
