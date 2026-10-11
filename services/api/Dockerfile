FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund --prefer-offline \
    --fetch-retries=5 --fetch-retry-factor=2 --fetch-retry-mintimeout=1000 \
    --fetch-retry-maxtimeout=120000 --maxsockets=1 \
    && npm cache clean --force

COPY server.js db.js storage.js limits.js provision_user.js schema.sql ./
COPY test ./test

USER node
EXPOSE 8080

CMD ["node", "server.js"]
