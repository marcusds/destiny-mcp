# --- Build stage: compile TS + native better-sqlite3 ------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Toolchain for node-gyp (better-sqlite3 native build)
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Skip husky during install (no .git in the build context)
ENV HUSKY=0

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- Runtime stage: slim, no toolchain --------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV D2_MCP_DATA_DIR=/data

COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Persist tokens + manifest cache here
RUN mkdir -p /data && chown -R node:node /data /app
USER node
VOLUME ["/data"]

# WebSocket MCP transport
EXPOSE 3000
CMD ["node", "dist/index.js", "websocket", "--port", "3000"]
