import { describe, expect, it } from "vitest";
import { summarize, type AblationRow } from "../src/eval/ablationStats.js";

const row = (o: Partial<AblationRow>): AblationRow => ({
  rep: 0, i: 0, arm: "none", kind: "original", answer: "a", f1: 1, em: 1, cacheHit: false, cacheLayer: null, wrongServed: null,
  totalMs: 1000, promptTokens: 900, completionTokens: 5, costUsd: 0.002, ...o,
});

// 4 requests, 2 reps. none and none-twin answer alike except request 3 in rep 1 (model noise); exact hits repeats.
const rows: AblationRow[] = [];
for (const rep of [0, 1]) {
  for (let i = 0; i < 4; i++) {
    const repeat = i === 3;
    rows.push(row({ rep, i, arm: "none", answer: `ans${i}`, totalMs: 1000 + rep * 100 }));
    rows.push(row({ rep, i, arm: "none-twin", answer: rep === 1 && i === 3 ? "different" : `ans${i}`, totalMs: 1000 + rep * 100 }));
    rows.push(row({ rep, i, arm: "exact", answer: `ans${i}`, kind: repeat ? "repeat" : "original", cacheHit: repeat, cacheLayer: repeat ? "exact" : null, totalMs: repeat ? 0.2 : 1000, promptTokens: repeat ? 0 : 900, costUsd: repeat ? 0 : 0.002 }));
  }
}

describe("summarize", () => {
  const s = summarize(rows, "none", "none-twin");
  it("computes hit rate, model calls, cost and latency per arm", () => {
    const e = s.perRep["exact"]![0]!;
    expect(e).toMatchObject({ requests: 4, hitRate: 0.25, exactHits: 1, semanticHits: 0, modelCalls: 3 });
    expect(e.costUsd).toBeCloseTo(0.006);
    expect(e.tokensIn).toBe(2700);
    expect(e.retrievalReuse).toBe(0);
    expect(e.hitRateByKind).toEqual({ original: 0, repeat: 1 });
    expect(e.missLatencyP50).toBe(1000);
  });
  it("measures the noise floor as control vs its identical twin", () => {
    expect(s.perRep["none-twin"]![0]!.disagreeWithTwin).toBe(0);
    expect(s.perRep["none-twin"]![1]!.disagreeWithTwin).toBeCloseTo(0.25); // one of four answers differed in rep 1
    expect(s.aggregate["none-twin"]!.disagreeWithControl).toMatchObject({ min: 0, max: 0.25 });
  });
  it("compares other arms with the control's answers", () => {
    expect(s.perRep["exact"]![0]!.disagreeWithTwin).toBe(0);
  });
  it("reports median and range across repetitions", () => {
    expect(s.aggregate["none"]!.latencyP50).toEqual({ median: 1000, min: 1000, max: 1100 });
    expect(s.reps).toEqual([0, 1]);
  });
});

describe("retrieval reuse", () => {
  it("counts requests whose passages came from the retrieval cache, separately from answers served from cache", () => {
    const rs = [row({ arm: "retrieval", i: 0, retrievalHit: false }), row({ arm: "retrieval", i: 1, retrievalHit: true }), row({ arm: "retrieval", i: 2, retrievalHit: true }), row({ arm: "retrieval", i: 3, retrievalHit: null })];
    const s = summarize(rs, "retrieval", "retrieval-twin");
    expect(s.perRep["retrieval"]![0]!.retrievalReuse).toBe(0.5);
    expect(s.perRep["retrieval"]![0]!.hitRate).toBe(0);
  });
});

describe("prompt-cache metrics", () => {
  it("reports the share of prompt tokens read from and written to the provider cache, and first-token time", () => {
    const rs = [
      row({ arm: "c", i: 0, promptTokens: 1000, cachedPromptTokens: 0, cacheWriteTokens: 900, ttftMs: 2000 }),
      row({ arm: "c", i: 1, promptTokens: 1000, cachedPromptTokens: 900, cacheWriteTokens: 0, ttftMs: 1000 }),
    ];
    const m = summarize(rs, "c", "c-twin").perRep["c"]![0]!;
    expect(m.cacheReadShare).toBeCloseTo(0.45);
    expect(m.cacheWriteShare).toBeCloseTo(0.45);
    expect(m.ttftP50).toBe(1000);
  });
});
