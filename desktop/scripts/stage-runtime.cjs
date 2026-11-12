#!/usr/bin/env node
// Stage the platform server binary next to the Electron app. electron-builder
// copies `runtime/` into the packaged resources directory; main.cjs launches
// the binary from there.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const desktop = path.resolve(__dirname, '..');
const binaryName = process.platform === 'win32' ? 'serverrs.exe' : 'serverrs';
const source = process.env.SERVERRS_BIN
  ? path.resolve(process.env.SERVERRS_BIN)
  : path.join(root, 'serverrs', 'target', 'release', binaryName);
const runtime = path.join(desktop, 'runtime');

if (!fs.existsSync(source)) {
  console.error(`serverrs binary not found: ${source}`);
  console.error('Build it first: cargo build --release --all-features --manifest-path serverrs/Cargo.toml');
  process.exit(1);
}

fs.rmSync(runtime, { recursive: true, force: true });
fs.mkdirSync(runtime, { recursive: true });
const destination = path.join(runtime, binaryName);
fs.copyFileSync(source, destination);
if (process.platform !== 'win32') fs.chmodSync(destination, 0o755);

console.log(`staged ${source} -> ${destination}`);
