#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
source "$script_dir/sandbox_common.sh"

if [[ $# -lt 1 ]]; then
    echo "usage: $0 bot_runner [runner arguments...]" >&2
    exit 64
fi

runner_binary=$(readlink -f "$1")
shift
arena_validate_regular_file "$runner_binary"
[[ -x "$runner_binary" ]] || { echo "SANDBOX_INVALID: runner is not executable" >&2; exit 65; }

image=${ARENA_RUNNER_IMAGE:-arena-runner:local}
engine=$(arena_select_engine)
arena_require_rootless "$engine"
profile=$(readlink -f "$repo_root/infra/seccomp/algorithm.json")
arena_validate_regular_file "$profile"
timeout_seconds=${ARENA_SANDBOX_TIMEOUT_SECONDS:-12}

run_args=(run --rm -i
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --security-opt "seccomp=$profile" \
    --pids-limit 1 \
    --memory 256m \
    --memory-swap 256m \
    --cpus 1 \
    --ulimit nofile=32:32 \
    --mount "type=bind,src=$runner_binary,dst=/app/bot_runner,readonly" \
    "$image" "$@")

exec timeout --signal=TERM --kill-after=2s "${timeout_seconds}s" \
    "$engine" "${run_args[@]}"
