import { describe, expect, it } from "vitest";
import { summarize, type AblationRow } from "../src/eval/ablationStats.js";
import { barChart, dotChart, fmtMs, renderReport, type Summary } from "../src/eval/report.js";

const mk = (rep: number, i: number, arm: string, o: Partial<AblationRow> = {}): AblationRow => ({
  rep, i, arm, kind: "original", answer: `a${i}`, f1: 0.7, em: 0.5, cacheHit: false, cacheLayer: null, wrongServed: null, totalMs: 2000 + rep * 50, promptTokens: 900, completionTokens: 5, costUsd: 0.002, ...o,
});
const rows: AblationRow[] = [];
for (const rep of [0, 1, 2]) for (let i = 0; i < 5; i++) {
  rows.push(mk(rep, i, "none"), mk(rep, i, "none-twin", { totalMs: 2100 + rep * 50 }));
  rows.push(mk(rep, i, "exact", i >= 3 ? { cacheHit: true, cacheLayer: "exact", totalMs: 0.2, promptTokens: 0, completionTokens: 0, costUsd: 0 } : {}));
}
const s = summarize(rows, "none", "none-twin");
const summary: Summary = { name: "t", when: "2026-10-07", control: "none", twin: "none-twin", reps: 3, requests: 5, workload: { original: 5 }, arms: s.arms, costUsd: 0.1, setup: { llm: { provider: "fake", model: "fake-model" }, thresholds: { semantic: 0.9, retrieval: 0.75 } }, aggregate: s.aggregate as unknown as Summary["aggregate"] };

describe("report", () => {
  it("fragment mode drops the document wrapper", () => {
    const f = renderReport([summary], { fragment: true });
    expect(f).not.toContain("<!doctype");
    expect(f).not.toContain("<html");
    expect(f).not.toContain("<body");
    expect(f).toContain("<title>Cache Ablation Report</title>");
    expect(f).toContain("<table>");
  });
  it("formats milliseconds readably", () => {
    expect(fmtMs(0.2)).toBe("0.2 ms"); expect(fmtMs(123)).toBe("123 ms"); expect(fmtMs(4670)).toBe("4.7 s");
  });
  it("draws one bar per arm with a tooltip, in the right colour role", () => {
    const svg = barChart("Latency", s.arms.map((a) => ({ label: a, s: s.aggregate[a]!.latencyP50, role: a === "none" ? "control" : a === "none-twin" ? "twin" : "arm" })), fmtMs, 3);
    expect((svg.match(/data-tip=/g) ?? []).length).toBe(3);
    expect(svg).toContain('class="bar arm"');
    expect(svg).toContain('class="bar control"');
    expect(svg).toContain("range");
  });
  it("draws the noise band behind the quality dots", () => {
    const svg = dotChart("F1", s.arms.map((a) => ({ label: a, s: s.aggregate[a]!.f1, role: a === "none" ? "control" : a === "none-twin" ? "twin" : "arm" })), (x) => x.toFixed(3), summary);
    expect(svg).toContain('class="band"');
    expect((svg.match(/<circle/g) ?? []).length).toBe(3);
  });
  it("renders a complete page with the table, charts, theme tokens and the noise-floor statement", () => {
    const html = renderReport([summary], { hardware: "MacBook Air, Apple M4" });
    expect(html).toContain("<table>");
    expect((html.match(/<figure>/g) ?? []).length).toBe(4);
    expect(html).toContain("Noise floor");
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain("fake-model");
    expect(html).not.toContain("Hardware: MacBook"); // the fake provider is not a local model, so no hardware note
    const local = renderReport([{ ...summary, setup: { ...summary.setup, llm: { provider: "ollama", model: "local" } } }], { hardware: "MacBook Air, Apple M4" });
    expect(local).toContain("Hardware: MacBook Air, Apple M4");
  });
});

describe("prompt-caching report", () => {
  it("shows cache read/write columns and a cost chart only when the data has them", () => {
    const withCache = JSON.parse(JSON.stringify(summary)) as Summary;
    const spread = (v: number) => ({ median: v, min: v, max: v });
    withCache.aggregate["exact"] = { ...withCache.aggregate["exact"]!, cacheReadShare: spread(0.6), cacheWriteShare: spread(0.2), ttftP50: spread(900) };
    const html = renderReport([{ ...withCache, workloadName: "concentrated" }]);
    expect(html).toContain("Prompt read from cache");
    expect(html).toContain("Cost per repetition");
    expect(html).toContain("concentrated workload");
    expect(html).not.toContain("<th>Wrong answers served</th>");
    expect(html).toContain("own cache namespace");
    const plain = renderReport([summary]);
    expect(plain).not.toContain("Prompt read from cache");
    expect(plain).toContain("<th>Wrong answers served</th>");
  });
});
