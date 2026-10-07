// The contract a model must satisfy to plug into the gateway.
// Implement `LlmProvider`, register it, and select it by name in configs/*.yaml.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  // Optional split of `content` into parts. A provider with explicit prompt caching marks a cache breakpoint
  // after each part with `cache: true`; every other provider ignores this and uses `content`.
  parts?: { text: string; cache?: boolean }[];
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature: number;
  seed?: number;
  maxTokens?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  // Optional: only providers that report them. Milestone 6 (prefix/KV caching) reads these.
  promptEvalMs?: number;
  cachedPromptTokens?: number; // tokens read from the provider's prompt cache
  cacheCreationTokens?: number; // tokens written to it (billed at a premium)
  servedModel?: string; // the model id the API says actually answered
  stopReason?: string; // "refusal" when the model declined to answer
  refusalCategory?: string | null; // why, when the API says
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: Usage };

export interface LlmProvider {
  readonly name: string;
  // "automatic": the server reuses any common prompt start by itself (Ollama). "explicit": you must mark
  // cache breakpoints in the request (Claude API).
  readonly cacheMode?: "automatic" | "explicit";
  stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}

// Everything a provider factory may need from the `llm:` block of the config.
export interface ProviderSettings {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string; // name of the env var holding the key, never the key itself
  options?: Record<string, unknown>; // provider-specific settings, e.g. { thinking: "between_tools" }
}

export type ProviderFactory = (settings: ProviderSettings) => LlmProvider;
