import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cosine } from "../embed.js";
import type { Paragraph } from "./squad.js";

// What a saved index was built from. If any of this differs from the current setup,
// the stored vectors are stale (different model or data), so we refuse to use them.
export interface IndexMeta {
  model: string;
  revision: string;
  dim: number;
  count: number;
  subsetSha256: string;
}

export interface VectorIndex {
  meta: IndexMeta;
  ids: string[]; // ids[i] is the paragraph id of vectors[i]
  vectors: Float32Array[];
}

export interface Hit {
  id: string;
  score: number; // cosine similarity (vectors are unit length, so this is a dot product)
}

type EmbedFn = (texts: string[], kind: "query" | "passage") => Promise<Float32Array[]>;

// Embed every paragraph (as a "passage", no query prefix) in small batches.
export async function buildIndex(
  paragraphs: Paragraph[],
  embed: EmbedFn,
  source: Pick<IndexMeta, "model" | "revision" | "subsetSha256">,
  batchSize = 32,
): Promise<VectorIndex> {
  const vectors: Float32Array[] = [];
  for (let i = 0; i < paragraphs.length; i += batchSize) {
    const batch = paragraphs.slice(i, i + batchSize);
    vectors.push(...(await embed(batch.map((p) => p.text), "passage")));
  }
  return {
    meta: { ...source, dim: vectors[0]?.length ?? 0, count: vectors.length },
    ids: paragraphs.map((p) => p.id),
    vectors,
  };
}

// Brute force: score every vector, sort, keep the top k. Fine for hundreds or thousands of vectors.
// Ties break on id so results never depend on sort stability.
export function search(index: VectorIndex, query: Float32Array, k: number): Hit[] {
  const hits = index.vectors.map((v, i) => ({ id: index.ids[i]!, score: cosine(v, query) }));
  hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  return hits.slice(0, k);
}

// Two files: <path>.json (meta + ids) and <path>.f32 (all vectors, back to back, float32).
export function saveIndex(index: VectorIndex, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.json`, JSON.stringify({ meta: index.meta, ids: index.ids }));
  const flat = new Float32Array(index.meta.count * index.meta.dim);
  index.vectors.forEach((v, i) => flat.set(v, i * index.meta.dim));
  writeFileSync(`${path}.f32`, new Uint8Array(flat.buffer));
}

export function loadIndex(path: string): VectorIndex {
  const { meta, ids } = JSON.parse(readFileSync(`${path}.json`, "utf8")) as { meta: IndexMeta; ids: string[] };
  const bytes = readFileSync(`${path}.f32`);
  // slice() copies into a fresh, aligned buffer (a Buffer's byteOffset may not be a multiple of 4)
  const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  if (flat.length !== meta.count * meta.dim) throw new Error(`index file is corrupt: ${flat.length} floats, expected ${meta.count * meta.dim}`);
  const vectors = Array.from({ length: meta.count }, (_, i) => flat.slice(i * meta.dim, (i + 1) * meta.dim));
  return { meta, ids, vectors };
}

export function assertIndexMatches(index: VectorIndex, expected: Pick<IndexMeta, "model" | "revision" | "subsetSha256">): void {
  for (const key of ["model", "revision", "subsetSha256"] as const) {
    if (index.meta[key] !== expected[key]) {
      throw new Error(`stale index: ${key} was ${index.meta[key]}, now ${expected[key]}. Rebuild it.`);
    }
  }
}
