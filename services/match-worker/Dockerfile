FROM gcc:14-bookworm AS engine-build

RUN apt-get update \
    && apt-get install --no-install-recommends --yes cmake \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .
RUN cmake -S . -B build -DARENA_BUILD_TESTS=OFF -DARENA_BUILD_RUNNER=ON \
    && cmake --build build --target arena_match_demo --parallel

FROM node:22-bookworm-slim

WORKDIR /app

COPY services/match-worker/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY services/match-worker/index.js ./index.js
COPY services/api/db.js services/api/schema.sql services/api/storage.js ./api/
COPY --from=engine-build /src/build/arena_match_demo ./arena_match_demo

USER node
CMD ["node", "index.js"]
