#!/usr/bin/env bash
# The campaign suite runs every mission in one fixed order on one physics world, and races / pursuits are
# chaotic: what earlier runs leave behind (traffic, parked AI cars, solver state) can flip a single result.
# This samples the chaos-sensitive checks from 15 / 11 different starting states and prints pass rates, which
# is the meaningful number when comparing physics changes (see docs/REALISM-UPDATE.md, Stage 3).
# Usage: bash scripts/campaign-sample.sh   (about 5 minutes)
set -u
cd "$(dirname "$0")/.."
n=0; p=0
for pre in "" 0 1 2 3 4 5 6 7 8 9 10 13 "0,5" "2,9"; do
  out=$(npx tsx scripts/campaign-test.ts --only="${pre:+$pre,}11" 2>&1 | grep -E "^(PASS|FAIL)  12\. Hot Pursuit \(")
  n=$((n+1)); case "$out" in PASS*) p=$((p+1));; esac
done
echo "Hot Pursuit escaped by the test driver: $p/$n starting states"
pass=0; fail=0
for pre in "" 0 1 2 3 4 5 6 7 9 10; do
  out=$(npx tsx scripts/campaign-test.ts --only="${pre:+$pre,}13,14" 2>&1 | grep -E "^(PASS|FAIL) .*(without ramming|rivals drove|checkpoints in order)")
  pass=$((pass+$(echo "$out" | grep -c '^PASS'))); fail=$((fail+$(echo "$out" | grep -c '^FAIL')))
done
echo "Rival behaviour checks (Circuit Championship + City Grand Prix): $pass pass / $fail fail"
