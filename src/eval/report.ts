// Renders ablation summaries (runs/<name>.summary.json) into one self-contained HTML page: a table and four charts per
// model. Emphasis form: cache arms in one accent colour, the control and its twin in neutral gray. Every mark has a hover
// tooltip, and the table is the accessible alternative to the charts.
export interface Spread { median: number; min: number; max: number }
export interface ArmAgg {
  hitRate: Spread; retrievalReuse?: Spread; modelCalls: Spread; refusals?: Spread; cacheReadShare?: Spread; cacheWriteShare?: Spread; ttftP50?: Spread; ttftP95?: Spread; wrongServed: Spread; f1: Spread; em: Spread;
  latencyP50: Spread; latencyP95: Spread; latencyP99: Spread; tokensIn: Spread; tokensOut: Spread; costUsd: Spread; disagreeWithControl: Spread;
}
export interface Summary {
  name: string; when: string; workloadName?: string; control: string; twin: string; reps: number; requests: number;
  workload: Record<string, number>; arms: string[]; costUsd: number;
  setup: { llm: { provider: string; model: string }; thresholds: { semantic: number; retrieval: number } };
  aggregate: Record<string, ArmAgg>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
export const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : ms >= 10 ? `${ms.toFixed(0)} ms` : `${ms.toFixed(1)} ms`);
const fmtPct = (x: number) => `${(x * 100).toFixed(0)}%`;
const fmtUsd = (x: number) => `$${x.toFixed(x < 0.1 ? 4 : 3)}`;
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

type Row = { label: string; s: Spread; role: "control" | "twin" | "arm" };
const roleOf = (arm: string, m: Summary): Row["role"] => (arm === m.control ? "control" : arm === m.twin ? "twin" : "arm");
const rows = (m: Summary, pick: (a: ArmAgg) => Spread): Row[] => m.arms.map((arm) => ({ label: arm === m.twin ? `${arm} (identical copy)` : arm === m.control ? `${arm} (control)` : arm, s: pick(m.aggregate[arm]!), role: roleOf(arm, m) }));

// Horizontal bars with a min-max whisker across repetitions.
export function barChart(title: string, data: Row[], fmt: (x: number) => string, reps: number): string {
  const W = 680, L = 190, R = 70, rowH = 30, top = 8, plotW = W - L - R;
  const max = Math.max(...data.map((d) => d.s.max), 1e-9) * 1.05;
  const H = top + data.length * rowH + 26;
  const ticks = [0, max / 2, max].map((t) => `<line class="grid" x1="${L + (t / max) * plotW}" x2="${L + (t / max) * plotW}" y1="${top}" y2="${H - 22}"/><text class="tick" x="${L + (t / max) * plotW}" y="${H - 6}" text-anchor="middle">${fmt(t)}</text>`).join("");
  const bars = data.map((d, i) => {
    const y = top + i * rowH, w = Math.max(1, (d.s.median / max) * plotW), lo = L + (d.s.min / max) * plotW, hi = L + (d.s.max / max) * plotW, cy = y + 12;
    const tip = `${d.label}: median ${fmt(d.s.median)}, range ${fmt(d.s.min)} to ${fmt(d.s.max)} over ${reps} repetition${reps === 1 ? "" : "s"}`;
    return `<g data-tip="${esc(tip)}"><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/><text class="lbl" x="${L - 8}" y="${cy + 4}" text-anchor="end">${esc(d.label)}</text><rect class="bar ${d.role}" x="${L}" y="${y + 5}" width="${w}" height="14" rx="2"/>${reps > 1 ? `<line class="whisk" x1="${lo}" x2="${hi}" y1="${cy}" y2="${cy}"/><line class="whisk" x1="${lo}" x2="${lo}" y1="${cy - 4}" y2="${cy + 4}"/><line class="whisk" x1="${hi}" x2="${hi}" y1="${cy - 4}" y2="${cy + 4}"/>` : ""}<text class="val" x="${Math.max(L + w, hi) + 6}" y="${cy + 4}">${fmt(d.s.median)}</text></g>`;
  }).join("");
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${ticks}${bars}</svg></figure>`;
}

// Dots with a min-max range, plus a band that marks what the control and its twin already disagree about (the noise floor).
export function dotChart(title: string, data: Row[], fmt: (x: number) => string, m: Summary): string {
  const W = 680, L = 190, R = 40, rowH = 30, top = 8, plotW = W - L - R;
  const lo0 = Math.min(...data.map((d) => d.s.min)), hi0 = Math.max(...data.map((d) => d.s.max));
  const pad = Math.max((hi0 - lo0) * 0.2, 0.005), lo = lo0 - pad, hi = hi0 + pad;
  const x = (v: number) => L + ((v - lo) / (hi - lo)) * plotW;
  const H = top + data.length * rowH + 26;
  const noise = data.filter((d) => d.role !== "arm"), nLo = Math.min(...noise.map((d) => d.s.min)), nHi = Math.max(...noise.map((d) => d.s.max));
  const ticks = [lo, (lo + hi) / 2, hi].map((t) => `<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${top}" y2="${H - 22}"/><text class="tick" x="${x(t)}" y="${H - 6}" text-anchor="middle">${fmt(t)}</text>`).join("");
  const band = `<rect class="band" x="${x(nLo)}" y="${top}" width="${Math.max(2, x(nHi) - x(nLo))}" height="${data.length * rowH}"><title>Noise floor: ${esc(m.control)} and its identical copy already span ${fmt(nLo)} to ${fmt(nHi)}</title></rect>`;
  const dots = data.map((d, i) => {
    const y = top + i * rowH, cy = y + 15, tip = `${d.label}: median ${fmt(d.s.median)}, range ${fmt(d.s.min)} to ${fmt(d.s.max)} over ${m.reps} repetition${m.reps === 1 ? "" : "s"}`;
    return `<g data-tip="${esc(tip)}"><rect class="hit" x="0" y="${y}" width="${W}" height="${rowH}"/><text class="lbl" x="${L - 8}" y="${cy + 4}" text-anchor="end">${esc(d.label)}</text>${m.reps > 1 ? `<line class="whisk" x1="${x(d.s.min)}" x2="${x(d.s.max)}" y1="${cy}" y2="${cy}"/>` : ""}<circle class="dot ${d.role}" cx="${x(d.s.median)}" cy="${cy}" r="5"/><text class="val" x="${x(d.s.max) + 10}" y="${cy + 4}">${fmt(d.s.median)}</text></g>`;
  }).join("");
  return `<figure><figcaption>${esc(title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${ticks}${band}${dots}</svg></figure>`;
}

const span = (s: Spread, fmt: (x: number) => string) => (s.min === s.max ? fmt(s.median) : `${fmt(s.median)} <small>(${fmt(s.min)} to ${fmt(s.max)})</small>`);

function section(m: Summary, hardware?: string): string {
  const ctrl = m.aggregate[m.control]!, twin = m.aggregate[m.twin]!;
  const noiseLat = Math.abs(ctrl.latencyP50.median - twin.latencyP50.median) / ctrl.latencyP50.median;
  const kinds = Object.entries(m.workload).map(([k, n]) => `${n} ${k}`).join(", ");
  // Prompt-caching experiments carry cache read/write data; answer-cache ablations do not.
  const prefix = m.arms.some((a) => (m.aggregate[a]!.cacheReadShare?.max ?? 0) > 0 || (m.aggregate[a]!.cacheWriteShare?.max ?? 0) > 0);
  type Col = { h: string; cell: (g: ArmAgg, arm: string) => string };
  const cols: Col[] = [
    ...(prefix ? [] : [{ h: "Answered from cache", cell: (g: ArmAgg) => span(g.hitRate, fmtPct) }]),
    { h: "Passages reused", cell: (g) => (g.retrievalReuse ? span(g.retrievalReuse, fmtPct) : "-") },
    { h: "Model calls", cell: (g) => span(g.modelCalls, num) },
    { h: "Refusals", cell: (g) => (g.refusals ? span(g.refusals, num) : "-") },
    ...(prefix ? [{ h: "Prompt read from cache", cell: (g: ArmAgg) => (g.cacheReadShare ? span(g.cacheReadShare, fmtPct) : "-") }, { h: "Prompt written to cache", cell: (g: ArmAgg) => (g.cacheWriteShare ? span(g.cacheWriteShare, fmtPct) : "-") }, { h: "First token p50", cell: (g: ArmAgg) => (g.ttftP50 ? span(g.ttftP50, fmtMs) : "-") }] : []),
    { h: "Cost", cell: (g) => span(g.costUsd, fmtUsd) },
    { h: "Latency p50", cell: (g) => span(g.latencyP50, fmtMs) },
    { h: "p95", cell: (g) => span(g.latencyP95, fmtMs) },
    { h: "p99", cell: (g) => span(g.latencyP99, fmtMs) },
    { h: "F1", cell: (g) => span(g.f1, (x) => x.toFixed(3)) },
    ...(prefix ? [] : [{ h: "Wrong answers served", cell: (g: ArmAgg) => span(g.wrongServed, num) }]),
    { h: "Answers differing from control", cell: (g, a) => (a === m.control ? "-" : span(g.disagreeWithControl, fmtPct)) },
  ];
  const table = `<div class="tablewrap"><table><thead><tr><th>Arm</th>${cols.map((c) => `<th>${c.h}</th>`).join("")}</tr></thead><tbody>${m.arms.map((a) => {
    const g = m.aggregate[a]!;
    return `<tr class="${roleOf(a, m)}"><th scope="row">${esc(a)}${a === m.control ? " <small>(control)</small>" : a === m.twin ? " <small>(identical copy)</small>" : ""}</th>${cols.map((c) => `<td>${c.cell(g, a)}</td>`).join("")}</tr>`;
  }).join("")}</tbody></table></div>`;
  const charts = prefix
    ? [barChart("Median time to first token (lower is better)", rows(m, (a) => a.ttftP50 ?? a.latencyP50), fmtMs, m.reps), barChart("Share of prompt tokens read from the cache", rows(m, (a) => a.cacheReadShare ?? a.hitRate), fmtPct, m.reps), barChart("Cost per repetition (cache writes cost extra, reads far less)", rows(m, (a) => a.costUsd), fmtUsd, m.reps), dotChart("Answer quality, F1 (the shaded band is the noise floor)", rows(m, (a) => a.f1), (x) => x.toFixed(3), m)]
    : [barChart("Median latency per request (lower is better)", rows(m, (a) => a.latencyP50), fmtMs, m.reps), barChart("95th percentile latency (the slow tail)", rows(m, (a) => a.latencyP95), fmtMs, m.reps), barChart("Model calls made (each one costs money and time)", rows(m, (a) => a.modelCalls), num, m.reps), dotChart("Answer quality, F1 (the shaded band is the noise floor)", rows(m, (a) => a.f1), (x) => x.toFixed(3), m)];
  return `<section>
  <h2>${esc(m.setup.llm.model)} <small>${esc(m.setup.llm.provider)}${m.workloadName ? ` &middot; ${esc(m.workloadName)} workload` : ""}</small></h2>
  <p class="meta">${m.requests} requests per arm (${esc(kinds)}), ${m.reps} repetition${m.reps === 1 ? "" : "s"}. Semantic threshold ${m.setup.thresholds.semantic}, retrieval threshold ${m.setup.thresholds.retrieval}. Run cost ${fmtUsd(m.costUsd)}.${hardware && m.setup.llm.provider === "ollama" ? ` Hardware: ${esc(hardware)}.` : ""} Each cell: median, then the range across repetitions.</p>
  <p class="floor"><b>Noise floor.</b> The control and its identical copy answered the same requests in the same random-order schedule. Their median latency differs by ${fmtPct(noiseLat)} and their answers differ on ${span(twin.disagreeWithControl, fmtPct)} of requests. A difference between arms that is smaller than this is not evidence of anything.</p>
  ${table}
  <div class="charts">
    ${charts.join("\n    ")}
  </div>
</section>`;
}

// `fragment` returns page content without the document wrapper, for hosts that add their own <html>/<head>/<body>.
export function renderReport(summaries: Summary[], opts: { title?: string; hardware?: string; fragment?: boolean } = {}): string {
  const title = opts.title ?? "Cache Ablation Report";
  const head = opts.fragment ? "" : `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`;
  const tail = opts.fragment ? "" : "</body></html>";
  return `${head}<title>${esc(title)}</title>${opts.fragment ? "" : "</head><body>"}
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@700;800&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap">
<style>
:root { --bg:#f4f4f1; --surface:#fcfcfb; --text:#0b0b0b; --text2:#52514e; --line:#dcdbd5; --accent:#2a78d6; --neutral:#8a8985; --warn-bg:#f6ecdc; --warn:#8a4306;
  --display:"Bricolage Grotesque","Helvetica Neue",Arial,sans-serif; --body:"Instrument Sans",system-ui,-apple-system,sans-serif; --mono:"JetBrains Mono",ui-monospace,Menlo,monospace; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#121211; --surface:#1a1a19; --text:#ffffff; --text2:#c3c2b7; --line:#34332f; --accent:#3987e5; --neutral:#8f8e89; --warn-bg:#3b2814; --warn:#f0a45c; color-scheme: dark; } }
:root[data-theme="dark"] { --bg:#121211; --surface:#1a1a19; --text:#ffffff; --text2:#c3c2b7; --line:#34332f; --accent:#3987e5; --neutral:#8f8e89; --warn-bg:#3b2814; --warn:#f0a45c; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 var(--body); padding-inline:16px; padding-block:28px 64px; }
main { max-width:960px; margin:0 auto; display:flex; flex-direction:column; gap:36px; }
h1,h2 { font-family:var(--display); margin:0; letter-spacing:-0.01em; text-wrap:balance; } h1 { font-size:clamp(30px,5vw,44px); } h2 { font-size:24px; } h2 small { font:500 13px var(--mono); color:var(--text2); margin-left:8px; }
.lede,.meta { color:var(--text2); margin:6px 0 0; max-width:70ch; }
section { background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:20px; display:flex; flex-direction:column; gap:16px; min-width:0; }
.floor { margin:0; padding:10px 14px; border:1px solid var(--warn); background:var(--warn-bg); border-radius:4px; font-size:14px; } .floor b { font:500 11px var(--mono); letter-spacing:.06em; text-transform:uppercase; color:var(--warn); margin-right:6px; }
.tablewrap { overflow-x:auto; } table { border-collapse:collapse; width:100%; font-size:13px; font-variant-numeric:tabular-nums; min-width:820px; }
th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); vertical-align:top; } td { white-space:nowrap; } thead th { font:500 11px var(--mono); letter-spacing:.05em; text-transform:uppercase; color:var(--text2); } tbody th { font-weight:600; white-space:nowrap; }
td small,th small { color:var(--text2); font-weight:400; } tr.control th,tr.twin th { color:var(--text2); }
.charts { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr)); gap:20px; } figure { margin:0; min-width:0; } figcaption { font:600 14px var(--body); margin-bottom:4px; }
svg { width:100%; height:auto; display:block; overflow:visible; } .grid { stroke:var(--line); stroke-width:1; } .tick { fill:var(--text2); font:11px var(--mono); }
.lbl { fill:var(--text); font:12px var(--body); } .val { fill:var(--text); font:500 12px var(--mono); font-variant-numeric:tabular-nums; }
.bar.arm { fill:var(--accent); } .bar.control,.bar.twin { fill:var(--neutral); } .dot.arm { fill:var(--accent); stroke:var(--surface); stroke-width:2; } .dot.control,.dot.twin { fill:var(--neutral); stroke:var(--surface); stroke-width:2; }
.whisk { stroke:var(--text2); stroke-width:1.5; } .band { fill:var(--neutral); opacity:.18; } .hit { fill:transparent; } g[data-tip]:hover .hit { fill:var(--line); opacity:.45; }
.key { display:flex; gap:18px; flex-wrap:wrap; color:var(--text2); font-size:13px; } .key i { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
#tip { position:fixed; pointer-events:none; background:var(--text); color:var(--surface); font:12px var(--body); padding:6px 9px; border-radius:4px; max-width:320px; z-index:5; display:none; }
footer { color:var(--text2); font-size:13px; max-width:75ch; }
</style><main>
<header><h1>${esc(title)}</h1><p class="lede">Every cache configuration answered the same requests, interleaved request by request in a random order and repeated, so slow changes in the machine or network hit every configuration alike.</p></header>
<div class="key"><span><i style="background:var(--accent)"></i>cache configuration</span><span><i style="background:var(--neutral)"></i>control and its identical copy</span><span>line = range across repetitions</span></div>
${summaries.map((m) => section(m, opts.hardware)).join("\n")}
<footer>${summaries.some((m) => m.arms.some((a) => (m.aggregate[a]!.cacheReadShare?.max ?? 0) > 0 || (m.aggregate[a]!.cacheWriteShare?.max ?? 0) > 0))
  ? "Prompt caching: a request that repeats an earlier prompt start is served that part from the provider's cache at a fraction of the price; the first request with a new start pays a premium to write it. Each arm has its own cache namespace (a label at the start of its prompts) so arms cannot warm each other. Quality is F1 against SQuAD gold answers (best of the accepted answers)."
  : "Hits are served without a model call, so a cache arm can only be as slow as the model on a miss. The tail (p95, p99) is set by misses. Quality is F1 against SQuAD gold answers (best of the accepted answers). \"Wrong answers served\" counts semantic-cache hits whose served answer belongs to a different question. Prompt caching is measured in separate runs, because a provider's prompt cache could leak between interleaved arms."}</footer>
</main><div id="tip"></div>
<script>(function(){var t=document.getElementById('tip');document.addEventListener('mousemove',function(e){var g=e.target.closest&&e.target.closest('[data-tip]');if(!g){t.style.display='none';return;}t.textContent=g.getAttribute('data-tip');t.style.display='block';t.style.left=Math.min(e.clientX+14,window.innerWidth-340)+'px';t.style.top=(e.clientY+16)+'px';});})();</script>
${tail}`;
}
