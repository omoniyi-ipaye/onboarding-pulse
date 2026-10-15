/* Feedback Gauge — Overview-only SSE dashboard */
const DRIVERS = ["leadership","belonging","growth","workload","recognition","enablement","alignment"];
const LABELS = {
  leadership:"Leadership", belonging:"Belonging", growth:"Growth", workload:"Workload",
  recognition:"Recognition", enablement:"Enablement", alignment:"Alignment"
};
const dash = window.__DASHBOARD__;
let es = null, paused = false, streamed = 0;

function pct(x){ return Math.round((x||0)*100)+"%"; }
function renderKpis(k){
  const el = document.getElementById("kpis");
  el.innerHTML = [
    ["Org gauge", k.org_gauge+"/100"],
    ["At risk", k.people_at_risk+" / "+k.total_people],
    ["Top driver", LABELS[k.top_driver]||k.top_driver],
    ["Feedback scored", k.signals_scored],
  ].map(([l,v])=>`<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
}
function renderHeat(rows){
  const el = document.getElementById("heatmap");
  let html = `<div class="hm" style="grid-template-columns:90px repeat(${DRIVERS.length},1fr)"><div></div>`;
  html += DRIVERS.map(d=>`<div class="h">${LABELS[d]}</div>`).join("");
  for (const row of rows){
    html += `<div class="t">${row.team}<small>${row.team_gauge??""}</small></div>`;
    for (const d of DRIVERS){
      const c = row[d];
      if (!c || !c.count){ html += `<div class="c empty">—</div>`; continue; }
      const t = Math.max(0, Math.min(1, (c.avg_risk||0)/0.55));
      const a = (0.08+0.72*t).toFixed(3);
      const color = t>0.45?"#fff":"#1d1d1f";
      html += `<div class="c" style="background:rgba(0,102,204,${a});color:${color}">${pct(c.avg_risk)}</div>`;
    }
  }
  html += "</div>";
  el.innerHTML = html;
}
function renderTable(people){
  const flagged = people.filter(p=>p.risk_level==="critical"||p.risk_level==="high")
    .sort((a,b)=>b.risk_score-a.risk_score);
  const rows = flagged.length?flagged:people.slice().sort((a,b)=>b.risk_score-a.risk_score).slice(0,8);
  const tb = document.querySelector("#table tbody");
  tb.innerHTML = rows.map(p=>{
    const ev = (p.evidence&&p.evidence[0]&&p.evidence[0].text)||"—";
    return `<tr><td>${p.name}<div class="muted">${p.role}</div></td><td>${p.team}</td><td>${p.gauge}</td><td>${p.risk_level} ${pct(p.risk_score)}</td><td class="clip">${ev}</td></tr>`;
  }).join("");
}
function renderCurve(curve){
  document.getElementById("curve").textContent = curve.map(c=>`C${c.period}  risk ${pct(c.avg_risk)}  gauge ${c.avg_gauge}  n=${c.n}`).join("\n");
}
function setConn(s){ document.getElementById("conn").textContent = s; }

function softReset(){
  const people = dash.aggregates.people.map(p=>({...p, risk_score:0.05, risk_level:"low", gauge:88, evidence:[], signals:[], theme_counts:{}, signal_count:0}));
  renderKpis({ total_people:people.length, people_at_risk:0, org_gauge:88, top_driver:"alignment", signals_scored:0, critical_count:0, high_count:0 });
  renderHeat(dash.aggregates.teams.map(team=>{
    const row = { team, team_gauge:88, team_avg_risk:0 };
    DRIVERS.forEach(d=> row[d]={count:0,avg_risk:null});
    return row;
  }));
  renderTable(people);
  renderCurve([1,2,3].map(period=>({period,avg_risk:0.03,avg_gauge:88,n:0})));
  window.__livePeople = people;
}

function applySignal(msg){
  const people = window.__livePeople || dash.aggregates.people.map(p=>({...p}));
  const p = people.find(x=>x.id===msg.person_id);
  if (!p) return;
  const theme = (msg.scores&&msg.scores.theme)||"alignment";
  const evidence = {
    signal_id: msg.id, period: msg.period, channel: msg.channel, text: msg.text,
    theme, engagement_health: msg.scores?.engagement_health??2,
    flight_risk: msg.scores?.flight_risk??0, performance_signal: msg.scores?.performance_signal??1,
    risk: msg.risk
  };
  p.risk_score = Math.max(p.risk_score, msg.risk);
  p.risk_level = p.risk_score>=0.45?"critical":p.risk_score>=0.28?"high":p.risk_score>=0.18?"medium":"low";
  p.gauge = msg.scores?.gauge ?? Math.round((1-p.risk_score)*100);
  p.theme_counts = p.theme_counts||{};
  p.theme_counts[theme]=(p.theme_counts[theme]||0)+1;
  p.evidence = [evidence, ...(p.evidence||[])].slice(0,5);
  p.signals = [{...evidence, person_id:p.id}, ...(p.signals||[])].slice(0,20);
  window.__livePeople = people;
  streamed++;
  const atRisk = people.filter(x=>x.risk_level==="critical"||x.risk_level==="high").length;
  const org = Math.round(people.reduce((s,x)=>s+x.gauge,0)/people.length);
  let top="alignment", topN=-1;
  const tc={};
  people.forEach(x=>Object.entries(x.theme_counts||{}).forEach(([k,n])=>tc[k]=(tc[k]||0)+n));
  Object.entries(tc).forEach(([k,n])=>{ if(n>topN){topN=n;top=k;} });
  renderKpis({ total_people:people.length, people_at_risk:atRisk, org_gauge:org, top_driver:top, signals_scored:streamed, critical_count:people.filter(x=>x.risk_level==="critical").length, high_count:people.filter(x=>x.risk_level==="high").length });
  // rebuild heatmap
  const teams = dash.aggregates.teams;
  renderHeat(teams.map(team=>{
    const list = people.filter(x=>x.team===team);
    const row = { team, team_gauge: list.length?Math.round(list.reduce((s,x)=>s+x.gauge,0)/list.length):88, team_avg_risk:0 };
    DRIVERS.forEach(d=>{
      let count=0, sum=0;
      list.forEach(x=>(x.signals||[]).forEach(s=>{ if(s.theme===d){count++;sum+=s.risk;} }));
      row[d]={ count, avg_risk: count?sum/count:null };
    });
    return row;
  }));
  renderTable(people);
  const buckets={};
  people.forEach(x=>(x.signals||[]).forEach(s=>{
    const b=buckets[s.period]||{r:0,g:0,n:0}; b.r+=s.risk; b.g+=(1-s.risk)*100; b.n++; buckets[s.period]=b;
  }));
  renderCurve(Object.keys(buckets).sort().map(period=>{
    const b=buckets[period]; return {period:+period, avg_risk:b.r/b.n, avg_gauge:Math.round(b.g/b.n), n:b.n};
  }));
}

function stop(){ if(es){ es.close(); es=null; } }
function start(){
  stop(); softReset(); streamed=0; paused=false; setConn("Connecting");
  es = new EventSource("/api/stream");
  es.onopen = ()=> setConn("Live");
  es.onmessage = (ev)=>{
    if (paused) return;
    const msg = JSON.parse(ev.data);
    if (msg.type==="signal") applySignal(msg);
    if (msg.type==="done"){ setConn("Done"); stop(); setTimeout(()=>{
      renderKpis(dash.aggregates.kpis);
      renderHeat(dash.aggregates.heatmap);
      renderTable(dash.aggregates.people);
      renderCurve(dash.aggregates.period_curve);
    }, 900); }
  };
  es.onerror = ()=>{ setConn("Error"); stop(); };
}

document.getElementById("pause").onclick = ()=>{
  if (!es){ start(); return; }
  paused = !paused;
  setConn(paused?"Paused":"Live");
  document.getElementById("pause").textContent = paused?"Resume":"Pause";
  if (paused) stop(); else start();
};
document.getElementById("replay").onclick = ()=> start();

renderKpis(dash.aggregates.kpis);
renderHeat(dash.aggregates.heatmap);
renderTable(dash.aggregates.people);
renderCurve(dash.aggregates.period_curve);
start();
