#!/usr/bin/env bash
set -euo pipefail

# These checks require a configured rootless Podman or Docker daemon and the
# three local images documented in infra/README.md. They are intentionally
# separate from the normal C++ test suite because they execute containers.
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
source "$repo_root/runner/sandbox_common.sh"

command -v zip >/dev/null 2>&1 || {
    echo "SECURITY_TEST_UNAVAILABLE: zip is required" >&2
    exit 70
}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

build_probe() {
    local name=$1
    local source=$2
    local build_mode=${3:-worker}
    local source_dir="$tmp_dir/$name"
    local source_file="$source_dir/bot.cpp"
    local archive="$tmp_dir/$name.zip"
    local binary="$tmp_dir/$name"

    mkdir -p "$source_dir"
    printf '%s\n' "$source" > "$source_file"
    if [[ "$build_mode" == "direct" ]]; then
        if ! timeout --signal=KILL 30s g++ -std=c++23 -O2 -pipe \
            -I"$repo_root/sdk/include" -I"$repo_root/runner/include" \
            "$repo_root/runner/src/main.cpp" "$repo_root/runner/src/protocol.cpp" \
            "$repo_root/runner/src/seccomp.cpp" "$source_file" -o "$binary"; then
            echo "SECURITY_TEST_FAILED: runtime probe did not compile" >&2
            return 1
        fi
        printf '%s\n' "$binary"
        return 0
    fi
    (cd "$source_dir" && zip -q "$archive" bot.cpp)
    if ! "$repo_root/runner/run_compile_worker.sh" "$archive" "$binary" >/dev/null; then
        echo "SECURITY_TEST_UNAVAILABLE: Compile Worker could not run" >&2
        return 70
    fi
    printf '%s\n' "$binary"
}

run_expect_success() {
    local binary=$1
    ARENA_SANDBOX_TIMEOUT_SECONDS=5 \
        "$repo_root/runner/run_sandboxed.sh" "$binary" --self-test
}

run_expect_status() {
    local expected=$1
    local binary=$2
    shift 2
    set +e
    ARENA_SANDBOX_TIMEOUT_SECONDS=5 \
        "$repo_root/runner/run_sandboxed.sh" "$binary" --self-test "$@"
    local actual=$?
    set -e
    if [[ "$actual" -ne "$expected" ]]; then
        echo "SECURITY_TEST_FAILED: expected status $expected, got $actual" >&2
        exit 1
    fi
}

run_expect_match_failure() {
    local red=$1
    local blue=$2
    set +e
    ARENA_MATCH_TIMEOUT_SECONDS=5 \
        "$repo_root/runner/run_match_worker.sh" "$red" "$blue"
    local actual=$?
    set -e
    if [[ "$actual" -eq 0 ]]; then
        echo "SECURITY_TEST_FAILED: crashing match unexpectedly succeeded" >&2
        exit 1
    fi
}

safe_probe=$(build_probe safe_probe '#include <arena/api.hpp>
class Safe final : public arena::Player {
 public:
  arena::Action act(const arena::Observation&) override { return arena::Action::scout(); }
};
extern "C" arena::Player* create_player() { return new Safe(); }')
run_expect_success "$safe_probe"

blocked_probe=$(build_probe blocked_probe '#include <arena/api.hpp>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <unistd.h>
class Blocked final : public arena::Player {
 public:
  arena::Action act(const arena::Observation&) override {
    if (::open("/etc/passwd", O_RDONLY) >= 0) _exit(91);
    if (::socket(AF_INET, SOCK_STREAM, 0) >= 0) _exit(92);
    if (::fork() >= 0) _exit(93);
    void* memory = ::mmap(nullptr, 512U * 1024U * 1024U, PROT_READ | PROT_WRITE,
                          MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (memory != MAP_FAILED) _exit(94);
    return arena::Action::scout();
  }
};
extern "C" arena::Player* create_player() { return new Blocked(); }')
run_expect_success "$blocked_probe"

loop_probe=$(build_probe loop_probe '#include <arena/api.hpp>
class Loop final : public arena::Player {
 public:
  arena::Action act(const arena::Observation&) override {
    for (;;) { asm volatile(""); }
  }
};
extern "C" arena::Player* create_player() { return new Loop(); }' direct)
run_expect_status 124 "$loop_probe"

crash_probe=$(build_probe crash_probe '#include <arena/api.hpp>
#include <unistd.h>
class Crash final : public arena::Player {
 public:
  arena::Action act(const arena::Observation&) override { _exit(95); }
};
extern "C" arena::Player* create_player() { return new Crash(); }' direct)
run_expect_match_failure "$crash_probe" "$safe_probe"
ARENA_MATCH_TIMEOUT_SECONDS=5 \
    "$repo_root/runner/run_match_worker.sh" "$safe_probe" "$safe_probe"

echo "sandbox acceptance passed"
