import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { createProvider, registerProvider, type LlmProvider } from "../src/providers/index.js";

const fake = (tokens: string[], promptTokens = 10): LlmProvider => ({
  name: "fake",
  async *stream() {
    for (const t of tokens) yield { type: "token", text: t };
    yield { type: "done", usage: { promptTokens, completionTokens: tokens.length } };
  },
});

describe("createLlm", () => {
  it("joins tokens, reports usage and writes one JSONL line per call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-"));
    const logPath = join(dir, "calls.jsonl");
    const llm = createLlm(loadConfig("configs/base.yaml"), { provider: fake(["Hel", "lo"]), logPath });
    const r = await llm.complete([{ role: "user", content: "hi" }], { queryId: "q1" });
    expect(r.text).toBe("Hello");
    expect(r.usage.completionTokens).toBe(2);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).queryId).toBe("q1");
  });

  it("stops once the spend cap is reached", async () => {
    const cfg = loadConfig("configs/base.yaml");
    cfg.llm.spendCapUsd = 0.00001;
    cfg.llm.pricing = { inputPerMTok: 1_000_000, outputPerMTok: 0 }; // $1 per prompt token
    const llm = createLlm(cfg, { provider: fake(["x"]) });
    await llm.complete([{ role: "user", content: "a" }]);
    await expect(llm.complete([{ role: "user", content: "b" }])).rejects.toThrow(/spend cap/);
  });
});

describe("provider registry", () => {
  it("accepts a user-supplied provider", async () => {
    registerProvider("mine", () => fake(["ok"]));
    const p = createProvider("mine", { model: "whatever" });
    const events = [];
    for await (const e of p.stream({ messages: [], temperature: 0 })) events.push(e);
    expect(events[0]).toEqual({ type: "token", text: "ok" });
  });

  it("rejects unknown names with the list of known ones", () => {
    expect(() => createProvider("nope", { model: "m" })).toThrow(/Known: ollama, openai-compatible/);
  });
});
