import { readLines } from "./lines.js";
import type { ChatRequest, LlmProvider, ProviderFactory, StreamEvent } from "./types.js";

// Any server that speaks POST {baseUrl}/chat/completions with SSE streaming:
// LM Studio, vLLM, llama.cpp server, OpenRouter, Groq, Together, Fireworks, ...
export const openaiCompatible: ProviderFactory = ({ model, baseUrl, apiKeyEnv }): LlmProvider => {
  if (!baseUrl) throw new Error("openai-compatible provider needs llm.baseUrl");
  const key = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (apiKeyEnv && !key) throw new Error(`env var ${apiKeyEnv} is not set`);
  return {
    name: "openai-compatible",
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key && { authorization: `Bearer ${key}` }) },
        signal,
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: true,
          stream_options: { include_usage: true },
          temperature: req.temperature,
          ...(req.seed !== undefined && { seed: req.seed }),
          ...(req.maxTokens !== undefined && { max_tokens: req.maxTokens }),
        }),
      });
      if (!res.ok) throw new Error(`${baseUrl} ${res.status}: ${await res.text()}`);
      let usage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: undefined as number | undefined };
      for await (const line of readLines(res)) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        const j = JSON.parse(data);
        const text = j.choices?.[0]?.delta?.content;
        if (text) yield { type: "token", text };
        if (j.usage) {
          usage = {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            cachedPromptTokens: j.usage.prompt_tokens_details?.cached_tokens,
          };
        }
      }
      yield { type: "done", usage };
    },
  };
};
