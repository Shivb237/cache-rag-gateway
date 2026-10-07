#!/usr/bin/env bash
# Claude baseline: 200 questions, no caches of any kind, three repetitions. Claude does not accept temperature, so runs vary;
# three repetitions of the same setup measure how much. Usage: bash scripts/run-claude-baseline.sh
set -euo pipefail
cd "$(dirname "$0")/.."
# Optional arguments choose which repetitions to run, e.g. `bash scripts/run-claude-baseline.sh b c`.
for rep in ${@:-a b c}; do
  mkdir -p runs/tmp
  npm run eval --silent -- --name "claude-baseline-$rep" --override configs/providers/claude_sonnet.yaml,configs/ablations/all_off.yaml > /dev/null 2> "runs/tmp/claude-baseline-$rep.err" || { echo "FAILED claude-baseline-$rep, see runs/tmp/claude-baseline-$rep.err"; cat "runs/tmp/claude-baseline-$rep.err"; exit 1; }
  echo "finished claude-baseline-$rep"
done
echo ALL-DONE
