FROM node:22-bookworm-slim

WORKDIR /app

COPY services/scheduler/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund --prefer-offline \
    --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 \
    --fetch-retry-maxtimeout=120000 --maxsockets=1 \
    && npm cache clean --force

COPY services/scheduler/index.js ./index.js
COPY services/api/db.js services/api/schema.sql services/api/limits.js ./api/

USER node
CMD ["node", "index.js"]
