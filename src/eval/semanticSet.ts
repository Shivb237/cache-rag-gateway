import { normalizeAnswer } from "./metrics.js";
import type { Paragraph, Question } from "../rag/squad.js";
import { mulberry32, shuffle } from "../rag/subset.js";

export interface ParaphraseFile {
  items: { questionId: string; original: string; paraphrase: string; ok: boolean }[];
}

export type QueryKind = "paraphrase" | "hard" | "easy";
// `truth` is the question whose gold answer is the correct answer for `text`.
export interface SemanticQuery {
  kind: QueryKind;
  text: string;
  truth: Question;
  sourceId: string; // the cached original this query is related to
}

const goldSet = (q: Question) => new Set(q.answers.map(normalizeAnswer));
// True when two questions share a normalised gold answer, so serving one's answer for the other is still correct.
export const sameAnswer = (a: Question, b: Question): boolean => [...goldSet(a)].some((x) => goldSet(b).has(x));

// Queries for testing a semantic cache that already holds `originals`:
//  - paraphrase: the model's rewording of an original (should hit, answer unchanged)
//  - hard: other questions on the SAME paragraph with a different answer (must not hit), up to 4 per original
//  - easy: one question from a different article per original (must not hit)
export function buildSemanticQueries(
  data: { paragraphs: Paragraph[]; questions: Question[] },
  paraphrases: ParaphraseFile,
  originals: Question[],
  seed: number,
): SemanticQuery[] {
  const title = new Map(data.paragraphs.map((p) => [p.id, p.title]));
  const byId = new Map(data.questions.map((q) => [q.id, q]));
  const originalIds = new Set(originals.map((q) => q.id));
  const queries: SemanticQuery[] = [];

  for (const p of paraphrases.items) {
    if (p.ok) queries.push({ kind: "paraphrase", text: p.paraphrase, truth: byId.get(p.questionId)!, sourceId: p.questionId });
  }
  const rand = mulberry32(seed + 3);
  const usedHard = new Set<string>(); // a question can be a near-miss for several originals; ask it only once
  for (const o of originals) {
    const same = data.questions.filter((q) => q.paragraphId === o.paragraphId && q.id !== o.id && !originalIds.has(q.id) && !sameAnswer(q, o) && !usedHard.has(q.text));
    for (const q of shuffle(same, rand).slice(0, 4)) {
      usedHard.add(q.text);
      queries.push({ kind: "hard", text: q.text, truth: q, sourceId: o.id });
    }
  }
  for (const [i, o] of originals.entries()) {
    const other = data.questions.filter((q) => title.get(q.paragraphId) !== title.get(o.paragraphId) && !originalIds.has(q.id));
    const pick = shuffle(other, mulberry32(seed + 100 + i))[0]!;
    queries.push({ kind: "easy", text: pick.text, truth: pick, sourceId: o.id });
  }
  return queries;
}
