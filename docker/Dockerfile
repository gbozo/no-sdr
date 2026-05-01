# ============================================
# node-sdr — Docker Build (Go backend, v2+)
# ============================================
# Stage 1: build the SolidJS client with Node.js
# Stage 2: compile the Go binary
# Stage 3: minimal Alpine runtime image
# ============================================

# ---- Client Build ----
FROM node:22-slim AS client-builder

WORKDIR /app

COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY client/package.json client/

RUN npm ci --workspace=shared --workspace=client

COPY tsconfig.base.json ./
COPY shared/ shared/
COPY client/ client/

RUN npm run build --workspace=shared && npm run build --workspace=client

# ---- Go Build ----
FROM golang:1.23-alpine AS go-builder

WORKDIR /app/serverng

COPY serverng/go.mod serverng/go.sum ./
RUN go mod download

COPY serverng/ .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /serverng ./cmd/serverng

# ---- Runtime ----
FROM alpine:3.20

RUN apk add --no-cache ca-certificates

WORKDIR /app

# Go binary
COPY --from=go-builder /serverng /app/serverng

# Built client static files
COPY --from=client-builder /app/client/dist /app/static

# Default config (can be overridden by volume mount)
COPY config/ /app/config/

EXPOSE 3000

ENV STATIC_DIR=/app/static
ENV CONFIG_PATH=/app/config/config.yaml

ENTRYPOINT ["/app/serverng"]
