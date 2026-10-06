import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.js";
import { createProvider, type ChatMessage, type LlmProvider, type Usage } from "./providers/index.js";

export interface LlmResult {
  text: string;
  ttftMs: number; // time to first token
  totalMs: number;
  usage: Usage;
  costUsd: number;
}

// THE one place the rest of the code calls a model. Provider-agnostic: it times
// the call, logs one JSONL line, and stops once the spend cap is reached.
export function createLlm(full: Config, opts: { logPath?: string; provider?: LlmProvider } = {}) {
  const config = full.llm;
  const provider =
    opts.provider ?? createProvider(config.provider, { model: config.model, baseUrl: config.baseUrl, apiKeyEnv: config.apiKeyEnv });
  let spentUsd = 0;

  async function complete(messages: ChatMessage[], meta: Record<string, unknown> = {}): Promise<LlmResult> {
    if (config.spendCapUsd > 0 && spentUsd >= config.spendCapUsd) {
      throw new Error(`spend cap of $${config.spendCapUsd} reached ($${spentUsd.toFixed(4)} spent)`);
    }
    const start = performance.now();
    let ttftMs = -1;
    let text = "";
    let usage: Usage = { promptTokens: 0, completionTokens: 0 };
    for await (const ev of provider.stream({ messages, temperature: config.temperature, seed: full.seed })) {
      if (ev.type === "token") {
        if (ttftMs < 0) ttftMs = performance.now() - start;
        text += ev.text;
      } else usage = ev.usage;
    }
    const totalMs = performance.now() - start;
    const p = config.pricing;
    const costUsd = p ? (usage.promptTokens * p.inputPerMTok + usage.completionTokens * p.outputPerMTok) / 1e6 : 0;
    spentUsd += costUsd;
    const result: LlmResult = { text, ttftMs: Math.max(ttftMs, 0), totalMs, usage, costUsd };
    if (opts.logPath) {
      mkdirSync(dirname(opts.logPath), { recursive: true });
      appendFileSync(
        opts.logPath,
        JSON.stringify({ t: new Date().toISOString(), provider: provider.name, model: config.model, ...meta, ttftMs: result.ttftMs, totalMs, usage, costUsd }) + "\n",
      );
    }
    return result;
  }

  return { complete, spentUsd: () => spentUsd };
}
