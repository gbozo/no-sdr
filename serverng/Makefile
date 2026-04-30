.PHONY: build build-pi run test clean

build:
	go build -o bin/serverng ./cmd/serverng

build-pi:
	GOOS=linux GOARCH=arm64 go build -o bin/serverng-arm64 ./cmd/serverng

run:
	go run ./cmd/serverng

test:
	go test ./...

clean:
	rm -rf bin/
