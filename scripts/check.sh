#!/usr/bin/env bash
set -euo pipefail

node --check services/api/server.js
node --check services/api/db.js
node --check services/api/storage.js
node --check services/api/provision_user.js
node --check services/scheduler/index.js
node --check services/match-worker/index.js
node --check services/replay-gateway/index.js
node --check services/compile-worker/index.js
node --check tests/api_integration.js
node --check tests/smoke.js
node -e "const fs=require('fs'),vm=require('vm'); for(const match of fs.readFileSync('web/index.html','utf8').matchAll(/<script>([\\s\\S]*?)<\\/script>/g)) new vm.Script(match[1]);"
npm --prefix services/api test
npm --prefix services/scheduler test
npm --prefix services/match-worker test
npm --prefix services/replay-gateway test
npm --prefix services/compile-worker test

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
