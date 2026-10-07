import type { Paragraph, Question } from "../rag/squad.js";
import { mulberry32, shuffle } from "../rag/subset.js";

// One simulated data update: a number in a paragraph that answers a question is replaced by a different number.
export interface Edit {
  paragraphId: string;
  questionId: string;
  question: string;
  oldValue: string;
  newValue: string;
  oldAnswers: string[];
  newAnswers: string[];
}

const wholeNumber = (value: string) => new RegExp(`(?<![\\d])${value}(?![\\d])`, "g");

// Picks up to `k` questions (one per paragraph) whose first numeric gold answer appears exactly once in its paragraph,
// and invents a different number for each (old + 3..19, never one already in the paragraph).
export function chooseEdits(data: { paragraphs: Paragraph[]; questions: Question[] }, k: number, seed: number): Edit[] {
  const text = new Map(data.paragraphs.map((p) => [p.id, p.text]));
  const rand = mulberry32(seed);
  const edits: Edit[] = [];
  const usedParagraphs = new Set<string>();
  for (const q of shuffle(data.questions, mulberry32(seed + 1))) {
    if (edits.length >= k) break;
    if (usedParagraphs.has(q.paragraphId)) continue;
    const oldValue = q.answers.map((a) => a.trim()).find((a) => /^\d{3,4}$/.test(a));
    const para = text.get(q.paragraphId);
    if (!oldValue || !para || (para.match(wholeNumber(oldValue)) ?? []).length !== 1) continue;
    let newValue = String(Number(oldValue) + 3 + Math.floor(rand() * 17));
    while (wholeNumber(newValue).test(para)) newValue = String(Number(newValue) + 1);
    usedParagraphs.add(q.paragraphId);
    edits.push({ paragraphId: q.paragraphId, questionId: q.id, question: q.text, oldValue, newValue, oldAnswers: q.answers, newAnswers: [newValue] });
  }
  return edits;
}

export function applyEdits(paragraphs: Paragraph[], edits: Edit[]): Paragraph[] {
  const byId = new Map(edits.map((e) => [e.paragraphId, e]));
  return paragraphs.map((p) => {
    const e = byId.get(p.id);
    return e ? { ...p, text: p.text.replace(wholeNumber(e.oldValue), e.newValue) } : p;
  });
}

// Did the answer use the new value (fresh), still use the old one (stale), or neither?
// Looks for the numbers inside the answer text, so "1028-bit" and "in 1946." both count.
export function classifyAnswer(answer: string, edit: Edit): "new" | "old" | "other" {
  const numbers: string[] = answer.match(/\d+/g) ?? [];
  if (numbers.includes(edit.newValue)) return "new";
  if (numbers.includes(edit.oldValue)) return "old";
  return "other";
}
