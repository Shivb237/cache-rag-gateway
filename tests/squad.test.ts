import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSquad } from "../src/rag/squad.js";

// Two articles, three paragraphs, four questions: small enough to check by hand.
const fixture = {
  data: [
    {
      title: "Article_A",
      paragraphs: [
        {
          context: "Paragraph A0.",
          qas: [
            { id: "q1", question: "Q one?", answers: [{ text: "x", answer_start: 0 }, { text: "x again", answer_start: 0 }] },
            { id: "q2", question: "Q two?", answers: [{ text: "y", answer_start: 3 }] },
          ],
        },
        {
          context: "Paragraph A1.",
          qas: [{ id: "q3", question: "Q three?", answers: [{ text: "z", answer_start: 1 }] }],
        },
      ],
    },
    {
      title: "Article_B",
      paragraphs: [
        { context: "Paragraph B0.", qas: [{ id: "q4", question: "Q four?", answers: [{ text: "w", answer_start: 2 }] }] },
      ],
    },
  ],
};

function writeJson(value: unknown): string {
  const path = join(mkdtempSync(join(tmpdir(), "squad-")), "squad.json");
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe("loadSquad (fixture)", () => {
  const { paragraphs, questions } = loadSquad(writeJson(fixture));

  it("flattens articles into paragraphs and questions", () => {
    expect(paragraphs).toHaveLength(3);
    expect(questions).toHaveLength(4);
  });

  it("builds paragraph ids from article and paragraph position", () => {
    expect(paragraphs.map((p) => p.id)).toEqual(["0-0", "0-1", "1-0"]);
    expect(paragraphs[2]).toEqual({ id: "1-0", title: "Article_B", text: "Paragraph B0." });
  });

  it("links each question to the paragraph it was nested in", () => {
    const byId = Object.fromEntries(questions.map((q) => [q.id, q.paragraphId]));
    expect(byId).toEqual({ q1: "0-0", q2: "0-0", q3: "0-1", q4: "1-0" });
  });

  it("keeps every gold answer as a plain string", () => {
    expect(questions.find((q) => q.id === "q1")?.answers).toEqual(["x", "x again"]);
  });
});

describe("loadSquad (bad input)", () => {
  it("throws when a paragraph is missing its text", () => {
    const bad = { data: [{ title: "T", paragraphs: [{ qas: [] }] }] };
    expect(() => loadSquad(writeJson(bad))).toThrow();
  });

  it("throws when the file is not the SQuAD shape at all", () => {
    expect(() => loadSquad(writeJson({ hello: "world" }))).toThrow();
  });
});

// The real file is gitignored (downloaded by hand), so skip this on a fresh clone.
const realPath = "data/raw/dev-v1.1.json";
describe("loadSquad (real dev set)", () => {
  it.skipIf(!existsSync(realPath))("matches the published SQuAD v1.1 dev counts", () => {
    const { paragraphs, questions } = loadSquad(realPath);
    expect(paragraphs).toHaveLength(2067);
    expect(questions).toHaveLength(10570);
    const ids = new Set(paragraphs.map((p) => p.id));
    expect(questions.every((q) => ids.has(q.paragraphId))).toBe(true);
  });
});
