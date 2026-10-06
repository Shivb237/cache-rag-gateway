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
    modelDigest: z.string().optional(), // local models: full digest, so a silently changed model is detected
    apiKeyEnv: z.string().optional(), // env var name, never the key itself
    temperature: z.number(),
    spendCapUsd: z.number().nonnegative(), // 0 = no cap (local models); enforced in src/llm.ts
    pricing: z.object({ inputPerMTok: z.number(), outputPerMTok: z.number() }).optional(), // USD per million tokens
  }),
  embedding: z.object({
    model: z.string(),
    revision: z.string(), // pinned for reproducibility
  }),
  retrieval: z.object({ topK: z.number().int().positive() }),
  caches: z.object({
    exact: z.object({ enabled: z.boolean(), ttlSeconds: z.number().int().positive() }),
    semantic: z.object({ enabled: z.boolean(), threshold: z.number().min(0).max(1) }),
    retrieval: z.object({ enabled: z.boolean(), ttlSeconds: z.number().int().positive() }),
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
  if (overridePath) raw = merge(raw, parse(readFileSync(overridePath, "utf8")));
  return schema.parse(raw);
}
