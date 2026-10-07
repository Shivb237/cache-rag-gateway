import { readLines } from "./lines.js";
import type { ChatRequest, LlmProvider, ProviderFactory, StreamEvent } from "./types.js";

// Native /api/chat, not the OpenAI-compatible route: only the native API reports
// prompt_eval_count / prompt_eval_duration, which Milestone 6 needs.
export const ollama: ProviderFactory = ({ model, baseUrl }): LlmProvider => {
  const host = baseUrl ?? process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
  return {
    name: "ollama",
    cacheMode: "automatic",
    async *stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
      const res = await fetch(`${host}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          model,
          messages: req.messages,
          stream: true,
          options: {
            temperature: req.temperature,
            ...(req.seed !== undefined && { seed: req.seed }),
            ...(req.maxTokens !== undefined && { num_predict: req.maxTokens }),
          },
        }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
      for await (const line of readLines(res)) {
        const j = JSON.parse(line);
        if (j.error) throw new Error(`ollama: ${j.error}`);
        if (j.message?.content) yield { type: "token", text: j.message.content };
        if (j.done) {
          yield {
            type: "done",
            usage: {
              promptTokens: j.prompt_eval_count ?? 0,
              completionTokens: j.eval_count ?? 0,
              promptEvalMs: j.prompt_eval_duration !== undefined ? j.prompt_eval_duration / 1e6 : undefined,
            },
          };
        }
      }
    },
  };
};
