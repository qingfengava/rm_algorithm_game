#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
source "$script_dir/sandbox_common.sh"

if [[ $# -ne 2 ]]; then
    echo "usage: $0 submission.zip output-runner" >&2
    exit 64
fi

submission=$(readlink -f "$1")
output=$2
output_dir=$(readlink -f "$(dirname "$output")")
output_name=$(basename "$output")
arena_validate_regular_file "$submission"
arena_validate_directory "$output_dir"

engine=$(arena_select_engine)
arena_require_rootless "$engine"
profile=$(readlink -f "$repo_root/infra/seccomp/compile-worker.json")
arena_validate_regular_file "$profile"
image=${ARENA_COMPILE_WORKER_IMAGE:-arena-compile-worker:local}
timeout_seconds=${ARENA_COMPILE_TIMEOUT_SECONDS:-45}

run_args=(run --rm -i
    # Root in a rootless engine maps to the invoking host user, allowing the
    # worker to write the explicitly mounted output directory without granting
    # host-root privileges.
    --user 0:0
    --network none
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --security-opt "seccomp=$profile"
    --pids-limit 64
    --memory 1g
    --memory-swap 1g
    --cpus 2
    --ulimit nofile=128:128
    --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m
    --mount "type=bind,src=$submission,dst=/input/submission.zip,readonly"
    --mount "type=bind,src=$output_dir,dst=/output,rw"
    "$image" /input/submission.zip "/output/$output_name")

exec timeout --signal=TERM --kill-after=3s "${timeout_seconds}s" \
    "$engine" "${run_args[@]}"
