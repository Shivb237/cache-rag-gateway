import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertIndexMatches, buildIndex, loadIndex, saveIndex, search, type VectorIndex } from "../src/rag/index.js";
import { buildMessages } from "../src/rag/generate.js";

const unit = (...xs: number[]) => {
  const n = Math.hypot(...xs);
  return Float32Array.from(xs.map((x) => x / n));
};

const index: VectorIndex = {
  meta: { model: "m", revision: "r", dim: 2, count: 3, subsetSha256: "s" },
  ids: ["b", "a", "c"],
  vectors: [unit(1, 0), unit(1, 0), unit(0, 1)], // "b" and "a" are identical on purpose
};

describe("search", () => {
  it("ranks by similarity", () => {
    const hits = search(index, unit(0, 1), 3);
    expect(hits[0]?.id).toBe("c");
    expect(hits[0]?.score).toBeCloseTo(1);
  });
  it("breaks ties by id, so order never depends on sort stability", () => {
    expect(search(index, unit(1, 0), 2).map((h) => h.id)).toEqual(["a", "b"]);
  });
  it("returns everything when k is larger than the index", () => {
    expect(search(index, unit(1, 0), 10)).toHaveLength(3);
  });
});

describe("buildIndex", () => {
  it("keeps paragraph order across batches and embeds them as passages", async () => {
    const kinds: string[] = [];
    const embed = async (texts: string[], kind: "query" | "passage") => {
      kinds.push(kind);
      return texts.map((t) => Float32Array.from([t.length, 1]));
    };
    const paragraphs = ["a", "bb", "ccc", "dddd", "eeeee"].map((text, i) => ({ id: `p${i}`, title: "T", text }));
    const built = await buildIndex(paragraphs, embed, { model: "m", revision: "r", subsetSha256: "s" }, 2);
    expect(built.ids).toEqual(["p0", "p1", "p2", "p3", "p4"]);
    expect(built.vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
    expect(built.meta).toMatchObject({ dim: 2, count: 5 });
    expect(new Set(kinds)).toEqual(new Set(["passage"]));
    expect(kinds).toHaveLength(3); // 5 paragraphs in batches of 2
  });
});

describe("save / load / stale check", () => {
  const path = join(mkdtempSync(join(tmpdir(), "idx-")), "idx");
  it("round-trips exactly", () => {
    saveIndex(index, path);
    const back = loadIndex(path);
    expect(back.meta).toEqual(index.meta);
    expect(back.ids).toEqual(index.ids);
    expect(back.vectors.map((v) => [...v])).toEqual(index.vectors.map((v) => [...v]));
  });
  it("accepts a matching setup and rejects a changed model, revision or data", () => {
    const ok = { model: "m", revision: "r", subsetSha256: "s" };
    expect(() => assertIndexMatches(index, ok)).not.toThrow();
    expect(() => assertIndexMatches(index, { ...ok, revision: "r2" })).toThrow(/stale index: revision/);
    expect(() => assertIndexMatches(index, { ...ok, subsetSha256: "other" })).toThrow(/stale index: subsetSha256/);
  });
});

describe("buildMessages", () => {
  it("puts fixed instructions first and the question last", () => {
    const m = buildMessages("Who?", [{ id: "0-0", title: "T", text: "Alice did it." }]);
    expect(m[0]?.role).toBe("system");
    expect(m[1]?.content).toBe("[1] Alice did it.\n\nQuestion: Who?");
  });
});
