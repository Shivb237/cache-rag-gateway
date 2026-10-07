import { anthropic } from "./anthropic.js";
import { ollama } from "./ollama.js";
import { openaiCompatible } from "./openaiCompatible.js";
import type { LlmProvider, ProviderFactory, ProviderSettings } from "./types.js";

const registry = new Map<string, ProviderFactory>([
  ["ollama", ollama],
  ["anthropic", anthropic],
  ["openai-compatible", openaiCompatible],
]);

// Bring your own model: call this once with your own factory, then use its
// name as `llm.provider` in a config file.
export function registerProvider(name: string, factory: ProviderFactory): void {
  registry.set(name, factory);
}

export function createProvider(name: string, settings: ProviderSettings): LlmProvider {
  const factory = registry.get(name);
  if (!factory) throw new Error(`unknown llm.provider "${name}". Known: ${[...registry.keys()].join(", ")}`);
  return factory(settings);
}

export type * from "./types.js";
