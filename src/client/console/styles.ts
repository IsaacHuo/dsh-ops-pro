/** Console chrome, host theme tokens only (see ../styles.ts for the rule). */
export const CONSOLE_CSS = `
.ops-console { box-sizing:border-box; display:flex; flex-direction:column; gap:14px; height:100%; min-width:0; overflow:auto; padding:20px 24px 32px; color:var(--dsw-alias-label-primary); font-size:13px; }
.ops-console-head { display:flex; align-items:center; gap:10px; min-width:0; }
.ops-console-title { margin:0; font-size:16px; font-weight:600; line-height:24px; }
.ops-console-meta { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.ops-console-refresh { margin-left:auto; }
.ops-console-tabs { display:flex; gap:4px; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.ops-console-tab { appearance:none; border:0; border-bottom:2px solid transparent; background:none; padding:6px 10px; margin-bottom:-.5px; font:inherit; font-size:13px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.ops-console-tab:hover { color:var(--dsw-alias-label-primary); }
.ops-console-tab[aria-selected=true] { color:var(--dsw-alias-label-primary); border-bottom-color:var(--dsw-alias-label-primary); font-weight:500; }
.ops-console-tab:focus-visible, .ops-console-segment-item:focus-visible { outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; border-radius:var(--dsw-radius-sm); }
.ops-console-panel { display:flex; flex-direction:column; gap:12px; min-width:0; }
.ops-console-stack { display:flex; flex-direction:column; gap:12px; min-width:0; }
.ops-console-row { display:flex; align-items:flex-start; gap:12px; flex-wrap:wrap; }
.ops-console-grow { flex:1 1 200px; }
.ops-console-detail { display:block; margin-top:2px; font-size:12px; color:var(--dsw-alias-label-tertiary); overflow-wrap:anywhere; }
.ops-console-dot { display:inline-block; width:7px; height:7px; margin-right:6px; border-radius:50%; vertical-align:1px; }
.ops-console-dot-ok { background:var(--dsw-alias-state-success-primary); }
.ops-console-dot-bad { background:var(--dsw-alias-label-tertiary); }
.ops-console-segment { display:inline-flex; padding:2px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-interactive-bg-hover); }
.ops-console-segment-item { appearance:none; border:0; background:none; padding:3px 10px; border-radius:var(--dsw-radius-sm); font:inherit; font-size:12px; color:var(--dsw-alias-label-secondary); cursor:pointer; }
.ops-console-segment-item[aria-pressed=true] { background:var(--dsw-alias-bg-layer-3); color:var(--dsw-alias-label-primary); }
.ops-console-metrics { display:grid; grid-template-columns:repeat(auto-fit,minmax(110px,1fr)); gap:8px; }
.ops-console-metric { display:flex; flex-direction:column; gap:2px; padding:12px; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); }
.ops-console-metric-value { font-size:20px; font-weight:600; line-height:28px; font-variant-numeric:tabular-nums; }
.ops-console-metric-label { font-size:12px; color:var(--dsw-alias-label-tertiary); }
.ops-console-chart { margin:0; display:flex; flex-direction:column; gap:6px; }
.ops-console-bars { display:flex; align-items:flex-end; gap:3px; height:64px; padding:8px; border-radius:var(--dsw-radius-md); background:var(--dsw-alias-interactive-bg-hover); }
.ops-console-bar { flex:1 1 0; height:100%; display:flex; align-items:flex-end; }
.ops-console-bar > span { display:block; width:100%; min-height:1px; border-radius:2px 2px 0 0; background:var(--dsw-alias-label-secondary); }
.ops-console-table-wrap { overflow-x:auto; border:.5px solid var(--dsw-alias-border-l2); border-radius:var(--dsw-radius-lg); }
.ops-console-table { width:100%; border-collapse:collapse; font-size:12px; font-variant-numeric:tabular-nums; }
.ops-console-table th, .ops-console-table td { padding:6px 10px; text-align:right; white-space:nowrap; border-bottom:.5px solid var(--dsw-alias-border-l2); }
.ops-console-table thead th { color:var(--dsw-alias-label-tertiary); font-weight:500; }
.ops-console-table th[scope=row], .ops-console-table thead th:first-child { text-align:left; }
.ops-console-table tbody tr:last-child > * { border-bottom:0; }
.ops-console-sticky { position:sticky; bottom:0; padding:8px 0; background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-3)); }
.ops-console code { font-size:12px; overflow-wrap:anywhere; }
.ops-console select.ops-input { padding-right:28px; }
`
