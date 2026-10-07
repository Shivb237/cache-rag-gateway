import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

// Every cache layer is switchable so each ablation is a small YAML override.
const schema = z.object({
  seed: z.number().int(),
  llm: z.object({
    provider: z.string(), // "ollama", "openai-compatible", or any name registered in src/providers
    model: z.string(),
    baseUrl: z.string().url().optional(),
    modelDigest: z.string().nullish(), // local models: full digest, so a silently changed model is detected
    apiKeyEnv: z.string().optional(), // env var name, never the key itself
    temperature: z.number(),
    spendCapUsd: z.number().nonnegative(), // 0 = no cap (local models); enforced in src/llm.ts
    pricing: z
      .object({ inputPerMTok: z.number(), outputPerMTok: z.number(), cacheWritePerMTok: z.number().optional(), cacheReadPerMTok: z.number().optional() })
      .optional(), // USD per million tokens
    options: z.record(z.string(), z.unknown()).optional(), // provider-specific settings
  }),
  embedding: z.object({
    model: z.string(),
    revision: z.string(), // pinned for reproducibility
  }),
  dataset: z.object({
    squadPath: z.string(), // raw dev set, downloaded by hand, gitignored
    subsetPath: z.string(), // the fixed subset every run uses, committed
    subsetParagraphs: z.number().int().positive(), // size of the paragraph pile
    indexPath: z.string(), // vector index of the subset (derived, gitignored); writes <path>.json and <path>.f32
  }),
  prompt: z.object({
    passageOrder: z.enum(["relevance", "sorted"]), // relevance = best match first; sorted = canonical order by paragraph id (same set -> same text -> reusable prefix)
  }),
  eval: z.object({
    sampleQuestions: z.number().int().positive(), // how many subset questions each run asks
    warmupCalls: z.number().int().nonnegative(), // extra calls before measuring, so model load time is not in the numbers
  }),
  retrieval: z.object({ topK: z.number().int().positive() }),
  caches: z.object({
    exact: z.object({ enabled: z.boolean(), ttlSeconds: z.number().int().positive() }),
    semantic: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1), ttlSeconds: z.number().int().positive() }),
    retrieval: z.object({ enabled: z.boolean(), ttlSeconds: z.number().int().positive(), threshold: z.number().min(0).max(1) }),
    promptPrefix: z.object({ enabled: z.boolean() }),
  }),
});

export type Config = z.infer<typeof schema>;

function merge(base: unknown, over: unknown): unknown {
  if (typeof base === "object" && base && typeof over === "object" && over && !Array.isArray(over)) {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const [k, v] of Object.entries(over)) out[k] = merge(out[k], v);
    return out;
  }
  return over;
}

export function loadConfig(basePath: string, overridePath?: string): Config {
  let raw: unknown = parse(readFileSync(basePath, "utf8"));
  // Several overrides can be given, comma-separated; later ones win (e.g. a provider file, then an ablation file).
  for (const file of overridePath ? overridePath.split(",") : []) raw = merge(raw, parse(readFileSync(file.trim(), "utf8")));
  return schema.parse(raw);
}
