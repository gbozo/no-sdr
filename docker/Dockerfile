# ============================================
# node-sdr — Docker Build
# ============================================
# Multi-stage build: build client + server, then slim runtime.
# Use with docker-compose.yml for USB passthrough.
# ============================================

FROM node:22-slim AS builder

WORKDIR /app

# Copy workspace config
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/

# Install all deps
RUN npm ci

# Copy source
COPY tsconfig.base.json ./
COPY shared/ shared/
COPY server/ server/
COPY client/ client/

# Build everything
RUN npm run build

# Prune dev dependencies in-place for the runtime stage
RUN npm prune --omit=dev

# ---- Runtime Stage ----
FROM node:22-slim AS runtime

# Install rtl-sdr tools
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      rtl-sdr \
      librtlsdr-dev \
      dump1090-mutability \
      multimon-ng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifacts and pruned node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/shared/package.json shared/
COPY --from=builder /app/shared/dist/ shared/dist/
COPY --from=builder /app/server/package.json server/
COPY --from=builder /app/server/dist/ server/dist/
COPY --from=builder /app/client/dist/ client/dist/

# Copy default config
COPY config/ config/

EXPOSE 3000

ENV NODE_ENV=production

CMD ["node", "server/dist/index.js"]
