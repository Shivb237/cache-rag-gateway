#!/usr/bin/env bash
# Claude prompt caching, interleaved arms with a noise-floor twin. Concentrated workload (100 questions over 20 paragraphs)
# twice, diverse workload (100 questions from different paragraphs) once. Usage: bash scripts/run-claude-prefix.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p runs/tmp
run() {
  npm run ablation --silent -- --name "$1" --matrix configs/ablation/prefix-matrix.yaml --workload "$2" --n 100 --reps "$3" --override configs/providers/claude_sonnet.yaml > /dev/null 2> "runs/tmp/$1.err" || { echo "FAILED $1"; cat "runs/tmp/$1.err"; exit 1; }
  echo "finished $1"
}
run prefix-claude-concentrated concentrated 2
run prefix-claude-diverse      diverse      1
echo ALL-DONE
