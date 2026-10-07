import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
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

// Cost of one call. Cached reads and writes have their own prices; `promptTokens` is the TOTAL prompt, so the
// plain-input part is what is left after taking out the cached reads and the cache writes.
export function callCostUsd(usage: Usage, pricing: Config["llm"]["pricing"]): number {
  if (!pricing) return 0;
  const read = usage.cachedPromptTokens ?? 0;
  const write = usage.cacheCreationTokens ?? 0;
  const plain = Math.max(0, usage.promptTokens - read - write);
  return (
    (plain * pricing.inputPerMTok + write * (pricing.cacheWritePerMTok ?? pricing.inputPerMTok) + read * (pricing.cacheReadPerMTok ?? pricing.inputPerMTok) + usage.completionTokens * pricing.outputPerMTok) / 1e6
  );
}

const DEFAULT_LEDGER = ".cache/spend-ledger.jsonl";

// THE one place the rest of the code calls a model. Provider-agnostic: it times the call, logs one JSONL line, and
// stops once the spend cap is reached. For a real (paid) provider the cap is counted across ALL runs through a ledger
// file, so a hard cap protects a whole project and not just one process.
export function createLlm(full: Config, opts: { logPath?: string; provider?: LlmProvider; ledgerPath?: string } = {}) {
  const config = full.llm;
  const provider =
    opts.provider ?? createProvider(config.provider, { model: config.model, baseUrl: config.baseUrl, apiKeyEnv: config.apiKeyEnv, options: config.options });
  const ledgerPath = opts.ledgerPath ?? (!opts.provider && config.spendCapUsd > 0 ? DEFAULT_LEDGER : undefined);
  const ledgerTotal = () => {
    if (!ledgerPath || !existsSync(ledgerPath)) return 0;
    return readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).reduce((s, l) => s + ((JSON.parse(l) as { costUsd: number }).costUsd ?? 0), 0);
  };
  let spentUsd = ledgerPath ? ledgerTotal() : 0; // everything spent so far, in this and earlier runs

  async function complete(messages: ChatMessage[], meta: Record<string, unknown> = {}): Promise<LlmResult> {
    if (config.spendCapUsd > 0 && spentUsd >= config.spendCapUsd) {
      throw new Error(`spend cap of $${config.spendCapUsd} reached ($${spentUsd.toFixed(4)} spent${ledgerPath ? `, counted from ${ledgerPath}` : ""})`);
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
    const costUsd = callCostUsd(usage, config.pricing);
    spentUsd += costUsd;
    if (ledgerPath && costUsd > 0) {
      mkdirSync(dirname(ledgerPath), { recursive: true });
      appendFileSync(ledgerPath, JSON.stringify({ t: new Date().toISOString(), model: config.model, costUsd }) + "\n");
    }
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

  return { complete, spentUsd: () => spentUsd, cacheMode: provider.cacheMode };
}
