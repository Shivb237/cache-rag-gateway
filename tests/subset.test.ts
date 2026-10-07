import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SquadData } from "../src/rag/squad.js";
import { buildSubsetFile, mulberry32, selectSubset, shuffle, verifySubsetSource } from "../src/rag/subset.js";

// 20 paragraphs, 2 questions each, ids "0-0" .. "3-4"
const data: SquadData = {
  paragraphs: Array.from({ length: 20 }, (_, i) => ({ id: `${Math.floor(i / 5)}-${i % 5}`, title: `A${Math.floor(i / 5)}`, text: `para ${i}` })),
  questions: Array.from({ length: 20 }, (_, i) => i).flatMap((i) =>
    [0, 1].map((k) => ({ id: `q${i}-${k}`, text: "?", answers: ["a"], paragraphId: `${Math.floor(i / 5)}-${i % 5}` })),
  ),
};

describe("mulberry32", () => {
  const take = (seed: number) => {
    const r = mulberry32(seed);
    return Array.from({ length: 5 }, r);
  };
  it("gives the same sequence for the same seed", () => expect(take(42)).toEqual(take(42)));
  it("gives a different sequence for a different seed", () => expect(take(42)).not.toEqual(take(43)));
  it("stays inside [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe("shuffle", () => {
  const input = Array.from({ length: 50 }, (_, i) => i);
  it("returns a permutation and leaves the input alone", () => {
    const copy = [...input];
    const out = shuffle(input, mulberry32(1));
    expect(input).toEqual(copy);
    expect([...out].sort((a, b) => a - b)).toEqual(input);
    expect(out).not.toEqual(input);
  });
  it("is repeatable with the same seed", () => expect(shuffle(input, mulberry32(1))).toEqual(shuffle(input, mulberry32(1))));
});

describe("selectSubset", () => {
  it("is identical for the same seed and different for another seed", () => {
    expect(selectSubset(data, 42, 8)).toEqual(selectSubset(data, 42, 8));
    expect(selectSubset(data, 42, 8).paragraphs).not.toEqual(selectSubset(data, 43, 8).paragraphs);
  });
  it("returns n paragraphs and only questions that belong to them", () => {
    const s = selectSubset(data, 42, 8);
    const ids = new Set(s.paragraphs.map((p) => p.id));
    expect(s.paragraphs).toHaveLength(8);
    expect(s.questions).toHaveLength(16);
    expect(s.questions.every((q) => ids.has(q.paragraphId))).toBe(true);
  });
  it("keeps the file's original paragraph order", () => {
    const order = data.paragraphs.map((p) => p.id);
    const got = selectSubset(data, 42, 8).paragraphs.map((p) => order.indexOf(p.id));
    expect(got).toEqual([...got].sort((a, b) => a - b));
  });
  it("throws when asked for more paragraphs than exist", () => {
    expect(() => selectSubset(data, 42, 21)).toThrow(/only 20/);
  });
});

describe("source hash", () => {
  const rawJson = (text: string) => ({
    data: [{ title: "T", paragraphs: [{ context: text, qas: [{ id: "q", question: "?", answers: [{ text: "a" }] }] }] }],
  });
  const write = (value: unknown) => {
    const path = join(mkdtempSync(join(tmpdir(), "subset-")), "squad.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  it("accepts the unchanged source and rejects a changed one", () => {
    const path = write(rawJson("one"));
    const subset = buildSubsetFile(path, 1, 1);
    expect(() => verifySubsetSource(subset, path)).not.toThrow();
    writeFileSync(path, JSON.stringify(rawJson("two")));
    expect(() => verifySubsetSource(subset, path)).toThrow(/dataset changed/);
  });
});
