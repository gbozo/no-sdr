# ============================================
# node-sdr — Docker Build (Go backend, v2+)
# ============================================
# Stage 1: build the SolidJS client with Node.js
# Stage 2: build RTL-SDR library + rtl_tcp from Osmocom source
# Stage 3: compile the Go binary (CGO, opus + rtlsdr tags)
# Stage 4: minimal Alpine runtime image
# ============================================

# ---- Client Build ----
FROM node:22-slim AS client-builder

WORKDIR /app

COPY package.json package-lock.json ./

COPY client/package.json client/

RUN npm ci --workspace=client

COPY tsconfig.base.json ./

COPY client/ client/

RUN npm run build --workspace=client

# ---- RTL-SDR Build (Osmocom) ----
FROM alpine:3.20 AS rtlsdr-builder

RUN apk add --no-cache \
    git \
    cmake \
    make \
    gcc \
    musl-dev \
    libusb-dev \
    pkgconfig

# Clone Osmocom rtl-sdr (no_eeprom_write, active maintenance branch)
RUN git clone https://gitea.osmocom.org/sdr/rtl-sdr.git /rtl-sdr \
    --depth=1 --branch master

RUN cmake -S /rtl-sdr -B /rtl-sdr/build \
        -DCMAKE_INSTALL_PREFIX=/usr/local \
        -DCMAKE_BUILD_TYPE=Release \
        -DINSTALL_UDEV_RULES=OFF \
    && cmake --build /rtl-sdr/build --parallel "$(nproc)" \
    && cmake --install /rtl-sdr/build

# ---- Go Build ----
FROM golang:1.23-alpine AS go-builder

# Build tools + CGO deps
RUN apk add --no-cache \
    gcc \
    musl-dev \
    libusb-dev \
    opus-dev \
    pkgconfig

# Copy the Osmocom rtl-sdr we just built
COPY --from=rtlsdr-builder /usr/local/include/rtl-sdr*.h  /usr/local/include/
RUN --mount=from=rtlsdr-builder,src=/usr/local/include,dst=/src/include \
    cp /src/include/rtl_sdr_compat.h /usr/local/include/ 2>/dev/null || true
COPY --from=rtlsdr-builder /usr/local/lib/librtlsdr*            /usr/local/lib/
COPY --from=rtlsdr-builder /usr/local/lib/pkgconfig/librtlsdr.pc /usr/local/lib/pkgconfig/

WORKDIR /app/serverng

COPY serverng/go.mod serverng/go.sum ./
RUN go mod download

COPY serverng/ .

RUN CGO_ENABLED=1 GOOS=linux \
    PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
    go build \
        -tags 'opus rtlsdr nolibopusfile' \
        -ldflags="-s -w" \
        -o /serverng \
        ./cmd/serverng

# ---- Runtime ----
FROM alpine:3.20

# Runtime shared libraries
RUN apk add --no-cache \
    ca-certificates \
    libusb \
    opus

# Copy the Osmocom rtl-sdr .so and rtl_tcp binary (not in Alpine packages — built from source)
COPY --from=rtlsdr-builder /usr/local/lib/librtlsdr.so*  /usr/local/lib/
COPY --from=rtlsdr-builder /usr/local/bin/rtl_tcp         /usr/local/bin/rtl_tcp
RUN ldconfig /usr/local/lib 2>/dev/null || true

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
