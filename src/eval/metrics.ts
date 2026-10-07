// Answer scoring follows the official SQuAD v1.1 evaluation: normalise both strings, then
// compare. Because many questions have several accepted answers, we take the BEST score
// over all of them.

export function normalizeAnswer(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/g, "") // remove punctuation
    .replace(/\b(a|an|the)\b/g, " ") // remove articles
    .split(/\s+/)
    .filter(Boolean)
    .join(" "); // collapse whitespace
}

export function exactMatch(prediction: string, gold: string): number {
  return normalizeAnswer(prediction) === normalizeAnswer(gold) ? 1 : 0;
}

// Token-level F1: overlap of words, counted as a multiset (a word repeated twice counts twice).
export function f1(prediction: string, gold: string): number {
  const p = normalizeAnswer(prediction).split(" ").filter(Boolean);
  const g = normalizeAnswer(gold).split(" ").filter(Boolean);
  if (p.length === 0 || g.length === 0) return p.length === g.length ? 1 : 0;
  const goldCounts = new Map<string, number>();
  for (const w of g) goldCounts.set(w, (goldCounts.get(w) ?? 0) + 1);
  let common = 0;
  for (const w of p) {
    const left = goldCounts.get(w) ?? 0;
    if (left > 0) {
      common++;
      goldCounts.set(w, left - 1);
    }
  }
  if (common === 0) return 0;
  const precision = common / p.length;
  const recall = common / g.length;
  return (2 * precision * recall) / (precision + recall);
}

export function bestOverGold(score: (pred: string, gold: string) => number, prediction: string, golds: string[]): number {
  return Math.max(0, ...golds.map((g) => score(prediction, g)));
}

// 1-based rank of the gold paragraph in the retrieved list, or 0 if it is not there.
export function goldRank(retrievedIds: string[], goldId: string): number {
  return retrievedIds.indexOf(goldId) + 1;
}

// Nearest-rank percentile: the smallest value that at least p% of the values are <= to.
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

export function mean(values: number[]): number {
  return values.length === 0 ? NaN : values.reduce((a, b) => a + b, 0) / values.length;
}
