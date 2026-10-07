import type { Question } from "../rag/squad.js";
import { mulberry32, shuffle } from "../rag/subset.js";

export interface Workload {
  items: Question[]; // the questions to ask, in order
  uniqueCount: number;
  repeatCount: number;
}

// Builds a request stream where about `repeatRate` of requests repeat an earlier question.
// `pool` is the ordered list of fresh questions to draw from. A repeat picks uniformly from
// questions already asked; real traffic is usually skewed (a few questions asked very often),
// so uniform repeats are a simple first model, not a claim about real usage.
export function makeWorkload(pool: Question[], requests: number, repeatRate: number, seed: number): Workload {
  const rand = mulberry32(seed);
  const asked: Question[] = [];
  const items: Question[] = [];
  let next = 0;
  let repeatCount = 0;
  for (let i = 0; i < requests; i++) {
    if (asked.length > 0 && rand() < repeatRate) {
      items.push(asked[Math.floor(rand() * asked.length)]!);
      repeatCount++;
    } else {
      const q = pool[next++];
      if (!q) throw new Error(`pool of ${pool.length} questions ran out`);
      asked.push(q);
      items.push(q);
    }
  }
  return { items, uniqueCount: asked.length, repeatCount };
}

// Picks about `n` questions as whole paragraphs' worth of questions (paragraphs chosen by a seeded shuffle),
// returned grouped: all questions about one paragraph are next to each other. The last group is cut to fit.
export function pickByParagraph(pool: Question[], n: number, seed: number): Question[] {
  const groups = new Map<string, Question[]>();
  for (const q of pool) groups.set(q.paragraphId, [...(groups.get(q.paragraphId) ?? []), q]);
  const out: Question[] = [];
  for (const id of shuffle([...groups.keys()].sort(), mulberry32(seed))) {
    out.push(...groups.get(id)!);
    if (out.length >= n) break;
  }
  return out.slice(0, n);
}

// The same questions, either as given (grouped by paragraph) or in a seeded random order.
export function orderQuestions(grouped: Question[], order: "grouped" | "shuffled", seed: number): Question[] {
  return order === "grouped" ? grouped : shuffle(grouped, mulberry32(seed));
}

// The first `n` questions of an (already shuffled) pool that all come from different paragraphs: little shared context.
export function pickDiverse(pool: Question[], n: number): Question[] {
  const seen = new Set<string>();
  const out: Question[] = [];
  for (const q of pool) {
    if (seen.has(q.paragraphId)) continue;
    seen.add(q.paragraphId);
    out.push(q);
    if (out.length >= n) break;
  }
  return out;
}
