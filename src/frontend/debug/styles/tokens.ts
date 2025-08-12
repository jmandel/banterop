const style = document.createElement('style');
style.textContent = `
*, *::before, *::after { box-sizing: border-box; }
body { margin:0; font: 13px/1.4 ui-sans-serif, system-ui; color:#e6edf3; background:#0b0f14; }

/* Layout */
.layout { display:grid; grid-template-columns: 220px 1fr; min-height:100vh; }
.nav { background:#121821; padding:12px; display:flex; flex-direction:column; gap:8px; }
.nav a { color:#e6edf3; text-decoration:none; padding:6px 8px; border-radius:6px; }
.nav a:hover { background:#1b2330; }
main { padding:16px; }

/* Components */
.card, .panel { background:#121821; padding:12px; border-radius:8px; }
.card { display:block; margin:0 0 12px; }
.panel + .panel { margin-top:8px; }
.muted { color:#99a3ad; }

/* Controls */
button, input, select { height:32px; font: inherit; color:#e6edf3; line-height:1; vertical-align: middle; }
button {
  display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:0 10px; border-radius:6px; background:#1b2330; border:1px solid #2a3a55;
  cursor:pointer; white-space:nowrap; flex:0 0 auto;
}
button:hover { background:#22304a; }
input, select {
  padding:6px 8px; border-radius:6px; background:#0e141d; border:1px solid #22304a;
}
select { appearance: none; background-image: none; }
button:focus, input:focus, select:focus, textarea:focus { outline: none; border-color:#3a68ff; box-shadow: 0 0 0 2px rgba(58,104,255,0.2); }
textarea { width:100%; padding:10px; border-radius:8px; background:#0e141d; border:1px solid #22304a; color:#e6edf3; resize:vertical; }

/* Tables */
.grid { width:100%; border-collapse: collapse; }
.grid th, .grid td { border-bottom: 1px solid #22304a; padding:8px; text-align:left; }
.table-wrap { overflow:auto; max-height:60vh; border:1px solid #1a2232; border-radius:8px; }

/* Timeline */
.row { display:grid; grid-template-columns: 64px 80px 1fr 240px auto; gap:8px; padding:4px 0; border-bottom:1px solid #1a2232; }
.addr { color:#99a3ad; }
.chip { background:#2b3342; padding:2px 6px; border-radius:10px; margin-right:6px; }
.fin-turn { background:#0e5f46; } .fin-conversation { background:#6b1e2b; }
.diag li { list-style:none; margin:4px 0; } .diag .warn { color:#ffb020 } .diag .error { color:#ff5d5d }
.timeline { background:#0e141d; border:1px solid #1a2232; border-radius:8px; padding:8px; }
.toolbar { display:flex; gap:8px; align-items:center; margin:8px 0; }
.toolbar > input { flex:1 1 auto; }
.toolbar > select, .toolbar > button { flex:0 0 auto; }
.error { color:#ff5d5d; margin:8px 0; }

/* SQL page helpers */
.cols-2 { display:grid; grid-template-columns: 1fr 1fr; gap:12px; align-items:start; }
.params-grid { display:grid; grid-template-columns: 140px 1fr; gap:8px; }
`;
document.head.appendChild(style);
