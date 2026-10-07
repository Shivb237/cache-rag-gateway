import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, ChatRequest, LlmProvider, ProviderFactory, StreamEvent } from "./types.js";

type StreamingClient = { messages: { stream(params: unknown, options?: { signal?: AbortSignal }): AsyncIterable<unknown> & { finalMessage(): Promise<unknown> } } };

interface FinalMessage {
  model?: string;
  stop_reason?: string | null;
  stop_details?: { category?: string | null } | null;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
}

const toContent = (m: ChatMessage) =>
  m.parts ? m.parts.map((p) => ({ type: "text", text: p.text, ...(p.cache && { cache_control: { type: "ephemeral" } }) })) : m.content;

// Claude API provider. Prompt caching is explicit here: parts marked `cache: true` get a cache_control breakpoint.
// `options` (from the config): thinking = "between_tools" turns thinking off on Sonnet 5.5; effort = low|medium|high|...;
// sendTemperature = true only for models that accept sampling parameters (the newest models reject them).
export function createAnthropicProvider(settings: Parameters<ProviderFactory>[0], injected?: StreamingClient): LlmProvider {
  const opts = (settings.options ?? {}) as { thinking?: string; effort?: string; sendTemperature?: boolean };
  const client: StreamingClient =
    injected ??
    (process.env.ANTHROPIC_API_KEY
      ? (new Anthropic({ maxRetries: 6 }) as unknown as StreamingClient)
      : (() => { throw new Error("ANTHROPIC_API_KEY is not set. Put it in .env (never in chat or in git)."); })());
  return {
    name: "anthropic",
    cacheMode: "explicit",
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      const system = req.messages.filter((m) => m.role === "system");
      const params: Record<string, unknown> = {
        model: settings.model,
        max_tokens: req.maxTokens ?? 128,
        messages: req.messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: toContent(m) })),
        ...(system.length > 0 && { system: system.flatMap((m) => (m.parts ? m.parts.map((p) => ({ type: "text", text: p.text, ...(p.cache && { cache_control: { type: "ephemeral" } }) })) : [{ type: "text", text: m.content }])) }),
        ...(opts.thinking && { thinking: { type: opts.thinking } }),
        ...(opts.effort && { output_config: { effort: opts.effort } }),
        ...(opts.sendTemperature === true && { temperature: req.temperature }),
      };
      const stream = client.messages.stream(params, { signal });
      for await (const ev of stream as AsyncIterable<{ type: string; delta?: { type: string; text?: string } }>) {
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "token", text: ev.delta.text };
      }
      const msg = (await stream.finalMessage()) as FinalMessage;
      // A refusal is a result, not a crash: it is reported in the usage and scored as a wrong (empty) answer.
      const refusal = msg.stop_reason === "refusal" ? { stopReason: "refusal", refusalCategory: msg.stop_details?.category ?? null } : {};
      const read = msg.usage.cache_read_input_tokens ?? 0;
      const write = msg.usage.cache_creation_input_tokens ?? 0;
      yield {
        type: "done",
        usage: {
          promptTokens: msg.usage.input_tokens + read + write, // total prompt; input_tokens alone is only the uncached remainder
          completionTokens: msg.usage.output_tokens,
          cachedPromptTokens: read,
          cacheCreationTokens: write,
          servedModel: msg.model,
          ...refusal,
        },
      };
    },
  };
}

export const anthropic: ProviderFactory = (settings) => createAnthropicProvider(settings);
