FROM node:22-bookworm-slim

WORKDIR /app

COPY services/scheduler/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY services/scheduler/index.js ./index.js
COPY services/api/db.js services/api/schema.sql ./api/

USER node
CMD ["node", "index.js"]
