// Probes how Ollama reuses a prompt prefix (its KV cache). Sends hand-picked prompts straight to
// /api/chat and prints the numbers Ollama reports: tokens it had to process and how long that took.
// Nothing here is a benchmark; it shows WHAT is cached, so we can design the real experiment.
// Usage: npx tsx scripts/probe-ollama-cache.ts
import { loadConfig } from "../src/config.js";
import { createEmbedder } from "../src/embed.js";
import { buildMessages } from "../src/rag/generate.js";
import { loadIndex, search } from "../src/rag/index.js";
import { loadSubsetFile } from "../src/rag/subset.js";
import type { ChatMessage } from "../src/providers/index.js";

const config = loadConfig("configs/base.yaml");
const host = process.env.OLLAMA_HOST ?? "http://127.0.0.1:11434";
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
const byId = new Map(subset.paragraphs.map((p) => [p.id, p]));
const { embed } = createEmbedder(config.embedding);

async function call(label: string, messages: ChatMessage[]) {
  const res = await fetch(`${host}/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: config.llm.model, messages, stream: false, options: { temperature: 0, seed: config.seed, num_predict: 8 } }),
  });
  const j = (await res.json()) as Record<string, number>;
  const ms = (ns: number | undefined) => (ns === undefined ? "n/a" : (ns / 1e6).toFixed(0));
  console.log(`${label.padEnd(44)} prompt tokens processed ${String(j.prompt_eval_count ?? "n/a").padStart(5)} | prompt time ${ms(j.prompt_eval_duration).padStart(5)} ms | model load ${ms(j.load_duration).padStart(4)} ms | answer time ${ms(j.eval_duration).padStart(4)} ms`);
  return j;
}
const promptFor = async (questionText: string, order: "relevance" | "sorted" = "relevance") => {
  const [qv] = await embed([questionText], "query");
  let ids = search(index, qv!, config.retrieval.topK).map((h) => h.id);
  if (order === "sorted") ids = [...ids].sort();
  return { messages: buildMessages(questionText, ids.map((id) => byId.get(id)!)), ids };
};

// Two questions about the same paragraph, and one about something else.
const q1 = subset.questions[0]!;
const q2 = subset.questions.find((q) => q.paragraphId === q1.paragraphId && q.id !== q1.id)!;
const q3 = subset.questions.find((q) => q.paragraphId !== q1.paragraphId && !subset.paragraphs.find((p) => p.id === q.paragraphId)!.title.startsWith(byId.get(q1.paragraphId)!.title))!;
const X = await promptFor(q1.text), X2 = await promptFor(q2.text), Y = await promptFor(q3.text);
console.log(`X : ${q1.text}\nX2: ${q2.text}  (same paragraph as X)\nY : ${q3.text}  (different article)`);
console.log(`retrieved ids  X: ${X.ids.join(",")}\n               X2: ${X2.ids.join(",")}\n               Y: ${Y.ids.join(",")}\n`);

await call("warm-up (loads the model, result ignored)", Y.messages);
console.log("\n[1] the identical prompt X, three times:");
await call("X  (first time)", X.messages);
await call("X  (second time, identical)", X.messages);
await call("X  (third time, identical)", X.messages);

console.log("\n[2] same instruction + passages, different question at the end:");
const sameCtx = buildMessages(q2.text, X.ids.map((id) => byId.get(id)!)); // passages of X, question of X2
await call("X  (reset the cache to X)", X.messages);
await call("X' (X's passages, a different question)", sameCtx);

console.log("\n[3] the same passages in a different order (relevance order vs sorted by id):");
const Xsorted = await promptFor(q1.text, "sorted");
await call("X  (relevance order)", X.messages);
await call("X  (passages sorted by id)", Xsorted.messages);

console.log("\n[4] two unrelated prompts interleaved, X Y X Y:");
await call("X", X.messages);
await call("Y", Y.messages);
await call("X  (again, after Y)", X.messages);
await call("Y  (again, after X)", Y.messages);

console.log("\n[5] caching defeated on purpose (a random word first), same prompt:");
for (let i = 0; i < 2; i++) {
  const m = X.messages.map((x, k) => (k === 0 ? { ...x, content: `Session ${Math.random().toString(36).slice(2)}. ${x.content}` } : x));
  await call(`X with a random prefix (${i + 1})`, m);
}
