import { mean, percentile } from "./metrics.js";

// One request answered by one arm in one repetition.
export interface AblationRow {
  rep: number;
  i: number; // position in the request stream
  arm: string;
  kind: string; // original | repeat | paraphrase | hard | easy
  answer: string;
  f1: number;
  em: number;
  cacheHit: boolean;
  cacheLayer: string | null;
  wrongServed: boolean | null; // semantic hit whose served answer belongs to a different question
  retrievalHit?: boolean | null; // the passage list came from the retrieval cache
  refused?: boolean; // the model declined to answer
  cachedPromptTokens?: number; // prompt tokens read from the provider's prompt cache
  cacheWriteTokens?: number; // prompt tokens written to it
  ttftMs?: number;
  totalMs: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

export interface ArmMetrics {
  requests: number;
  hitRate: number;
  retrievalReuse: number; // share of requests that reused a similar query's passage list
  exactHits: number;
  semanticHits: number;
  modelCalls: number;
  refusals: number;
  cacheReadShare: number; // share of all prompt tokens that were read from the provider's prompt cache
  cacheWriteShare: number;
  ttftP50: number;
  ttftP95: number;
  wrongServed: number;
  f1: number;
  em: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
  missLatencyP50: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  hitRateByKind: Record<string, number>;
  disagreeWithTwin: number | null; // share of requests where this arm's answer differs from the control twin's answer
}

export function armMetrics(rows: AblationRow[], twinAnswers?: Map<number, string>): ArmMetrics {
  const hits = rows.filter((r) => r.cacheHit);
  const misses = rows.filter((r) => !r.cacheHit);
  const kinds = [...new Set(rows.map((r) => r.kind))];
  return {
    requests: rows.length,
    hitRate: hits.length / rows.length,
    retrievalReuse: rows.filter((r) => r.retrievalHit === true).length / rows.length,
    exactHits: hits.filter((r) => r.cacheLayer === "exact").length,
    semanticHits: hits.filter((r) => r.cacheLayer === "semantic").length,
    modelCalls: misses.length,
    refusals: rows.filter((r) => r.refused === true).length,
    cacheReadShare: rows.reduce((s, r) => s + (r.cachedPromptTokens ?? 0), 0) / Math.max(1, rows.reduce((s, r) => s + r.promptTokens, 0)),
    cacheWriteShare: rows.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0) / Math.max(1, rows.reduce((s, r) => s + r.promptTokens, 0)),
    ttftP50: percentile(rows.map((r) => r.ttftMs ?? r.totalMs), 50),
    ttftP95: percentile(rows.map((r) => r.ttftMs ?? r.totalMs), 95),
    wrongServed: rows.filter((r) => r.wrongServed === true).length,
    f1: mean(rows.map((r) => r.f1)),
    em: mean(rows.map((r) => r.em)),
    latencyP50: percentile(rows.map((r) => r.totalMs), 50),
    latencyP95: percentile(rows.map((r) => r.totalMs), 95),
    latencyP99: percentile(rows.map((r) => r.totalMs), 99),
    missLatencyP50: misses.length ? percentile(misses.map((r) => r.totalMs), 50) : null,
    tokensIn: rows.reduce((s, r) => s + r.promptTokens, 0),
    tokensOut: rows.reduce((s, r) => s + r.completionTokens, 0),
    costUsd: rows.reduce((s, r) => s + r.costUsd, 0),
    hitRateByKind: Object.fromEntries(kinds.map((k) => { const rs = rows.filter((r) => r.kind === k); return [k, rs.filter((r) => r.cacheHit).length / rs.length]; })),
    disagreeWithTwin: twinAnswers ? rows.filter((r) => twinAnswers.has(r.i) && twinAnswers.get(r.i) !== r.answer).length / rows.length : null,
  };
}

export interface Spread { median: number; min: number; max: number }
const spread = (xs: number[]): Spread => ({ median: percentile(xs, 50), min: Math.min(...xs), max: Math.max(...xs) });

// Per arm, per repetition metrics, then the median and the min-max range across repetitions.
// `twin` is the arm that is an identical copy of the control: the difference between the control and its twin is the noise floor.
export function summarize(rows: AblationRow[], control: string, twin: string) {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const reps = [...new Set(rows.map((r) => r.rep))].sort((a, b) => a - b);
  const perRep: Record<string, ArmMetrics[]> = {};
  for (const arm of arms) {
    perRep[arm] = reps.map((rep) => {
      const refRows = rows.filter((r) => r.rep === rep && r.arm === (arm === twin ? control : twin));
      const ref = new Map(refRows.map((r) => [r.i, r.answer]));
      return armMetrics(rows.filter((r) => r.rep === rep && r.arm === arm), arm === control || arm === twin ? ref : new Map(rows.filter((r) => r.rep === rep && r.arm === control).map((r) => [r.i, r.answer])));
    });
  }
  const fields = ["hitRate", "retrievalReuse", "modelCalls", "refusals", "cacheReadShare", "cacheWriteShare", "ttftP50", "ttftP95", "wrongServed", "f1", "em", "latencyP50", "latencyP95", "latencyP99", "tokensIn", "tokensOut", "costUsd"] as const;
  const agg = (arm: string) => {
    const m = perRep[arm]!;
    const out = {} as Record<(typeof fields)[number], Spread>;
    for (const f of fields) out[f] = spread(m.map((x) => x[f] as number));
    return { ...out, disagreeWithControl: spread(m.map((x) => x.disagreeWithTwin ?? 0)), hitRateByKind: m[0]!.hitRateByKind };
  };
  const aggregate = Object.fromEntries(arms.map((arm) => [arm, agg(arm)])) as Record<string, ReturnType<typeof agg>>;
  return { arms, reps, perRep, aggregate };
}
