# no-sdr (Rust backend) — portable build

This archive contains the Rust backend (`serverrs`), the prebuilt web client,
a default configuration, bookmark data, and launcher scripts.

## Requirements

- Linux x86-64 (glibc), Linux ARM64 (Raspberry Pi 3/4/5), macOS 11+, or
  Windows 11 x86-64.
- An RTL-SDR reachable through `rtl_tcp` (default `127.0.0.1:1234`), or an
  existing `rtl_tcp` server on your network.

## Run

Linux / macOS:

```sh
./run.sh
```

Windows (Command Prompt or PowerShell):

```bat
run.cmd
```

Then open <http://localhost:3000>.

The launchers set `CONFIG_PATH=./config/config.yaml` and
`STATIC_DIR=./static`. Override either environment variable to use a
different configuration or web build.

## Configure

Edit `config/config.yaml` (server port, admin password, dongles and profiles).
The default image is configured for an `rtl_tcp` server; start `rtl_tcp` on the
machine that owns the dongle and update `host`/`port` if needed.

## Codecs

This build includes Opus support. Linux x86-64/ARM64 builds also include
direct USB RTL-SDR support (librtlsdr is required at runtime). All FFT and IQ
codecs are enabled by default.

## License

GPL-3.0-or-later. See `LICENSE`.
