import { describe, expect, it } from "vitest";
import type { Question } from "../src/rag/squad.js";
import { makeWorkload } from "../src/eval/workload.js";

const pool: Question[] = Array.from({ length: 500 }, (_, i) => ({ id: `q${i}`, text: `t${i}`, answers: ["a"], paragraphId: "0-0" }));

describe("makeWorkload", () => {
  it("with repeat rate 0 returns the first n pool questions in order (matches the baseline)", () => {
    const w = makeWorkload(pool, 50, 0, 1);
    expect(w.items.map((q) => q.id)).toEqual(pool.slice(0, 50).map((q) => q.id));
    expect(w).toMatchObject({ uniqueCount: 50, repeatCount: 0 });
  });
  it("is identical for the same seed and different for another", () => {
    const ids = (seed: number) => makeWorkload(pool, 100, 0.5, seed).items.map((q) => q.id);
    expect(ids(7)).toEqual(ids(7));
    expect(ids(7)).not.toEqual(ids(8));
  });
  it("only repeats questions that were already asked, and the first request is never a repeat", () => {
    const w = makeWorkload(pool, 200, 0.75, 3);
    const seen = new Set<string>();
    w.items.forEach((q, i) => {
      if (i === 0) expect(seen.has(q.id)).toBe(false);
      seen.add(q.id);
    });
    expect(w.uniqueCount + w.repeatCount).toBe(200);
    expect(new Set(w.items.map((q) => q.id)).size).toBe(w.uniqueCount);
  });
  it("lands close to the requested repeat rate", () => {
    const w = makeWorkload(pool, 400, 0.5, 11);
    expect(w.repeatCount / 400).toBeGreaterThan(0.42);
    expect(w.repeatCount / 400).toBeLessThan(0.58);
  });
  it("throws when the pool is too small", () => {
    expect(() => makeWorkload(pool.slice(0, 5), 10, 0, 1)).toThrow(/ran out/);
  });
});

import { orderQuestions, pickByParagraph } from "../src/eval/workload.js";
describe("pickByParagraph / orderQuestions", () => {
  const qs: Question[] = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, text: `t${i}`, answers: ["a"], paragraphId: `p${i % 12}` })); // 12 paragraphs x 5 questions
  it("returns whole paragraphs' questions together, cut to exactly n", () => {
    const picked = pickByParagraph(qs, 22, 1);
    expect(picked).toHaveLength(22);
    const runs = picked.filter((q, i) => i === 0 || q.paragraphId !== picked[i - 1]!.paragraphId).length;
    expect(runs).toBe(5); // 4 full groups of 5 + a group cut to 2: each paragraph appears as one block
  });
  it("is deterministic and seed-sensitive", () => {
    expect(pickByParagraph(qs, 22, 1)).toEqual(pickByParagraph(qs, 22, 1));
    expect(pickByParagraph(qs, 22, 1)).not.toEqual(pickByParagraph(qs, 22, 2));
  });
  it("shuffled keeps the same questions in a different order; grouped keeps the order", () => {
    const grouped = pickByParagraph(qs, 30, 1);
    const shuffled = orderQuestions(grouped, "shuffled", 5);
    expect([...shuffled].map((q) => q.id).sort()).toEqual([...grouped].map((q) => q.id).sort());
    expect(shuffled).not.toEqual(grouped);
    expect(orderQuestions(grouped, "grouped", 5)).toEqual(grouped);
  });
});

import { pickDiverse } from "../src/eval/workload.js";
describe("pickDiverse", () => {
  const qs: Question[] = Array.from({ length: 60 }, (_, i) => ({ id: `q${i}`, text: `t${i}`, answers: ["a"], paragraphId: `p${i % 12}` }));
  it("takes one question per paragraph, up to n", () => {
    const d = pickDiverse(qs, 8);
    expect(d).toHaveLength(8);
    expect(new Set(d.map((q) => q.paragraphId)).size).toBe(8);
  });
  it("returns fewer when there are not enough distinct paragraphs", () => {
    expect(pickDiverse(qs, 50)).toHaveLength(12);
  });
});
