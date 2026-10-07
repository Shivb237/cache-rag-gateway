// Do the subset's paragraphs fit in bge-small's input limit (512 tokens)? If yes, no chunking needed.
import { AutoTokenizer, env } from "@huggingface/transformers";
import { loadConfig } from "../src/config.js";
import { loadSubsetFile } from "../src/rag/subset.js";

const config = loadConfig("configs/base.yaml");
env.cacheDir = ".cache/models";
const tok = await AutoTokenizer.from_pretrained(config.embedding.model, { revision: config.embedding.revision });
const subset = loadSubsetFile(config.dataset.subsetPath);

const lens = subset.paragraphs.map((p) => ({ id: p.id, tokens: tok.encode(p.text).length })).sort((a, b) => a.tokens - b.tokens);
const pct = (q: number) => lens[Math.min(lens.length - 1, Math.floor(q * lens.length))]!.tokens;
console.log(`paragraphs: ${lens.length}`);
console.log(`tokens: min ${lens[0]!.tokens}, median ${pct(0.5)}, p95 ${pct(0.95)}, max ${lens.at(-1)!.tokens} (id ${lens.at(-1)!.id})`);
console.log(`over 512 tokens: ${lens.filter((l) => l.tokens > 512).length}`);
