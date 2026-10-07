import { describe, expect, it } from "vitest";
import { bestOverGold, exactMatch, f1, goldRank, mean, normalizeAnswer, percentile } from "../src/eval/metrics.js";

describe("normalizeAnswer", () => {
  it("lowercases, drops punctuation and articles, collapses spaces", () => {
    expect(normalizeAnswer('The  Denver Broncos!')).toBe("denver broncos");
    expect(normalizeAnswer('"golden anniversary')).toBe("golden anniversary");
    expect(normalizeAnswer("In early 2012.")).toBe("in early 2012");
  });
});

describe("exactMatch / f1", () => {
  it("exact match survives case, punctuation and articles", () => {
    expect(exactMatch("the broncos.", "Broncos")).toBe(1);
    expect(exactMatch("Broncos", "Denver Broncos")).toBe(0);
  });
  it("F1 gives partial credit for overlap", () => {
    expect(f1("Broncos", "Denver Broncos")).toBeCloseTo(2 / 3); // precision 1, recall 0.5
    expect(f1("Super Bowl 50", "the 50th Super Bowl")).toBeCloseTo(2 / 3); // shares "super" and "bowl": precision 2/3, recall 2/3
    expect(f1("cat", "dog")).toBe(0);
  });
  it("counts repeated words as a multiset", () => {
    expect(f1("b b b", "b b")).toBeCloseTo(0.8); // 2 shared of 3 predicted (precision 2/3), 2 of 2 gold (recall 1)
  });
  it("handles empty answers without dividing by zero", () => {
    expect(f1("", "")).toBe(1);
    expect(f1("", "x")).toBe(0);
  });
});

describe("bestOverGold", () => {
  it("takes the best score over every accepted answer", () => {
    const golds = ["Denver Broncos", "Broncos"];
    expect(bestOverGold(exactMatch, "broncos", golds)).toBe(1);
    expect(bestOverGold(f1, "Denver", golds)).toBeCloseTo(2 / 3);
  });
});

describe("goldRank / percentile / mean", () => {
  it("rank is 1-based and 0 when missing", () => {
    expect(goldRank(["a", "b", "c"], "b")).toBe(2);
    expect(goldRank(["a", "b"], "z")).toBe(0);
  });
  it("nearest-rank percentile", () => {
    const xs = [15, 20, 35, 40, 50]; // classic textbook example
    expect(percentile(xs, 50)).toBe(35);
    expect(percentile(xs, 95)).toBe(50);
    expect(percentile(xs, 20)).toBe(15);
    expect(percentile([7], 99)).toBe(7);
  });
  it("mean", () => expect(mean([1, 2, 3, 4])).toBe(2.5));
});
