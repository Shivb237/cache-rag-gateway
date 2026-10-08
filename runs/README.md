# What is in runs/

Every file is a real run. `<name>.jsonl` has one row per request; `<name>.summary.json` has the aggregate. Smoke runs (`smoke-*`) are throwaway and not committed. The exact settings of each run (workload sizes, seed, thresholds, model, Node version) are recorded inside its summary file.

| Files | What it measures | Model | Script |
|---|---|---|---|
| `baseline` | 200 questions, no caches | Qwen3 4B | `eval/run.ts` (`npm run eval`) |
| `claude-baseline-a/b/c` | The same 200 questions, no caches, three repetitions (the noise floor). `a` has no summary: its summary step crashed on a since-fixed bug after all rows were written | Claude Sonnet 5.5 | `scripts/run-claude-baseline.sh` |
| `exact-r25`, `r50`, `r75` | Exact cache when 25%, 50% and 75% of requests repeat an earlier question | Qwen3 4B | `eval/run.ts --workload repeat --repeat-rate <rate>` |
| `semantic-t90` | Semantic cache at threshold 0.90 on a paraphrase and near-miss workload | Qwen3 4B | `eval/run.ts --workload semantic` |
| `semantic-sweep.json`, `.csv`, `semantic-sweep-queries.jsonl` | Offline threshold sweep for the semantic cache (embeddings only, no model calls) | none | `scripts/semantic-sweep.ts` |
| `prefix-off-a/b`, `prefix-rel-*`, `prefix-sort-*` | Prompt (prefix) caching: passage order (relevance or sorted) against question order (grouped or shuffled), with repeated controls | Qwen3 4B | `scripts/run-prefix-experiment.sh`, analysed by `scripts/analyze-prefix.ts` |
| `ret-off-a/b`, `ret-t65`, `ret-t65-b`, `ret-t75`, `ret-t85` | Retrieval cache at similarity thresholds 0.65, 0.75 and 0.85, against no retrieval cache | Qwen3 4B | `scripts/run-retrieval-experiment.sh`, analysed by `scripts/analyze-retrieval.ts` |
| `retrieval-sweep.json` | Offline simulation of the retrieval cache over thresholds (embeddings only) | none | `scripts/retrieval-sweep.ts` |
| `prefix-claude-concentrated`, `prefix-claude-diverse` | Claude prompt caching on a concentrated workload (100 questions over 20 paragraphs) and a diverse one | Claude Sonnet 5.5 | `scripts/run-claude-prefix.sh` |
| `ablation-qwen` | All cache layers, arms interleaved per request, 2 repetitions, with an identical control twin | Qwen3 4B | `eval/ablation.ts` (`npm run ablation`) |
| `ablation-claude` | The same ablation with 3 repetitions | Claude Sonnet 5.5 | `eval/ablation.ts` with `--override configs/providers/claude_sonnet.yaml` |
| `staleness-claude` | Cached answers after the data changes, with and without invalidation by data version | Claude Sonnet 5.5 | `eval/staleness.ts` (`npm run staleness`) |
