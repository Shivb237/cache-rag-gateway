import { describe, expect, it } from "vitest";
import { applyEdits, chooseEdits, classifyAnswer } from "../src/eval/staleness.js";
import type { Question } from "../src/rag/squad.js";

const paragraphs = [
  { id: "0-0", title: "T", text: "The tower was completed in 1889 for the fair." },
  { id: "0-1", title: "T", text: "It opened in 1900 and again in 1900." }, // the number appears twice: not editable
  { id: "0-2", title: "T", text: "No numbers here at all." },
  { id: "1-0", title: "U", text: "The bridge opened in 1932 after 1920 plans." },
];
const questions: Question[] = [
  { id: "a", text: "When was the tower completed?", answers: ["1889", "in 1889"], paragraphId: "0-0" },
  { id: "b", text: "When did it open?", answers: ["1900"], paragraphId: "0-1" },
  { id: "c", text: "What is here?", answers: ["nothing"], paragraphId: "0-2" },
  { id: "d", text: "When did the bridge open?", answers: ["1932"], paragraphId: "1-0" },
];
const data = { paragraphs, questions };

describe("chooseEdits", () => {
  const edits = chooseEdits(data, 5, 7);
  it("only edits numbers that appear exactly once in a paragraph", () => {
    expect(edits.map((e) => e.questionId).sort()).toEqual(["a", "d"]);
  });
  it("invents a different number that is not already in the paragraph", () => {
    for (const e of edits) {
      expect(e.newValue).not.toBe(e.oldValue);
      const para = paragraphs.find((p) => p.id === e.paragraphId)!.text;
      expect(para.includes(e.newValue)).toBe(false);
      expect(e.newAnswers).toEqual([e.newValue]);
    }
  });
  it("is deterministic and respects k", () => {
    expect(chooseEdits(data, 5, 7)).toEqual(edits);
    expect(chooseEdits(data, 1, 7)).toHaveLength(1);
  });
});

describe("applyEdits / classifyAnswer", () => {
  const edits = chooseEdits(data, 5, 7);
  it("changes only the edited paragraphs, and only the number", () => {
    const after = applyEdits(paragraphs, edits);
    expect(after[1]).toEqual(paragraphs[1]);
    expect(after[2]).toEqual(paragraphs[2]);
    const e = edits.find((x) => x.paragraphId === "0-0")!;
    expect(after[0]!.text).toBe(`The tower was completed in ${e.newValue} for the fair.`);
    expect(after[3]!.text).toContain("after 1920 plans"); // the other number in the paragraph is untouched
  });
  it("classifies answers as new, old or other", () => {
    const e = edits.find((x) => x.paragraphId === "0-0")!;
    expect(classifyAnswer(`In ${e.newValue}.`, e)).toBe("new");
    expect(classifyAnswer("1889", e)).toBe("old");
    expect(classifyAnswer("I don't know", e)).toBe("other");
    expect(classifyAnswer(`${e.newValue}-bit`, e)).toBe("new"); // a number glued to a unit still counts
    expect(classifyAnswer(`about ${e.oldValue}, not ${e.newValue}`, e)).toBe("new"); // the new value wins if both appear
  });
});
