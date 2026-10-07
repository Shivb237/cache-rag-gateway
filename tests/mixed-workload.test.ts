import { describe, expect, it } from "vitest";
import { buildMixedWorkload } from "../src/eval/mixedWorkload.js";
import type { Question } from "../src/rag/squad.js";

// 30 paragraphs in 3 articles, 4 questions each, each with a distinct answer
const paragraphs = Array.from({ length: 30 }, (_, p) => ({ id: `${Math.floor(p / 10)}-${p % 10}`, title: `A${Math.floor(p / 10)}`, text: `para ${p}` }));
const questions: Question[] = paragraphs.flatMap((p, pi) => [0, 1, 2, 3].map((k) => ({ id: `q${pi}-${k}`, text: `question ${pi} ${k}`, answers: [`ans${pi}-${k}`], paragraphId: p.id })));
const pool = questions.filter((_, i) => i % 4 === 0); // one original per paragraph, in order
const paraphrases = { items: pool.slice(0, 12).map((q) => ({ questionId: q.id, original: q.text, paraphrase: `reworded ${q.text}`, ok: true })) };

describe("buildMixedWorkload", () => {
  const w = buildMixedWorkload({ paragraphs, questions }, paraphrases, pool, { originals: 12, seed: 1 });
  it("starts with the originals, in order, so they fill the caches", () => {
    expect(w.slice(0, 12).map((x) => x.kind)).toEqual(Array(12).fill("original"));
    expect(w.slice(0, 12).map((x) => x.q.id)).toEqual(pool.slice(0, 12).map((q) => q.id));
  });
  it("contains each kind in the planned proportions", () => {
    const count = (k: string) => w.filter((x) => x.kind === k).length;
    expect(count("paraphrase")).toBe(12);
    expect(count("repeat")).toBe(6); // half of the originals
    expect(count("hard")).toBeLessThanOrEqual(8);
    expect(count("easy")).toBeLessThanOrEqual(3);
  });
  it("repeats are exact copies of earlier original texts", () => {
    const originalTexts = new Set(w.slice(0, 12).map((x) => x.q.text));
    for (const x of w.filter((x) => x.kind === "repeat")) expect(originalTexts.has(x.q.text)).toBe(true);
  });
  it("hard near-misses come from the same paragraph as an original but have another answer", () => {
    const originals = w.slice(0, 12).map((x) => x.q);
    for (const x of w.filter((x) => x.kind === "hard")) {
      const o = originals.find((q) => q.paragraphId === x.q.paragraphId)!;
      expect(o).toBeDefined();
      expect(x.q.answers).not.toEqual(o.answers);
    }
  });
  it("is deterministic", () => {
    expect(buildMixedWorkload({ paragraphs, questions }, paraphrases, pool, { originals: 12, seed: 1 })).toEqual(w);
  });
});
