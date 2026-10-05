#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo 'usage: compile_submission.sh source.zip output-runner' >&2
  exit 64
fi

source_zip=$1
output=$2
repo=/opt/arena
mkdir -p "$(dirname "$output")"
"$repo/runner/compile_worker.sh" "$source_zip" "$output"
"$repo/build/arena_match_demo" --qualify-red "$output" "$repo/build/arena_baseline_runner"
"$repo/build/arena_match_demo" --qualify-blue "$repo/build/arena_baseline_runner" "$output"
echo 'QUALIFICATION_OK'
