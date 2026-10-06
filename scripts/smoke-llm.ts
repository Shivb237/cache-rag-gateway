// Sends one real question through the gateway's LLM wrapper and prints what came back.
// Also checks the running model's digest against configs/base.yaml.
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";

const config = loadConfig("configs/base.yaml");
const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";

const tags = (await (await fetch(`${host}/api/tags`)).json()) as { models: { name: string; digest: string }[] };
const found = tags.models.find((m) => m.name === config.llm.model);
if (!found) throw new Error(`model ${config.llm.model} is not pulled`);
if (config.llm.modelDigest && found.digest !== config.llm.modelDigest) {
  throw new Error(`digest mismatch: config pins ${config.llm.modelDigest}, Ollama has ${found.digest}`);
}
console.log("model ok:", found.name, found.digest.slice(0, 12));

const llm = createLlm(config, { logPath: "runs/tmp/smoke.jsonl" });
const r = await llm.complete(
  [
    { role: "system", content: "Answer in one short sentence using only the passage." },
    { role: "user", content: "Passage: The Eiffel Tower was completed in 1889 for the World's Fair in Paris.\nQuestion: When was the Eiffel Tower completed?" },
  ],
  { purpose: "smoke" },
);
console.log("answer:", r.text.trim());
console.log({ ttftMs: Math.round(r.ttftMs), totalMs: Math.round(r.totalMs), usage: r.usage });
