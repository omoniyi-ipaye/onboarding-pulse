/* Onboarding Pulse — dashboard client */
const CAT_LABELS = {
  access_tools: "Access / tools",
  role_clarity: "Role clarity",
  manager_support: "Manager",
  social_isolation: "Isolation",
  workload: "Workload",
  admin_payroll: "Admin / pay",
  none: "None",
};
const CAT_ORDER = [
  "access_tools",
  "role_clarity",
  "manager_support",
  "social_isolation",
  "workload",
  "admin_payroll",
  "none",
];

let DATA = null;
let weekChart = null;
let currentView = "pulse";

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

/** Monochrome charcoal → lavender intensity for heatmap cells */
function lavenderCell(risk) {
  if (risk == null) return null;
  const t = Math.max(0, Math.min(1, risk / 0.55));
  // Blend surface-2 (#141516) → primary (#5e6ad2)
  const r = Math.round(20 + (94 - 20) * t);
  const g = Math.round(21 + (106 - 21) * t);
  const b = Math.round(22 + (210 - 22) * t);
  const a = 0.35 + 0.55 * t;
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

function setView(name) {
  currentView = name;
  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === name);
  });
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  const labels = { pulse: "Overview", hires: "Hires", signals: "Signals" };
  document.getElementById("viewLabel").textContent = labels[name] || name;
}

async function load() {
  const res = await fetch("/api/dashboard");
  if (!res.ok) throw new Error("Failed to load dashboard");
  DATA = await res.json();
  const m = DATA.meta;
  const a = DATA.aggregates;
  const k = a.kpis;
  document.getElementById("metaLine").textContent =
    `As of ${m.as_of} · ${k.signals_scored} signals · ${m.usage.input_tokens.toLocaleString()} tokens · $${m.usage.cost_usd.toFixed(5)} · ${m.model}`;
  renderKpis(k);
  renderHeatmap(a);
  renderChart(a.weekly_curve);
  renderRiskTable(a.hires);
  renderHiresView(a.hires);
  renderSignalsView(a.hires);
}

function renderKpis(k) {
  document.getElementById("kpis").innerHTML = `
    <div class="kpi">
      <div class="kpi-label">At risk</div>
      <p class="kpi-value danger">${k.hires_at_risk}<span class="unit">/ ${k.total_hires}</span></p>
      <div class="kpi-meta">${k.critical_count} critical · ${k.high_count} high</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Average risk</div>
      <p class="kpi-value">${pct(k.avg_risk)}</p>
      <div class="kpi-meta">Composite across cohort</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Top issue</div>
      <p class="kpi-value" style="font-size:20px;letter-spacing:-0.4px">${escapeHtml(fmtCat(k.top_issue))}</p>
      <div class="kpi-meta">Most common non-positive category</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Signals scored</div>
      <p class="kpi-value">${k.signals_scored}</p>
      <div class="kpi-meta">5 questions batched per request</div>
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
        const bg = lavenderCell(cell.avg_risk);
        html += `<div class="hm-cell" style="background:${bg}"><strong>${pct(cell.avg_risk)}</strong><em>${cell.count}</em></div>`;
      }
    }
  }
  html += `</div>`;
  document.getElementById("heatmap").innerHTML = html;
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
          borderColor: "#5e6ad2",
          backgroundColor: "transparent",
          borderWidth: 1.5,
          fill: false,
          tension: 0.3,
          pointRadius: 2.5,
          pointHoverRadius: 4,
          pointBackgroundColor: "#5e6ad2",
          pointBorderColor: "#5e6ad2",
          pointBorderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#141516",
          titleColor: "#f7f8f8",
          bodyColor: "#d0d6e0",
          borderColor: "#23252a",
          borderWidth: 1,
          padding: 10,
          displayColors: false,
          callbacks: {
            label: (ctx) =>
              `Risk ${pct(ctx.parsed.y)} · n=${curve[ctx.dataIndex].n}`,
          },
        },
      },
      scales: {
        y: {
          min: 0,
          max: 1,
          ticks: {
            color: "#62666d",
            font: { size: 11 },
            callback: (v) => v * 100 + "%",
            maxTicksLimit: 5,
          },
          grid: { color: "#23252a", drawBorder: false },
          border: { display: false },
        },
        x: {
          ticks: { color: "#62666d", font: { size: 11 } },
          grid: { display: false },
          border: { display: false },
        },
      },
    },
  });
}

function riskRows(hires) {
  const atRisk = hires.filter(
    (h) => h.risk_level === "critical" || h.risk_level === "high"
  );
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
      <td><span class="badge ${escapeHtml(h.trend)}">${escapeHtml(h.trend)}</span></td>
      <td class="quote-cell" title="${quote}">${quote}</td>
    </tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openHire(tr.dataset.id))
  );
}

function renderHiresView(hires) {
  const sorted = [...hires].sort((a, b) => b.risk_score - a.risk_score);
  document.getElementById("hiresCount").textContent = `${sorted.length} hires`;
  const tbody = document.querySelector("#hiresTable tbody");
  tbody.innerHTML = sorted
    .map(
      (h) => `<tr data-id="${escapeHtml(h.id)}">
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
      <td><span class="badge ${escapeHtml(h.trend)}">${escapeHtml(h.trend)}</span></td>
      <td class="team-cell">${escapeHtml(fmtCat(h.top_category))}</td>
      <td class="day-cell">${h.signal_count}</td>
    </tr>`
    )
    .join("");
  tbody.querySelectorAll("tr").forEach((tr) =>
    tr.addEventListener("click", () => openHire(tr.dataset.id))
  );
}

function renderSignalsView(hires) {
  const signals = [];
  for (const h of hires) {
    for (const s of h.signals || []) {
      signals.push({ ...s, hire_id: h.id, hire_name: h.name, team: h.team });
    }
  }
  signals.sort((a, b) => b.risk - a.risk);
  const top = signals.slice(0, 40);
  document.getElementById("signalsCount").textContent = `${signals.length} signals · showing ${top.length}`;
  const tbody = document.querySelector("#signalsTable tbody");
  tbody.innerHTML = top
    .map((s) => {
      const level =
        s.risk >= 0.45 ? "critical" : s.risk >= 0.28 ? "high" : s.risk >= 0.18 ? "medium" : "low";
      return `<tr data-id="${escapeHtml(s.hire_id)}">
      <td><div class="hire-cell">
        <div class="avatar">${escapeHtml(initials(s.hire_name))}</div>
        <div class="hire-meta">
          <div class="hire-name">${escapeHtml(s.hire_name)}</div>
          <div class="hire-role">${escapeHtml(s.team)} · ${escapeHtml(s.channel)}</div>
        </div>
      </div></td>
      <td class="day-cell">${s.day}</td>
      <td><span class="badge ${level}">${pct(s.risk)}</span></td>
      <td class="team-cell">${escapeHtml(fmtCat(s.category))}</td>
      <td class="quote-cell" title="${escapeHtml(s.text)}">${escapeHtml(s.text)}</td>
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
    `${h.role} · ${h.team} · ${h.location} · Manager ${h.manager} · day ${h.tenure_days}`;
  const body = document.getElementById("drawerBody");
  body.innerHTML = `
    <div class="drawer-badges">
      <span class="badge ${escapeHtml(h.risk_level)}">${escapeHtml(h.risk_level)} ${pct(h.risk_score)}</span>
      <span class="badge ${escapeHtml(h.trend)}">${escapeHtml(h.trend)}</span>
      <span class="badge neutral">${escapeHtml(fmtCat(h.top_category))}</span>
    </div>
    <div class="stat-row">
      <div class="stat-tile"><div class="l">Leave intent (max)</div><div class="v">${pct(h.max_intent)}</div></div>
      <div class="stat-tile"><div class="l">Blocked (max)</div><div class="v">${pct(h.max_blocked)}</div></div>
      <div class="stat-tile"><div class="l">Frustration avg</div><div class="v">${h.avg_frustration.toFixed(2)} / 3</div></div>
      <div class="stat-tile"><div class="l">Confusion avg</div><div class="v">${h.avg_confusion.toFixed(2)} / 3</div></div>
    </div>
    <div class="section-label">Signals</div>
    ${h.signals
      .map((s) => {
        const level =
          s.risk >= 0.45
            ? "critical"
            : s.risk >= 0.28
              ? "high"
              : s.risk >= 0.18
                ? "medium"
                : "low";
        return `<div class="signal-card">
        <div class="sig-top">
          <span class="sig-day">Day ${s.day}</span>
          <span class="badge ${level}">${pct(s.risk)}</span>
        </div>
        <div class="sig-meta">${escapeHtml(s.channel)} · ${escapeHtml(fmtCat(s.category))}</div>
        <div class="sig-text">${escapeHtml(s.text)}</div>
        <div class="sig-meta">frustration ${s.frustration.toFixed(2)} · confusion ${s.confusion.toFixed(2)} · leave ${pct(s.intent_to_leave)} · blocked ${pct(s.blocked_from_work)}</div>
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
        frustration ${r.frustration.toFixed(2)} · confusion ${r.confusion.toFixed(2)}<br>
        leave ${pct(r.intent_to_leave)} · blocked ${pct(r.blocked_from_work)}<br>
        <span style="color:var(--ink-tertiary)">${r.usage?.input_tokens || "?"} tokens · ${escapeHtml(r.model || "")}</span>
      </div>`;
  } catch (err) {
    out.innerHTML = `<div class="live-error">${escapeHtml(err.message)}</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Score with Jev";
  }
});

load().catch((err) => {
  document.getElementById("metaLine").textContent = "Failed to load: " + err;
});
