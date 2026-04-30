# Multi-stage build: compile Go binary, then copy to minimal Alpine image.
FROM golang:1.23-alpine AS builder

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /serverng ./cmd/serverng

# Final image — just the binary + ca-certificates for HTTPS
FROM alpine:3.20
RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /serverng /app/serverng

# Client dist will be mounted or copied separately
# COPY --from=client-builder /app/client/dist /app/static

EXPOSE 3000
ENV STATIC_DIR=/app/static
ENV CONFIG_PATH=/app/config/config.yaml

ENTRYPOINT ["/app/serverng"]
