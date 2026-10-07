// Starts the gateway as an HTTP service.
// Local:  npm run serve                      (uses configs/base.yaml, the local model)
// Cloud:  CONFIG_OVERRIDE=configs/providers/claude_sonnet.yaml GATEWAY_API_KEY=... ANTHROPIC_API_KEY=... npm run serve
import { loadConfig } from "./config.js";
import { createEmbedder } from "./embed.js";
import { buildArm, type ArmSpec } from "./eval/arms.js";
import { withRetries } from "./eval/retry.js";
import { createLlm } from "./llm.js";
import { assertIndexMatches, loadIndex } from "./rag/index.js";
import { loadSubsetFile, sha256File } from "./rag/subset.js";
import { createApp } from "./server.js";

const config = loadConfig("configs/base.yaml", process.env.CONFIG_OVERRIDE);
// A public service that spends money gets its own, lower cap. The spend ledger lives on the container's disk, so it
// resets when the container restarts: this is a seatbelt, and the provider-side spending limit is the real backstop.
if (process.env.SPEND_CAP_USD) config.llm.spendCapUsd = Number(process.env.SPEND_CAP_USD);
const subsetSha256 = sha256File(config.dataset.subsetPath);
const subset = loadSubsetFile(config.dataset.subsetPath);
const index = loadIndex(config.dataset.indexPath);
assertIndexMatches(index, { model: config.embedding.model, revision: config.embedding.revision, subsetSha256 });

const llm = createLlm(config);
const { embed } = createEmbedder(config.embedding);
// The caches that are switched on in the config are the ones the service runs with.
const c = config.caches;
const spec: ArmSpec = {
  name: "service", exact: c.exact.enabled, semantic: c.semantic.enabled, retrieval: c.retrieval.enabled,
  semanticThreshold: c.semantic.threshold, retrievalThreshold: c.retrieval.threshold, prefix: c.promptPrefix.enabled, order: config.prompt.passageOrder,
};
const { pipeline } = buildArm(config, spec, { embed, llm, index, paragraphs: new Map(subset.paragraphs.map((p) => [p.id, p])), subsetSha256 }, "service");

const apiKey = process.env.GATEWAY_API_KEY;
if (!apiKey) console.warn("WARNING: GATEWAY_API_KEY is not set, so /ask and /stats are open to anyone who can reach this port.");
const app = createApp({ pipeline: withRetries(pipeline), model: config.llm.model, indexedParagraphs: index.meta.count, spentUsd: llm.spentUsd, apiKey });

const port = Number(process.env.PORT ?? 8080);
app.listen(port, "0.0.0.0", () => {
  console.log(`gateway listening on :${port} | model ${config.llm.model} | caches: exact=${c.exact.enabled} semantic=${c.semantic.enabled} retrieval=${c.retrieval.enabled} prefix=${c.promptPrefix.enabled} | spend cap $${config.llm.spendCapUsd}`);
});
