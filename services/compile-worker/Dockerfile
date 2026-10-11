FROM gcc:14-bookworm AS engine-build

RUN apt-get update && apt-get install --no-install-recommends --yes cmake unzip ripgrep nodejs npm \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
RUN cmake -S . -B build -DARENA_BUILD_TESTS=OFF -DARENA_BUILD_RUNNER=ON \
        -DCMAKE_EXE_LINKER_FLAGS="-static-libstdc++ -static-libgcc" \
    && cmake --build build --target arena_baseline_runner arena_match_demo --parallel

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install --no-install-recommends --yes g++ unzip ripgrep coreutils \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/arena
COPY --from=engine-build /src/sdk sdk
COPY --from=engine-build /src/runner runner
COPY --from=engine-build /src/engine engine
COPY --from=engine-build /src/examples examples
COPY --from=engine-build /src/CMakeLists.txt .
COPY --from=engine-build /src/build build
COPY services/compile-worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --prefer-offline \
    --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 \
    --fetch-retry-maxtimeout=120000 --maxsockets=1 \
    && npm cache clean --force
COPY services/compile-worker/index.js ./index.js
COPY services/api/db.js services/api/schema.sql services/api/storage.js services/api/limits.js ./api/
COPY services/compile-worker/compile_submission.sh /app/compile_submission.sh
RUN chmod 755 /app/compile_submission.sh
USER node
CMD ["node", "index.js"]
