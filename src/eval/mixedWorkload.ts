import type { Paragraph, Question } from "../rag/squad.js";
import { mulberry32, shuffle } from "../rag/subset.js";
import { buildSemanticQueries, type ParaphraseFile } from "./semanticSet.js";

export type MixedKind = "original" | "repeat" | "paraphrase" | "hard" | "easy";
export interface MixedItem {
  kind: MixedKind;
  q: Question; // `text` is what gets asked; `answers` and `paragraphId` are the gold for THIS text
}

// A request stream that exercises every cache layer at once:
//  - the first `originals` questions are asked once (they fill the caches),
//  - then a shuffled mix of: exact repeats of originals (exact cache), paraphrases (semantic cache should hit),
//    near-misses from the same paragraph (semantic cache must NOT hit) and questions from other articles.
export function buildMixedWorkload(
  data: { paragraphs: Paragraph[]; questions: Question[] },
  paraphrases: ParaphraseFile,
  pool: Question[],
  opts: { originals: number; seed: number },
): MixedItem[] {
  const originals = pool.slice(0, opts.originals);
  const ids = new Set(originals.map((q) => q.id));
  const all = buildSemanticQueries(data, paraphrases, originals, opts.seed).filter((x) => ids.has(x.sourceId));
  const take = (kind: string, n: number) => shuffle(all.filter((x) => x.kind === kind), mulberry32(opts.seed + 5)).slice(0, n);
  const asQuestion = (x: (typeof all)[number]): Question => ({ id: `${x.kind}~${x.sourceId}~${x.truth.id}`, text: x.text, answers: x.truth.answers, paragraphId: x.truth.paragraphId });
  const later: MixedItem[] = [
    ...take("paraphrase", opts.originals).map((x) => ({ kind: "paraphrase" as const, q: asQuestion(x) })),
    ...take("hard", Math.ceil(opts.originals * 0.6)).map((x) => ({ kind: "hard" as const, q: asQuestion(x) })),
    ...take("easy", Math.ceil(opts.originals * 0.25)).map((x) => ({ kind: "easy" as const, q: asQuestion(x) })),
    ...shuffle(originals, mulberry32(opts.seed + 6)).slice(0, Math.ceil(opts.originals * 0.5)).map((q) => ({ kind: "repeat" as const, q })),
  ];
  return [...originals.map((q) => ({ kind: "original" as const, q })), ...shuffle(later, mulberry32(opts.seed + 7))];
}
