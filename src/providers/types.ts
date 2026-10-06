// The contract a model must satisfy to plug into the gateway.
// Implement `LlmProvider`, register it, and select it by name in configs/*.yaml.

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  cachedPromptTokens?: number;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "done"; usage: Usage };

export interface LlmProvider {
  readonly name: string;
  stream(req: ChatRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent>;
}

// Everything a provider factory may need from the `llm:` block of the config.
export interface ProviderSettings {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string; // name of the env var holding the key, never the key itself
}

export type ProviderFactory = (settings: ProviderSettings) => LlmProvider;
