// Asks the local model to paraphrase each eval question. These become the "should hit" cases
// for the semantic cache. Output: data/eval/paraphrases.json (committed, so runs are reproducible).
// Usage: npx tsx scripts/gen-paraphrases.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { loadConfig } from "../src/config.js";
import { createLlm } from "../src/llm.js";
import { normalizeAnswer } from "../src/eval/metrics.js";
import { loadSubsetFile, mulberry32, shuffle } from "../src/rag/subset.js";

const PROMPT_VERSION = "paraphrase-v1";
const SYSTEM =
  "You rewrite questions. Rewrite the user's question using different words and sentence structure " +
  "but keep exactly the same meaning. Keep every name, number and date unchanged. " +
  "Reply with only the rewritten question.";

const config = loadConfig("configs/base.yaml");
const subset = loadSubsetFile(config.dataset.subsetPath);
// The same 200 questions the baseline asked (repeat rate 0 order).
const questions = shuffle(subset.questions, mulberry32(config.seed + 1)).slice(0, config.eval.sampleQuestions);
const llm = createLlm(config, { logPath: "runs/tmp/paraphrase-llm.jsonl" });

const items: { questionId: string; original: string; paraphrase: string; ok: boolean; reason?: string }[] = [];
for (const [i, q] of questions.entries()) {
  const r = await llm.complete([{ role: "system", content: SYSTEM }, { role: "user", content: q.text }], { purpose: PROMPT_VERSION });
  const paraphrase = r.text.trim().replace(/^["'\s]+|["'\s]+$/g, "").split("\n")[0]!.trim();
  let reason: string | undefined;
  if (!paraphrase) reason = "empty";
  else if (normalizeAnswer(paraphrase) === normalizeAnswer(q.text)) reason = "same as original";
  else if (paraphrase.length > q.text.length * 3 + 20) reason = "much longer than original";
  items.push({ questionId: q.id, original: q.text, paraphrase, ok: !reason, ...(reason && { reason }) });
  console.log(`${i + 1}/${questions.length} ${reason ? `[REJECT: ${reason}] ` : ""}${q.text}  ->  ${paraphrase}`);
}

mkdirSync("data/eval", { recursive: true });
writeFileSync("data/eval/paraphrases.json", JSON.stringify({ promptVersion: PROMPT_VERSION, model: config.llm.model, modelDigest: config.llm.modelDigest, seed: config.seed, items }, null, 2) + "\n");
console.log(`done: ${items.filter((x) => x.ok).length} usable, ${items.filter((x) => !x.ok).length} rejected`);
