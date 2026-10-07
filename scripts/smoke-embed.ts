// Embeds a few sentences and prints how similar they are. First run downloads the model (~133 MB).
import { loadConfig } from "../src/config.js";
import { cosine, createEmbedder } from "../src/embed.js";

const config = loadConfig("configs/base.yaml");
const { embed } = createEmbedder(config.embedding, { logPath: "runs/tmp/smoke-embed.jsonl" });

const sentences = [
  "How tall is the Eiffel Tower?",
  "What is the height of the Eiffel Tower?", // paraphrase of the first
  "Who wrote Pride and Prejudice?", // unrelated
];

let t = performance.now();
const v = await embed(sentences, "query");
console.log(`first call (includes model load): ${Math.round(performance.now() - t)} ms`);
console.log("vector dimension:", v[0]!.length);

t = performance.now();
await embed(sentences, "query");
console.log(`second call (model already loaded): ${Math.round(performance.now() - t)} ms`);

const pair = (i: number, j: number) => cosine(v[i]!, v[j]!).toFixed(3);
console.log("paraphrase  (0 vs 1):", pair(0, 1));
console.log("unrelated   (0 vs 2):", pair(0, 2));
