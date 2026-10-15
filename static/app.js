/* Onboarding Pulse — dense Overview · Live SSE · Interventions */
const CAT_LABELS = {
  access_tools: "Access / tools",
  role_clarity: "Role clarity",
  manager_support: "Manager",
  social_isolation: "Isolation",
  workload: "Workload",
  admin_payroll: "Admin / pay",
  none: "None",
};
const CAT_ORDER = Object.keys(CAT_LABELS);
const CATEGORY_ACTIONS = {
  access_tools: [
    { title: "Unblock GitHub / SSO within 24h", detail: "Confirm accounts, repos, VPN.", owner: "IT / Ops" },
    { title: "Access audit with hire", detail: "Walk the tool checklist together.", owner: "Manager" },
  ],
  role_clarity: [
    { title: "Clarify 30-60-90 expectations", detail: "Write outcomes and ownership.", owner: "Manager" },
    { title: "Share role charter", detail: "Decision rights and stakeholders.", owner: "Manager" },
  ],
  manager_support: [
    { title: "Protected weekly 1:1", detail: "30 minutes on blockers this week.", owner: "Manager" },
    { title: "Skip-level pulse", detail: "People Ops light check-in.", owner: "People Ops" },
  ],
  social_isolation: [
    { title: "Schedule buddy coffee", detail: "Buddy + two peer intros.", owner: "Manager" },
    { title: "Add to team rituals", detail: "Standup, social, next hangout.", owner: "Manager" },
  ],
  workload: [
    { title: "Rebalance sprint load", detail: "Defer one non-critical item.", owner: "Manager" },
    { title: "Protect onboarding calendar", detail: "Block learning time two weeks.", owner: "Manager" },
  ],
  admin_payroll: [
    { title: "Escalate payroll / admin same day", detail: "Confirm owner and SLA.", owner: "People Ops" },
  ],
  none: [
    { title: "Keep a light check-in", detail: "No urgent friction.", owner: "Manager" },
  ],
};

let DATA = null;
let weekChart = null;
let currentView = "pulse";
let es = null;
let streamPaused = false;
let ivStatus = {};

function pct(x) {
  return (x * 100).toFixed(0) + "%";
}
function fmtCat(c) {
  return CAT_LABELS[c] || c;
}
function initials(name) {
  return (name || "?")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function blueCell(risk) {
  if (risk == null) return null;
  const t = Math.max(0, Math.min(1, risk / 0.55));
  const a = 0.08 + 0.72 * t;
  return `rgba(0, 102, 204, ${a.toFixed(3)})`;
}
function blueCellInk(risk) {
  if (risk == null) return "#aeaeb2";
  const t = Math.max(0, Math.min(1, risk / 0.55));
  return t > 0.45 ? "#ffffff" : "#1d1d1f";
}

function setConn(state) {
  const dot = document.getElementById("connDot");
  const label = document.getElementById("connLabel");
  const toggle = document.getElementById("streamToggle");
  label.textContent = state;
  dot.className = "dot muted";
  if (state === "Live") dot.className = "dot live";
  else if (state === "Connecting" || state === "Paused") dot.className = "dot warn";
  if (toggle) {
    if (state === "Done" || state === "Error" || state === "Idle") toggle.textContent = "Replay";
    else if (state === "Paused") toggle.textContent = "Resume";
    else toggle.textContent = "Pause";
  }
}

function stopStream() {
  if (es) {
    es.close();
    es = null;
  }
}

function startStream() {
  stopStream();
  const list = document.getElementById("feedList");
  const empty = document.getElementById("feedEmpty");
  list.innerHTML = "";
  empty.style.display = "block";
  empty.textContent = "Connecting…";
  setConn("Connecting");
  streamPaused = false;
  es = new EventSource("/api/stream");
  es.onopen = () => setConn("Live");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "signal") {
        empty.style.display = "none";
        const level =
          msg.risk >= 0.45 ? "critical" : msg.risk >= 0.28 ? "high" : msg.risk >= 0.18 ? "medium" : "low";
        const cat = msg.scores?.category;
        const li = document.createElement("li");
        li.dataset.id = msg.hire_id;
        li.innerHTML = `
          <div class="avatar">${escapeHtml(initials(msg.hire))}</div>
          <div style="min-width:0;flex:1">
            <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center">
              <strong style="font-size:13px">${escapeHtml(msg.hire)}</strong>
              <span class="feed-meta">${escapeHtml(msg.team)} · day ${msg.day} · ${escapeHtml(msg.channel)}</span>
              <span class="badge ${level}">${pct(msg.risk)}</span>
              ${cat ? `<span class="feed-meta">${escapeHtml(fmtCat(cat))}</span>` : ""}
              <span class="feed-idx">${msg.index}/${msg.total}</span>
            </div>
            <p class="feed-text">${escapeHtml(msg.text)}</p>
          </div>`;
        li.addEventListener("click", () => openHire(msg.hire_id));
        list.insertBefore(li, list.firstChild);
      } else if (msg.type === "snapshot" && msg.kpis) {
        renderKpis(msg.kpis);
      } else if (msg.type === "done") {
        setConn("Done");
        stopStream();
      }
    } catch (_) {}
  };
  es.onerror = () => {
    if (es) {
      setConn("Error");
      stopStream();
    }
  };
}

function setView(name) {
  if (currentView === "live" && name !== "live") stopStream();
  currentView = name;
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const labels = { pulse: "Overview", live: "Live", interventions: "Interventions" };
  document.getElementById("viewLabel").textContent = labels[name] || name;
  if (name === "live") startStream();
  if (name === "interventions") renderInterventions();
  if (name === "pulse" && DATA) renderKpis(DATA.aggregates.kpis);
}

function interventionsForHire(h) {
  const cat = h.top_category || "none";
  const base = (CATEGORY_ACTIONS[cat] || CATEGORY_ACTIONS.none).slice(0, 2);
  const items = base.map((a, i) => ({
    id: `${h.id}-${cat}-${i}`,
    hire: h,
    ...a,
  }));
  if (h.max_intent >= 0.35) {
    items.push({
      id: `${h.id}-leave`,
      hire: h,
      title: "Manager 1:1 this week (intent signal)",
      detail: "Ask about regret or blockers.",
      owner: "Manager",
    });
  } else if (h.max_blocked >= 0.4) {
    items.push({
      id: `${h.id}-blocked`,
      hire: h,
      title: "Unblock critical path within 24h",
      detail: "Treat as P1 until they can ship.",
      owner: "IT / Ops",
    });
  }
  return items.slice(0, 3);
}

function renderInterventions() {
  if (!DATA) return;
  const hires = DATA.aggregates.hires;
  const flagged = hires.filter((h) => h.risk_level === "critical" || h.risk_level === "high");
  const list = flagged.length
    ? flagged
    : [...hires].sort((a, b) => b.risk_score - a.risk_score).slice(0, 6);
  const root = document.getElementById("interventionsList");
  root.innerHTML = list
    .map((h) => {
      const items = interventionsForHire(h);
      const done = items.filter((i) => ivStatus[i.id] === "done").length;
      return `<section class="iv-card">
        <div class="iv-card-head">
          <div class="hire-cell">
            <div class="avatar">${escapeHtml(initials(h.name))}</div>
            <div class="hire-meta">
              <div class="hire-name">${escapeHtml(h.name)}</div>
              <div class="hire-role">${escapeHtml(h.team)} · ${escapeHtml(fmtCat(h.top_category))}</div>
            </div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge ${escapeHtml(h.risk_level)}">${escapeHtml(h.risk_level)}</span>
            <span class="feed-meta">${done}/${items.length}</span>
          </div>
        </div>
        ${items
          .map((iv) => {
            const isDone = ivStatus[iv.id] === "done";
            return `<div class="iv-item">
              <button type="button" class="iv-check ${isDone ? "done" : ""}" data-ivid="${escapeHtml(iv.id)}" aria-pressed="${isDone}">
                <svg width="12" height="12" viewBox="0 0 12 12"><path d="M2.5 6.2 4.8 8.5 9.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
              </button>
              <div>
                <div class="iv-title ${isDone ? "done" : ""}">${escapeHtml(iv.title)}</div>
                <div class="iv-detail">${escapeHtml(iv.detail)}</div>
                <span class="iv-owner">${escapeHtml(iv.owner)}</span>
              </div>
            </div>`;
          })
          .join("")}
      </section>`;
    })
    .join("");
  root.querySelectorAll(".iv-check").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.ivid;
      ivStatus[id] = ivStatus[id] === "done" ? "todo" : "done";
      renderInterventions();
    });
  });
}

async function load() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error("Failed to load dashboard");
  DATA = await res.json();
  const a = DATA.aggregates;
  renderKpis(a.kpis);
  renderHeatmap(a);
  renderChart(a.weekly_curve);
  renderRiskTable(a.hires);
}

function renderKpis(k) {
  const total = k.total_hires || (DATA && DATA.aggregates.kpis.total_hires) || "";
  document.getElementById("kpis").innerHTML = `
    <div class="kpi">
      <div class="kpi-label">At risk</div>
      <p class="kpi-value danger">${k.hires_at_risk}<span class="unit">/ ${total}</span></p>
      <div class="kpi-meta">${k.critical_count} critical · ${k.high_count} high</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Average risk</div>
      <p class="kpi-value">${pct(k.avg_risk)}</p>
      <div class="kpi-meta">Composite across cohort</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Top issue</div>
      <p class="kpi-value" style="font-size:18px;letter-spacing:-0.4px">${escapeHtml(fmtCat(k.top_issue))}</p>
      <div class="kpi-meta">Most common friction</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Signals scored</div>
      <p class="kpi-value">${k.signals_scored}</p>
      <div class="kpi-meta">Live + precomputed</div>
    </div>`;
}

function renderHeatmap(a) {
  const cats = a.categories || CAT_ORDER;
  let html = `<div class="hm"><div></div>${cats
    .map((c) => `<div class="hm-head">${escapeHtml(fmtCat(c))}</div>`)
    .join("")}`;
  for (const row of a.heatmap) {
    html += `<div class="hm-ylab">${escapeHtml(row.team)}<span>avg ${pct(row.team_avg_risk)}</span></div>`;
    for (const c of cats) {
      const cell = row[c];
      if (!cell || cell.count === 0) {
        html += `<div class="hm-cell empty"><strong>—</strong></div>`;
      } else {
        const bg = blueCell(cell.avg_risk);
        const ink = blueCellInk(cell.avg_risk);
        html += `<div class="hm-cell" style="background:${bg};color:${ink}"><strong>${pct(cell.avg_risk)}</strong></div>`;
      }
    }
  }
  html += `</div>`;
  const wrap = document.getElementById("heatmap");
  wrap.innerHTML = html;
  const hm = wrap.querySelector(".hm");
  if (hm) hm.style.gridTemplateColumns = `100px repeat(${cats.length}, minmax(48px, 1fr))`;
}

function renderChart(curve) {
  const ctx = document.getElementById("weekChart");
  if (weekChart) weekChart.destroy();
  weekChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: curve.map((c) => "W" + c.week),
      datasets: [
        {
          label: "Avg risk",
          data: curve.map((c) => c.avg_risk),
          borderColor: "#0066cc",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          fill: false,
          tension: 0.3,
          pointRadius: 2.5,
          pointBackgroundColor: "#0066cc",
          pointBorderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 0,
          max: Math.max(0.4, ...curve.map((c) => c.avg_risk)) * 1.1,
          ticks: {
            color: "#86868b",
            font: { size: 11 },
            callback: (v) => Math.round(v * 100) + "%",
            maxTicksLimit: 4,
          },
          grid: { color: "#e5e5ea", drawBorder: false },
          border: { display: false },
        },
        x: {
          ticks: { color: "#86868b", font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  });
}

function riskRows(hires) {
  const atRisk = hires.filter((h) => h.risk_level === "critical" || h.risk_level === "high");
  return atRisk.length ? atRisk : hires.slice(0, 8);
}

function renderRiskTable(hires) {
  const rows = riskRows(hires);
  const tbody = document.querySelector("#riskTable tbody");
  tbody.innerHTML = rows
    .map((h) => {
      const ev = h.evidence && h.evidence[0];
      const quote = ev ? escapeHtml(ev.text) : "—";
      return `<tr data-id="${escapeHtml(h.id)}">
      <td><div class="hire-cell">
        <div class="avatar">${escapeHtml(initials(h.name))}</div>
        <div class="hire-meta">
          <div class="hire-name">${escapeHtml(h.name)}</div>
          <div class="hire-role">${escapeHtml(h.role)}</div>
        </div>
      </div></td>
      <td class="team-cell">${escapeHtml(h.team)}</td>
      <td class="day-cell">${h.tenure_days}</td>
      <td><span class="badge ${escapeHtml(h.risk_level)}">${escapeHtml(h.risk_level)} ${pct(h.risk_score)}</span></td>
      <td class="quote-cell" title="${quote}">${quote}</td>
    </tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openHire(tr.dataset.id))
  );
}

async function openHire(id) {
  const h = await (await fetch("/api/hire/" + id)).json();
  document.getElementById("drawerTitle").textContent = h.name;
  document.getElementById("drawerSub").textContent =
    `${h.role} · ${h.team} · day ${h.tenure_days}`;
  const body = document.getElementById("drawerBody");
  body.innerHTML = `
    <div class="drawer-badges">
      <span class="badge ${escapeHtml(h.risk_level)}">${escapeHtml(h.risk_level)} ${pct(h.risk_score)}</span>
      <span class="badge ${escapeHtml(h.trend)}">${escapeHtml(h.trend)}</span>
      <span class="badge neutral">${escapeHtml(fmtCat(h.top_category))}</span>
    </div>
    <div class="section-label">Signals</div>
    ${h.signals
      .map((s) => {
        const level =
          s.risk >= 0.45 ? "critical" : s.risk >= 0.28 ? "high" : s.risk >= 0.18 ? "medium" : "low";
        return `<div class="signal-card">
        <div class="sig-top">
          <span class="sig-day">Day ${s.day} · ${escapeHtml(s.channel)}</span>
          <span class="badge ${level}">${pct(s.risk)}</span>
        </div>
        <div class="sig-text">${escapeHtml(s.text)}</div>
      </div>`;
      })
      .join("")}`;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawerBackdrop").classList.add("open");
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawerBackdrop").classList.remove("open");
}

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});
document.getElementById("drawerClose").addEventListener("click", closeDrawer);
document.getElementById("drawerBackdrop").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDrawer();
});

document.getElementById("streamToggle").addEventListener("click", () => {
  const label = document.getElementById("connLabel").textContent;
  if (label === "Done" || label === "Error" || label === "Idle") {
    startStream();
    return;
  }
  if (!streamPaused) {
    streamPaused = true;
    stopStream();
    setConn("Paused");
  } else {
    startStream();
  }
});

document.getElementById("liveForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("liveBtn");
  const out = document.getElementById("liveResult");
  btn.disabled = true;
  btn.textContent = "Scoring…";
  out.innerHTML = "";
  try {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: document.getElementById("liveText").value,
        channel: document.getElementById("liveChannel").value,
        day: Number(document.getElementById("liveDay").value) || 30,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    const r = await res.json();
    out.innerHTML = `
      <div class="result-cat">${escapeHtml(fmtCat(r.category))}
        <span style="color:var(--ink-tertiary);font-weight:400;font-size:12px"> · conf ${pct(r.category_confidence)}</span>
      </div>
      <div class="meter"><span style="width:${Math.min(100, r.risk * 100)}%"></span></div>
      <div class="live-stats">
        Risk <strong style="color:var(--ink)">${pct(r.risk)}</strong><br>
        leave ${pct(r.intent_to_leave)} · blocked ${pct(r.blocked_from_work)}
      </div>`;
  } catch (err) {
    out.innerHTML = `<div class="live-error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Score with Jev";
  }
});

load().catch((err) => {
  document.getElementById("kpis").textContent = "Failed to load: " + err;
});
