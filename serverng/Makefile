VERSION ?= dev
LDFLAGS = -ldflags="-s -w -X main.version=$(VERSION)"

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

.PHONY: build build-linux-amd64 build-linux-arm64 build-darwin-arm64 build-all docker run test bench clean
