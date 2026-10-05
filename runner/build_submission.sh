#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 submission.zip output-runner" >&2
    exit 64
fi

submission=$1
output=$2
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=$(dirname "$output")
mkdir -p "$output_dir"
if [[ -L "$output" ]]; then
    echo "SANDBOX_INVALID: output path must not be a symlink" >&2
    exit 65
fi
output=$(readlink -f -- "$output")
staging_dir=$(mktemp -d)
trap 'rm -rf "$staging_dir"' EXIT
staged_output="$staging_dir/bot_runner"

# Compilation always happens in the isolated Compile Worker. The plain
# compile_worker.sh is the container entrypoint and is not a host fallback.
"$repo_root/runner/run_compile_worker.sh" "$submission" "$staged_output"

build_dir="$repo_root/build"
cmake -S "$repo_root" -B "$build_dir" -DARENA_BUILD_TESTS=OFF -DARENA_BUILD_RUNNER=ON >/dev/null
cmake --build "$build_dir" --target arena_baseline_runner arena_match_demo --parallel >/dev/null
baseline="$build_dir/arena_baseline_runner"
qualification="$build_dir/arena_match_demo"

if ! timeout --signal=KILL --kill-after=2s 30s \
    "$repo_root/runner/run_match_worker.sh" --qualify-red "$staged_output" "$baseline" "$qualification"; then
    echo "QUALIFICATION_FAILED: candidate must defeat baseline as red" >&2
    exit 68
fi
if ! timeout --signal=KILL --kill-after=2s 30s \
    "$repo_root/runner/run_match_worker.sh" --qualify-blue "$baseline" "$staged_output" "$qualification"; then
    echo "QUALIFICATION_FAILED: candidate must defeat baseline as blue" >&2
    exit 68
fi

mv -- "$staged_output" "$output"
echo "COMPILE_OK: $output"
