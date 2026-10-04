#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
    echo "usage: $0 bot_runner [runner arguments...]" >&2
    exit 64
fi

runner_binary=$(readlink -f "$1")
shift
if [[ ! -f "$runner_binary" || -L "$runner_binary" ]]; then
    echo "RUNNER_INVALID: executable must be a regular file" >&2
    exit 65
fi

image=${ARENA_RUNNER_IMAGE:-arena-runner:local}
exec docker run --rm -i \
    --network none \
    --read-only \
    --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --pids-limit 1 \
    --memory 256m \
    --cpus 1 \
    --ulimit nofile=32:32 \
    --mount "type=bind,src=$runner_binary,dst=/app/bot_runner,readonly" \
    "$image" "$@"
