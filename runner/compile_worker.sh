#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
    echo "usage: $0 submission.zip output-runner" >&2
    exit 64
fi

submission=$1
output=$2
repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

if [[ ! -f "$submission" ]]; then
    echo "SUBMISSION_INVALID: zip file does not exist" >&2
    exit 65
fi
if [[ $(stat -c '%s' "$submission") -gt 5242880 ]]; then
    echo "SUBMISSION_INVALID: archive exceeds 5 MiB" >&2
    exit 65
fi

mapfile -t entries < <(unzip -Z1 "$submission")
if [[ ${#entries[@]} -ne 1 || ${entries[0]} != "bot.cpp" ]]; then
    echo "SUBMISSION_INVALID: archive must contain exactly bot.cpp" >&2
    exit 65
fi

unzip -qq -o "$submission" -d "$tmp_dir"
if [[ ! -f "$tmp_dir/bot.cpp" || -L "$tmp_dir/bot.cpp" ]]; then
    echo "SUBMISSION_INVALID: bot.cpp must be a regular file" >&2
    exit 65
fi
if [[ $(stat -c '%s' "$tmp_dir/bot.cpp") -gt 5242880 ]]; then
    echo "SUBMISSION_INVALID: bot.cpp exceeds 5 MiB" >&2
    exit 65
fi
if rg -n --glob 'bot.cpp' '(^|[^[:alnum:]_])main[[:space:]]*\(' "$tmp_dir" >/dev/null; then
    echo "SUBMISSION_INVALID: custom main() is not allowed" >&2
    exit 65
fi

mkdir -p "$(dirname "$output")"
if ! timeout --signal=KILL 30s g++ -std=c++23 -O2 -pipe -Wall -Wextra \
    -static-libstdc++ -static-libgcc \
    -I"$repo_root/sdk/include" \
    -I"$repo_root/runner/include" \
    "$repo_root/runner/src/main.cpp" \
    "$repo_root/runner/src/protocol.cpp" \
    "$repo_root/runner/src/seccomp.cpp" \
    "$tmp_dir/bot.cpp" \
    -o "$output"; then
    echo "COMPILE_FAILED" >&2
    exit 66
fi
if ! timeout --signal=KILL 2s "$output" --self-test; then
    echo "SELF_TEST_FAILED" >&2
    exit 67
fi

echo "COMPILE_OK: $output"
