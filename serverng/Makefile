VERSION ?= dev
LDFLAGS = -ldflags="-s -w -X main.version=$(VERSION)"
EMBED_DIR = internal/api/static

# Copy the client dist into the embed path, build, then clean up.
build-production:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	go build -tags "production opus rtlsdr" $(LDFLAGS) -o bin/serverng ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-native:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	GOAMD64=v3 go build -tags "production opus rtlsdr" $(LDFLAGS) -o bin/serverng ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-linux-amd64:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags "production" $(LDFLAGS) -o bin/serverng-linux-amd64 ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-linux-arm64:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -tags "production" $(LDFLAGS) -o bin/serverng-linux-arm64 ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-darwin-arm64:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -tags "production" $(LDFLAGS) -o bin/serverng-darwin-arm64 ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-windows-amd64:
	mkdir -p $(EMBED_DIR) && cp -r ../client/dist $(EMBED_DIR)/dist && \
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -tags "production" $(LDFLAGS) -o bin/serverng-windows-amd64.exe ./cmd/serverng && \
	rm -rf $(EMBED_DIR)/dist

build-production-all: build-production-linux-amd64 build-production-linux-arm64 build-production-darwin-arm64 build-production-windows-amd64

build:
	go build $(LDFLAGS) -o bin/serverng ./cmd/serverng

build-linux-amd64:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build $(LDFLAGS) -o bin/serverng-linux-amd64 ./cmd/serverng

build-linux-arm64:
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build $(LDFLAGS) -o bin/serverng-linux-arm64 ./cmd/serverng

build-darwin-arm64:
	CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o bin/serverng-darwin-arm64 ./cmd/serverng

build-all: build-linux-amd64 build-linux-arm64 build-darwin-arm64

docker:
	docker build -t no-sdr-serverng:$(VERSION) .

run:
	go run ./cmd/serverng

test:
	go test ./...

bench:
	go test -bench=. -benchmem ./internal/dsp/ ./internal/demod/ ./internal/codec/

clean:
	rm -rf bin/

.PHONY: build build-production build-production-native build-production-linux-amd64 build-production-linux-arm64 build-production-darwin-arm64 build-production-windows-amd64 build-production-all build-linux-amd64 build-linux-arm64 build-darwin-arm64 build-all docker run test bench clean
