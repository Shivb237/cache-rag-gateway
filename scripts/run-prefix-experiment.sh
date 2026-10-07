#!/usr/bin/env bash
# Prefix-cache experiment: 100 questions per run, every other cache off.
# Arms alternate; the control and one arm are repeated so machine drift is visible.
#   off  = the model server's prefix cache defeated with a per-request nonce (control)
#   rel  = passages in relevance order      sort = passages in canonical (sorted) order
#   grp  = questions grouped by paragraph   shuf = questions in random order
# Usage: bash scripts/run-prefix-experiment.sh
set -euo pipefail
cd "$(dirname "$0")/.."
run() { npm run eval --silent -- --name "$1" --workload prefix --n 100 --order "$2" --override "configs/ablations/$3.yaml" > /dev/null; echo "finished $1"; }
run prefix-off-a      grouped  prefix_off
run prefix-rel-shuf   shuffled prefix_on_relevance
run prefix-sort-shuf  shuffled prefix_on_sorted
run prefix-rel-grp    grouped  prefix_on_relevance
run prefix-sort-grp   grouped  prefix_on_sorted
run prefix-off-b      grouped  prefix_off
run prefix-sort-grp-b grouped  prefix_on_sorted
echo ALL-DONE
