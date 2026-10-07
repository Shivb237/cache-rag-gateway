#!/usr/bin/env bash
# Does a retrieval cache (keyed on query similarity) raise prefix-cache reuse? 100 shuffled questions per run, sorted
# passage order, prefix cache on, other caches off. The model is unloaded before every run so its prompt cache starts
# empty and runs cannot leak into each other. The no-retrieval-cache arm and one cached arm are repeated to expose drift.
# Usage: bash scripts/run-retrieval-experiment.sh
set -euo pipefail
cd "$(dirname "$0")/.."
MODEL="qwen3:4b-instruct"
run() {
  ollama stop "$MODEL" >/dev/null 2>&1 || true
  sleep 2
  npm run eval --silent -- --name "$1" --workload prefix --n 100 --order shuffled --override "configs/ablations/$2.yaml" > /dev/null
  echo "finished $1"
}
run ret-off-a  prefix_on_sorted
run ret-t75    ret_sorted_t75
run ret-t65    ret_sorted_t65
run ret-t85    ret_sorted_t85
run ret-off-b  prefix_on_sorted
run ret-t65-b  ret_sorted_t65
echo ALL-DONE
