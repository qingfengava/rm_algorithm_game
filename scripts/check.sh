#!/usr/bin/env bash
set -euo pipefail

node --check services/api/server.js
node --check tests/smoke.js

if command -v clang-format >/dev/null 2>&1; then
    clang-format --dry-run --Werror \
        sdk/include/arena/api.hpp \
        engine/include/arena/engine.hpp \
        engine/src/engine.cpp \
        tests/cpp/stage1_smoke.cpp
else
    echo "clang-format is not installed; skipped C++ formatting check" >&2
fi

echo "source checks passed"
