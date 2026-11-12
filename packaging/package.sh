#!/bin/sh
# Build portable release archives from CI artifacts.
#
# Usage: package.sh <version> <artifacts-dir> <client-dist-dir> <output-dir>
set -eu

VERSION=${1:?version required}
DIST=${2:?artifacts dir required}
CLIENT=${3:?client dist dir required}
OUT=${4:?output dir required}

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$OUT"
OUT=$(CDPATH= cd -- "$OUT" && pwd)
ARCH_DIR="$OUT/archives"
STAGE="$OUT/stage"

rm -rf "$ARCH_DIR" "$STAGE"
mkdir -p "$ARCH_DIR" "$STAGE"

common() {
    dir=$1
    mkdir -p "$dir/config" "$dir/static" "$dir/bookmarks"
    cp -R "$CLIENT/." "$dir/static/"
    cp "$ROOT/config/config.yaml" "$dir/config/config.yaml"
    cp -R "$ROOT/bookmarks/." "$dir/bookmarks/"
    cp "$ROOT/LICENSE" "$dir/LICENSE"
    cp "$ROOT/packaging/README-portable.md" "$dir/README.md"
}

pack_tar() {
    name=$1
    tar -C "$STAGE" -czf "$ARCH_DIR/$name.tar.gz" "$name"
    echo "packaged $name.tar.gz"
}

pack_windows() {
    name=$1
    (cd "$STAGE" && zip -qr "$ARCH_DIR/$name.zip" "$name")
    echo "packaged $name.zip"
}

for bin in "$DIST"/serverrs-linux-amd64-*; do
    [ -f "$bin" ] || continue
    suffix=${bin##*/serverrs-linux-amd64-}
    name="serverrs-$VERSION-linux-amd64-$suffix"
    dir="$STAGE/$name"
    common "$dir"
    cp "$bin" "$dir/serverrs"
    cp "$ROOT/packaging/run.sh" "$dir/run.sh"
    cp "$ROOT/packaging/60-serverrs-rtlsdr.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-hackrf.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-airspy.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-airspyhf.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-hydrasdr.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-elad.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-rx888.rules" "$dir/"
    chmod +x "$dir/serverrs" "$dir/run.sh"
    pack_tar "$name"
done

for bin in "$DIST"/serverrs-linux-arm64-*; do
    [ -f "$bin" ] || continue
    suffix=${bin##*/serverrs-linux-arm64-}
    name="serverrs-$VERSION-linux-arm64-$suffix"
    dir="$STAGE/$name"
    common "$dir"
    cp "$bin" "$dir/serverrs"
    cp "$ROOT/packaging/run.sh" "$dir/run.sh"
    cp "$ROOT/packaging/60-serverrs-rtlsdr.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-hackrf.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-airspy.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-airspyhf.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-hydrasdr.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-elad.rules" "$dir/"
    cp "$ROOT/packaging/60-serverrs-rx888.rules" "$dir/"
    chmod +x "$dir/serverrs" "$dir/run.sh"
    pack_tar "$name"
done

for platform in macos-arm64 macos-x86_64; do
    bin="$DIST/serverrs-$platform"
    [ -f "$bin" ] || continue
    name="serverrs-$VERSION-$platform"
    dir="$STAGE/$name"
    common "$dir"
    cp "$bin" "$dir/serverrs"
    cp "$ROOT/packaging/run.sh" "$dir/run.sh"
    chmod +x "$dir/serverrs" "$dir/run.sh"
    pack_tar "$name"
done

if [ -f "$DIST/serverrs-windows-amd64.exe" ]; then
    name="serverrs-$VERSION-windows-amd64"
    dir="$STAGE/$name"
    common "$dir"
    cp "$DIST/serverrs-windows-amd64.exe" "$dir/serverrs.exe"
    cp "$ROOT/packaging/run.cmd" "$dir/run.cmd"
    pack_windows "$name"
fi

(cd "$ARCH_DIR" && sha256sum ./*.tar.gz ./*.zip > SHA256SUMS)
echo "wrote $ARCH_DIR/SHA256SUMS"
