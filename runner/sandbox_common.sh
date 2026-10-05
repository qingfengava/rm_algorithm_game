#!/usr/bin/env bash
set -euo pipefail

arena_select_engine() {
    local requested=${ARENA_SANDBOX_ENGINE:-auto}
    if [[ "$requested" == "docker" || "$requested" == "podman" ]]; then
        command -v "$requested" >/dev/null 2>&1 || {
            echo "SANDBOX_UNAVAILABLE: $requested is not installed" >&2
            return 70
        }
        printf '%s\n' "$requested"
        return 0
    fi
    if command -v podman >/dev/null 2>&1; then
        printf '%s\n' podman
        return 0
    fi
    if command -v docker >/dev/null 2>&1; then
        printf '%s\n' docker
        return 0
    fi
    echo "SANDBOX_UNAVAILABLE: install rootless Podman or Docker" >&2
    return 70
}

arena_require_rootless() {
    local engine=$1
    if [[ "$engine" == "podman" ]]; then
        local rootless
        if ! rootless=$(podman info --format '{{.Host.Security.Rootless}}' 2>/dev/null); then
            echo "SANDBOX_UNAVAILABLE: Podman service is not available" >&2
            return 70
        fi
        if [[ "$rootless" != "true" ]]; then
            echo "SANDBOX_REJECTED: Podman must run rootless" >&2
            return 71
        fi
        return 0
    fi

    local security_options
    if ! security_options=$(docker info --format '{{json .SecurityOptions}}' 2>/dev/null); then
        echo "SANDBOX_UNAVAILABLE: Docker daemon is not available" >&2
        return 70
    fi
    if [[ "$security_options" != *rootless* ]]; then
        echo "SANDBOX_REJECTED: Docker daemon must use rootless mode" >&2
        return 71
    fi
}

arena_validate_regular_file() {
    local path=$1
    if [[ ! -f "$path" || -L "$path" ]]; then
        echo "SANDBOX_INVALID: expected regular file: $path" >&2
        return 65
    fi
}

arena_validate_directory() {
    local path=$1
    if [[ ! -d "$path" || -L "$path" ]]; then
        echo "SANDBOX_INVALID: expected directory: $path" >&2
        return 65
    fi
}
