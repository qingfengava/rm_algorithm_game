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
compiled_size=$(stat -c '%s' "$output")
if [[ "$compiled_size" -gt 33554432 ]]; then
  echo "COMPILED_ARTIFACT_TOO_LARGE: runner exceeds 32 MiB" >&2
  exit 69
fi
"$repo/build/arena_match_demo" --qualify-red "$output" "$repo/build/arena_baseline_runner"
"$repo/build/arena_match_demo" --qualify-blue "$repo/build/arena_baseline_runner" "$output"
echo 'QUALIFICATION_OK'
