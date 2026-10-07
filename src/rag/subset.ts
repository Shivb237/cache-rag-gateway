import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadSquad, type Paragraph, type Question, type SquadData } from "./squad.js";

// Small seeded random number generator (mulberry32). Same seed gives the same sequence
// of numbers in [0, 1), on every machine. Math.random() cannot be seeded.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates: walk from the end, swap each slot with a random earlier-or-same slot.
// Every ordering is equally likely. Returns a copy and leaves the input alone.
export function shuffle<T>(items: readonly T[], rand: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

// Seeded shuffle picks WHICH POSITIONS in the list are chosen, so the pick is only
// reproducible if the list is the same list. That is why the file hash is recorded below.
export function selectSubset(data: SquadData, seed: number, n: number): SquadData {
  if (n > data.paragraphs.length) {
    throw new Error(`asked for ${n} paragraphs but only ${data.paragraphs.length} exist`);
  }
  const chosen = new Set(
    shuffle(data.paragraphs, mulberry32(seed))
      .slice(0, n)
      .map((p) => p.id),
  );
  // Filter (not the shuffled order) so the output keeps the file's original order: stable diffs.
  return {
    paragraphs: data.paragraphs.filter((p) => chosen.has(p.id)),
    questions: data.questions.filter((q) => chosen.has(q.paragraphId)),
  };
}

export interface SubsetFile {
  source: { file: string; sha256: string };
  seed: number;
  requestedParagraphs: number;
  paragraphs: Paragraph[];
  questions: Question[];
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function buildSubsetFile(rawPath: string, seed: number, n: number): SubsetFile {
  const picked = selectSubset(loadSquad(rawPath), seed, n);
  return { source: { file: rawPath, sha256: sha256File(rawPath) }, seed, requestedParagraphs: n, ...picked };
}

// Call before trusting a saved subset: the raw file must still be the one it was built from.
export function verifySubsetSource(subset: SubsetFile, rawPath: string): void {
  const actual = sha256File(rawPath);
  if (actual !== subset.source.sha256) {
    throw new Error(`dataset changed: subset was built from ${subset.source.sha256}, ${rawPath} is now ${actual}`);
  }
}

// Reads a saved subset. Cast, not validated: we wrote this file ourselves, and
// verifySubsetSource() already protects against the raw data having changed.
export function loadSubsetFile(path: string): SubsetFile {
  return JSON.parse(readFileSync(path, "utf8")) as SubsetFile;
}
