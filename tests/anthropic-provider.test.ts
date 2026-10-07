import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAnthropicProvider } from "../src/providers/anthropic.js";
import { callCostUsd, createLlm } from "../src/llm.js";
import { loadConfig } from "../src/config.js";
import { buildMessages } from "../src/rag/generate.js";
import type { ChatMessage, LlmProvider, StreamEvent } from "../src/providers/index.js";

// A fake SDK client that records the request and replays a short stream.
function fakeClient(usage = { input_tokens: 40, output_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 }, stop_reason: string = "end_turn") {
  const seen: Record<string, unknown>[] = [];
  return {
    seen,
    client: {
      messages: {
        stream(params: unknown) {
          seen.push(params as Record<string, unknown>);
          const events = [{ type: "content_block_delta", delta: { type: "text_delta", text: "Den" } }, { type: "content_block_delta", delta: { type: "text_delta", text: "ver" } }, { type: "message_stop" }];
          return Object.assign((async function* () { for (const e of events) yield e; })(), { finalMessage: async () => ({ model: "claude-sonnet-5-5", stop_reason, usage }) });
        },
      },
    },
  };
}
const collect = async (p: LlmProvider, messages: ChatMessage[]) => { const out: StreamEvent[] = []; for await (const e of p.stream({ messages, temperature: 0 })) out.push(e); return out; };
const settings = { model: "claude-sonnet-5-5", options: { thinking: "between_tools", sendTemperature: false } };
const passages = [{ id: "0-0", title: "T", text: "The Broncos won." }];

describe("anthropic provider", () => {
  it("streams tokens and maps usage: total prompt = uncached + cache reads + cache writes", async () => {
    const f = fakeClient();
    const events = await collect(createAnthropicProvider(settings, f.client), buildMessages("Who won?", passages));
    expect(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text).join("")).toBe("Denver");
    expect(events.at(-1)).toEqual({ type: "done", usage: { promptTokens: 940, completionTokens: 5, cachedPromptTokens: 900, cacheCreationTokens: 0, servedModel: "claude-sonnet-5-5" } });
  });
  it("does not send temperature, and turns thinking off with between_tools", async () => {
    const f = fakeClient();
    await collect(createAnthropicProvider(settings, f.client), buildMessages("Q?", passages));
    expect(f.seen[0]).not.toHaveProperty("temperature");
    expect(f.seen[0]).toMatchObject({ model: "claude-sonnet-5-5", thinking: { type: "between_tools" }, max_tokens: 128 });
    const t = fakeClient();
    await collect(createAnthropicProvider({ ...settings, options: { sendTemperature: true } }, t.client), buildMessages("Q?", passages));
    expect(t.seen[0]).toMatchObject({ temperature: 0 });
  });
  it("places a cache breakpoint only after the passages, and only when markers are requested", async () => {
    const on = fakeClient(); const off = fakeClient();
    await collect(createAnthropicProvider(settings, on.client), buildMessages("Who?", passages, { cacheMarkers: true }));
    await collect(createAnthropicProvider(settings, off.client), buildMessages("Who?", passages));
    const blocks = (on.seen[0]!.messages as { content: { text: string; cache_control?: unknown }[] }[])[0]!.content;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: "[1] The Broncos won.\n\n", cache_control: { type: "ephemeral" } });
    expect(blocks[1]).toEqual({ type: "text", text: "Question: Who?" }); // the varying question sits AFTER the breakpoint
    expect(JSON.stringify(off.seen[0])).not.toContain("cache_control");
    expect(typeof (off.seen[0]!.messages as { content: unknown }[])[0]!.content).toBe("string");
  });
  it("reports a refusal as a result with its category, not as an error", async () => {
    const f = fakeClient(undefined, "refusal");
    const events = await collect(createAnthropicProvider(settings, f.client), buildMessages("Q?", passages));
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { stopReason: "refusal", refusalCategory: null } });
  });
  it("fails clearly when no API key is configured", () => {
    const saved = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    try { expect(() => createAnthropicProvider(settings)).toThrow(/ANTHROPIC_API_KEY/); } finally { if (saved) process.env.ANTHROPIC_API_KEY = saved; }
  });
});

describe("cost and the persistent spend cap", () => {
  const pricing = { inputPerMTok: 2, outputPerMTok: 10, cacheWritePerMTok: 2.5, cacheReadPerMTok: 0.2 };
  it("prices plain input, cache writes, cache reads and output separately", () => {
    expect(callCostUsd({ promptTokens: 1000, completionTokens: 10, cachedPromptTokens: 0, cacheCreationTokens: 0 }, pricing)).toBeCloseTo((1000 * 2 + 10 * 10) / 1e6);
    expect(callCostUsd({ promptTokens: 1000, completionTokens: 10, cachedPromptTokens: 900, cacheCreationTokens: 0 }, pricing)).toBeCloseTo((100 * 2 + 900 * 0.2 + 10 * 10) / 1e6);
    expect(callCostUsd({ promptTokens: 1000, completionTokens: 10, cachedPromptTokens: 0, cacheCreationTokens: 900 }, pricing)).toBeCloseTo((100 * 2 + 900 * 2.5 + 10 * 10) / 1e6);
    expect(callCostUsd({ promptTokens: 5, completionTokens: 5 }, undefined)).toBe(0);
  });
  it("counts spend across separate runs through the ledger file", async () => {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), "ledger-")), "spend.jsonl");
    const cfg = loadConfig("configs/base.yaml");
    cfg.llm.spendCapUsd = 0.0004;
    cfg.llm.pricing = { inputPerMTok: 2, outputPerMTok: 10 };
    const provider: LlmProvider = { name: "fake", async *stream() { yield { type: "token", text: "x" }; yield { type: "done", usage: { promptTokens: 100, completionTokens: 10 } }; } }; // $0.0003 per call
    const run1 = createLlm(cfg, { provider, ledgerPath });
    await run1.complete([{ role: "user", content: "a" }]); // $0.0003, under the cap
    const run2 = createLlm(cfg, { provider, ledgerPath }); // a new process would start here
    expect(run2.spentUsd()).toBeCloseTo(0.0003);
    await run2.complete([{ role: "user", content: "b" }]); // total $0.0006, now over the cap
    const run3 = createLlm(cfg, { provider, ledgerPath });
    await expect(run3.complete([{ role: "user", content: "c" }])).rejects.toThrow(/spend cap/);
    expect(readFileSync(ledgerPath, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
