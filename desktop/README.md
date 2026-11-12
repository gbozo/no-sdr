# NO(DE)-SDR Desktop

Electron shell for the Rust WebSDR backend. The desktop app starts the bundled
`serverrs` binary on a loopback port, keeps the existing REST/WebSocket
protocol, and opens the normal SolidJS client in a Chromium window.

## What is bundled

- `serverrs` for the target platform
- the built web client (`client/dist`)
- the default `config/config.yaml`
- default bookmarks
- app resources such as the loading screen and icons

On first launch the app creates a per-user directory:

- Windows: `%APPDATA%/NO(DE)-SDR`
- macOS: `~/Library/Application Support/NO(DE)-SDR`
- Linux: `~/.config/NO(DE)-SDR`

The default config is copied there once and then owned by the user. Admin
changes and server logs stay in that directory; they are not written into the
application bundle. If the app is upgraded, the existing user config is kept.

## Local build

```bash
# from the repository root
npm install
npm run build:client

cd serverrs
cargo build --release --all-features --bin serverrs
cd ..

npm run stage --workspace=desktop       # copies binary to desktop/runtime/
npm run dist:linux --workspace=desktop  # AppImage + deb
npm run dist:mac --workspace=desktop    # dmg + zip
npm run dist:win --workspace=desktop    # nsis + portable exe
```

`dist:*` builds the current host platform. Release CI runs one job per target
so each package contains the matching `serverrs` binary.

## Runtime layout

```
resources/
  app.asar
  runtime/serverrs[.exe]
  client/
  config/config.yaml
  bookmarks-default/
  udev/*.rules
```

`main.cjs` resolves the binary and client from `process.resourcesPath` in a
packaged build, or from the repository in development. It chooses a free
loopback port, sets `CONFIG_PATH`, `STATIC_DIR`, `BOOKMARKS_DIR`, `HOST` and
`PORT`, then waits for the server before navigating the window. The server is
terminated when the app quits.

## Hardware access

The desktop app does not bypass the system rules for USB SDRs:

- Linux: install the udev rules for the hardware you use. The packages include
  copies under `resources/udev/` (AppImage) or the app's resource directory
  (`.deb`); copy them to `/usr/lib/udev/rules.d/` and run
  `sudo udevadm control --reload`. The `.deb` package is a convenient base for a
  distribution package that installs them system-wide.
- Windows: bind raw-USB radios (RTL-SDR, HackRF, Airspy, …) to WinUSB with Zadig.
- macOS: native USB drivers need no extra driver package.
- SDRplay: install the vendor API service; LimeSDR: install LimeSuite; Fobos:
  install `libfobos`. Those libraries are loaded at runtime and are not bundled.

## Release artifacts

The `Rust Binaries` workflow builds desktop packages on release:

- Linux amd64/arm64: `.AppImage`, `.deb`
- macOS arm64/x86_64: `.dmg`, `.zip`
- Windows amd64: NSIS installer, portable `.exe`

They are attached to the GitHub release next to the portable server archives.
