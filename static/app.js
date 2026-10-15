/* Onboarding Pulse — single Overview dashboard with live SSE */
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

let DATA = null;
let LIVE = null; // mutable working copy during stream
let weekChart = null;
let es = null;
let streamPaused = false;
let streamed = 0;
let streamTotal = 0;
let baseline = null;

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

function levelFromRisk(score, th) {
  if (score >= th.critical) return "critical";
  if (score >= th.high) return "high";
  if (score >= th.medium) return "medium";
  return "low";
}

function cloneDeep(x) {
  return JSON.parse(JSON.stringify(x));
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

function softReset() {
  const th = DATA.meta.risk_thresholds;
  LIVE = cloneDeep(DATA.aggregates);
  LIVE.hires = LIVE.hires.map((h) => ({
    ...h,
    risk_score: Math.min(0.08, h.risk_score * 0.2),
    risk_level: "low",
    evidence: [],
    signals: [],
    category_counts: {},
    signal_count: 0,
    max_intent: 0,
    max_blocked: 0,
  }));
  LIVE.kpis = {
    total_hires: LIVE.hires.length,
    hires_at_risk: 0,
    avg_risk: 0.04,
    top_issue: "none",
    critical_count: 0,
    high_count: 0,
    signals_scored: 0,
  };
  const teams = LIVE.teams || [...new Set(LIVE.hires.map((h) => h.team))];
  const cats = LIVE.categories || CAT_ORDER;
  LIVE.heatmap = teams.map((team) => {
    const row = { team, team_avg_risk: 0, hires_at_risk: 0 };
    for (const c of cats) row[c] = { count: 0, avg_risk: null };
    return row;
  });
  LIVE.weekly_curve = Array.from({ length: 13 }, (_, i) => ({
    week: i + 1,
    avg_risk: 0.02,
    n: 0,
  }));
  streamed = 0;
  renderAll(LIVE, { liveMeta: true });
}

function recomputeFromHires(hires, signalsScored) {
  const th = DATA.meta.risk_thresholds;
  const teams = DATA.aggregates.teams || [...new Set(hires.map((h) => h.team))];
  const cats = DATA.aggregates.categories || CAT_ORDER;
  let atRisk = 0,
    critical = 0,
    high = 0,
    sum = 0;
  const catCount = new Map();
  for (const h of hires) {
    sum += h.risk_score;
    if (h.risk_level === "critical") {
      atRisk++;
      critical++;
    } else if (h.risk_level === "high") {
      atRisk++;
      high++;
    }
    for (const [c, n] of Object.entries(h.category_counts || {})) {
      catCount.set(c, (catCount.get(c) || 0) + n);
    }
  }
  let top = "none",
    topN = -1;
  for (const [c, n] of catCount) {
    if (c === "none") continue;
    if (n > topN) {
      topN = n;
      top = c;
    }
  }
  const kpis = {
    total_hires: hires.length,
    hires_at_risk: atRisk,
    avg_risk: hires.length ? Math.round((sum / hires.length) * 10000) / 10000 : 0,
    top_issue: top,
    critical_count: critical,
    high_count: high,
    signals_scored: signalsScored,
  };
  const byTeam = new Map();
  for (const t of teams) byTeam.set(t, []);
  for (const h of hires) {
    const list = byTeam.get(h.team) || [];
    list.push(h);
    byTeam.set(h.team, list);
  }
  const heatmap = teams.map((team) => {
    const list = byTeam.get(team) || [];
    const row = {
      team,
      team_avg_risk: list.length
        ? list.reduce((s, h) => s + h.risk_score, 0) / list.length
        : 0,
      hires_at_risk: list.filter(
        (h) => h.risk_level === "critical" || h.risk_level === "high"
      ).length,
    };
    for (const c of cats) {
      let count = 0,
        riskSum = 0,
        riskN = 0;
      for (const h of list) {
        count += h.category_counts?.[c] || 0;
        for (const e of h.evidence || []) {
          if (e.category === c) {
            riskSum += e.risk;
            riskN++;
          }
        }
      }
      row[c] = { count, avg_risk: riskN ? riskSum / riskN : null };
    }
    return row;
  });
  const buckets = new Map();
  for (const h of hires) {
    for (const s of h.signals || []) {
      const week = Math.max(1, Math.ceil((s.day || 1) / 7));
      const b = buckets.get(week) || { sum: 0, n: 0 };
      b.sum += s.risk;
      b.n++;
      buckets.set(week, b);
    }
  }
  const weeks = [...buckets.keys()].sort((a, b) => a - b);
  const weekly_curve = weeks.length
    ? weeks.map((week) => {
        const b = buckets.get(week);
        return { week, avg_risk: b.sum / b.n, n: b.n };
      })
    : Array.from({ length: 13 }, (_, i) => ({ week: i + 1, avg_risk: 0.02, n: 0 }));
  return {
    ...LIVE,
    hires,
    kpis,
    heatmap,
    weekly_curve,
    teams,
    categories: cats,
  };
}

function applySignal(msg) {
  if (!LIVE) return;
  const th = DATA.meta.risk_thresholds;
  const hires = LIVE.hires;
  const idx = hires.findIndex((h) => h.id === msg.hire_id);
  if (idx < 0) return;
  const h = { ...hires[idx] };
  const category = msg.scores?.category || "none";
  const evidence = {
    signal_id: msg.id,
    day: msg.day,
    channel: msg.channel,
    text: msg.text,
    category,
    frustration: msg.scores?.frustration ?? 0,
    confusion: msg.scores?.confusion ?? 0,
    intent_to_leave: msg.scores?.intent_to_leave ?? 0,
    blocked_from_work: msg.scores?.blocked_from_work ?? 0,
    risk: msg.risk,
  };
  const already = (h.signals || []).some((s) => s.signal_id === msg.id);
  h.category_counts = { ...(h.category_counts || {}) };
  if (!already) {
    h.signal_count = (h.signal_count || 0) + 1;
    h.category_counts[category] = (h.category_counts[category] || 0) + 1;
  }
  h.risk_score = Math.max(h.risk_score, msg.risk);
  h.risk_level = levelFromRisk(h.risk_score, th);
  if (category !== "none") h.top_category = category;
  h.evidence = [evidence, ...(h.evidence || []).filter((e) => e.signal_id !== msg.id)].slice(0, 8);
  h.signals = [
    { ...evidence, hire_id: h.id },
    ...(h.signals || []).filter((s) => s.signal_id !== msg.id),
  ].slice(0, 20);
  h.max_intent = Math.max(h.max_intent || 0, msg.scores?.intent_to_leave ?? 0);
  h.max_blocked = Math.max(h.max_blocked || 0, msg.scores?.blocked_from_work ?? 0);
  hires[idx] = h;
  streamed += 1;
  LIVE = recomputeFromHires(hires, streamed);
  renderAll(LIVE, { liveMeta: true, flashId: msg.hire_id });
}

function restoreBaseline() {
  if (!baseline) return;
  LIVE = cloneDeep(baseline);
  streamed = 0;
  renderAll(LIVE, { liveMeta: false });
}

function startStream() {
  if (!DATA) return;
  stopStream();
  softReset();
  setConn("Connecting");
  streamPaused = false;
  es = new EventSource("/api/stream");
  es.onopen = () => setConn("Live");
  es.onmessage = (ev) => {
    if (streamPaused) return;
    try {
      const msg = JSON.parse(ev.data);
      if (msg.type === "meta") {
        streamTotal = msg.total || 0;
      } else if (msg.type === "signal") {
        applySignal(msg);
      } else if (msg.type === "done") {
        setConn("Done");
        stopStream();
        setTimeout(restoreBaseline, 900);
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

function renderAll(a, opts = {}) {
  renderKpis(a.kpis, opts);
  renderHeatmap(a);
  renderChart(a.weekly_curve);
  renderRiskTable(a.hires, opts.flashId);
}

async function load() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error("Failed to load dashboard");
  DATA = await res.json();
  baseline = cloneDeep(DATA.aggregates);
  LIVE = cloneDeep(DATA.aggregates);
  renderAll(LIVE);
  startStream();
}

function renderKpis(k, opts = {}) {
  const total = k.total_hires || (DATA && DATA.aggregates.kpis.total_hires) || "";
  const meta =
    opts.liveMeta && (document.getElementById("connLabel").textContent === "Live" ||
      document.getElementById("connLabel").textContent === "Connecting")
      ? `Live pass ${streamed}${streamTotal ? "/" + streamTotal : ""}`
      : "Live + precomputed";
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
      <div class="kpi-meta">${escapeHtml(meta)}</div>
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
          max: Math.max(0.4, ...curve.map((c) => c.avg_risk), 0.01) * 1.1,
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
  const atRisk = hires
    .filter((h) => h.risk_level === "critical" || h.risk_level === "high")
    .sort((a, b) => b.risk_score - a.risk_score);
  return atRisk.length ? atRisk : [...hires].sort((a, b) => b.risk_score - a.risk_score).slice(0, 8);
}

function renderRiskTable(hires, flashId) {
  const rows = riskRows(hires);
  const tbody = document.querySelector("#riskTable tbody");
  tbody.innerHTML = rows
    .map((h) => {
      const ev = h.evidence && h.evidence[0];
      const quote = ev ? escapeHtml(ev.text) : "—";
      const flash = flashId === h.id ? ' style="background:#e8f1fb"' : "";
      return `<tr data-id="${escapeHtml(h.id)}"${flash}>
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
  const local = (LIVE || DATA.aggregates).hires.find((h) => h.id === id);
  let h = local;
  try {
    h = await (await fetch("/api/hire/" + id)).json();
    if (local && local.evidence?.length) {
      h = { ...h, evidence: local.evidence, signals: local.signals?.length ? local.signals : h.signals, risk_score: Math.max(h.risk_score, local.risk_score), risk_level: local.risk_level };
    }
  } catch (_) {}
  if (!h) return;
  document.getElementById("drawerTitle").textContent = h.name;
  document.getElementById("drawerSub").textContent =
    `${h.role} · ${h.team} · day ${h.tenure_days}`;
  const body = document.getElementById("drawerBody");
  const signals = h.signals?.length ? h.signals : h.evidence || [];
  body.innerHTML = `
    <div class="drawer-badges">
      <span class="badge ${escapeHtml(h.risk_level)}">${escapeHtml(h.risk_level)} ${pct(h.risk_score)}</span>
      <span class="badge ${escapeHtml(h.trend || "stable")}">${escapeHtml(h.trend || "stable")}</span>
      <span class="badge neutral">${escapeHtml(fmtCat(h.top_category))}</span>
    </div>
    <div class="section-label">Signals</div>
    ${signals
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
