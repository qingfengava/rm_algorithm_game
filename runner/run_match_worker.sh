#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/.." && pwd)
source "$script_dir/sandbox_common.sh"

mode=normal
if [[ "${1:-}" == "--qualify-red" || "${1:-}" == "--qualify-blue" ]]; then
    mode=${1#--}
    shift
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
    echo "usage: $0 [--qualify-red|--qualify-blue] red-runner blue-runner [match-worker]" >&2
    exit 64
fi

red_runner=$(readlink -f "$1")
blue_runner=$(readlink -f "$2")
match_worker=${3:-$repo_root/build/arena_match_demo}
match_worker=$(readlink -f "$match_worker")
arena_validate_regular_file "$red_runner"
arena_validate_regular_file "$blue_runner"
arena_validate_regular_file "$match_worker"
[[ -x "$red_runner" && -x "$blue_runner" && -x "$match_worker" ]] || {
    echo "SANDBOX_INVALID: match inputs must be executable" >&2
    exit 65
}

engine=$(arena_select_engine)
arena_require_rootless "$engine"
profile=$(readlink -f "$repo_root/infra/seccomp/match-worker.json")
arena_validate_regular_file "$profile"
image=${ARENA_MATCH_WORKER_IMAGE:-arena-match-worker:local}
timeout_seconds=${ARENA_MATCH_TIMEOUT_SECONDS:-15}

run_args=(run --rm -i
    --network none
    --read-only
    --cap-drop ALL
    --security-opt no-new-privileges:true
    --security-opt "seccomp=$profile"
    --pids-limit 3
    --memory 512m
    --memory-swap 512m
    --cpus 2
    --ulimit nofile=128:128
    --mount "type=bind,src=$match_worker,dst=/app/match_worker,readonly"
    --mount "type=bind,src=$red_runner,dst=/app/red_runner,readonly"
    --mount "type=bind,src=$blue_runner,dst=/app/blue_runner,readonly"
    "$image")

case "$mode" in
    normal)
        run_args+=(/app/red_runner /app/blue_runner)
        ;;
    qualify-red)
        run_args+=(--qualify-red /app/red_runner /app/blue_runner)
        ;;
    qualify-blue)
        run_args+=(--qualify-blue /app/red_runner /app/blue_runner)
        ;;
    *)
        echo "SANDBOX_INVALID: unknown match mode: $mode" >&2
        exit 64
        ;;
esac

exec timeout --signal=TERM --kill-after=2s "${timeout_seconds}s" \
    "$engine" "${run_args[@]}"
