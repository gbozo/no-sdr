#!/usr/bin/env node
// Keep the Electron package version aligned with a release tag (or, for local
// builds, with serverrs/Cargo.toml). electron-builder uses this version in the
// artifact name and app metadata.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const packagePath = path.resolve(__dirname, '..', 'package.json');
const requested = process.env.NO_SDR_VERSION || process.env.RELEASE_VERSION || '';

let version = requested.trim().replace(/^v/, '');
if (!version) {
  const cargo = fs.readFileSync(path.join(root, 'serverrs', 'Cargo.toml'), 'utf8');
  const match = cargo.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    console.error('could not determine version from serverrs/Cargo.toml');
    process.exit(1);
  }
  version = match[1];
}

const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
pkg.version = version;
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`desktop version set to ${version}`);
