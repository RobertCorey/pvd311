#!/usr/bin/env bash
# Builds app/public/map/pvd-<BUILD>.pmtiles + basemap.json — the self-hosted Protomaps basemap for the Providence area.
# Zillow-clean "light" flavour, no vendor account, no per-load cost: one 16 MB static file served by
# Firebase Hosting (byte ranges supported), read by protomaps-leaflet in app/src/components/MapView.tsx.
# Pinned to one Protomaps daily build so deploys are reproducible; bump BUILD occasionally.
# Runs as app/'s `prebuild` (npm run build → CI, deploy-app, the Playwright webServer, local builds); output is gitignored.
set -euo pipefail
BUILD="${PROTOMAPS_BUILD:-20261020}"
PMTILES_VERSION="${PMTILES_VERSION:-1.31.2}"
BBOX="-71.56,41.72,-71.28,41.92"   # Providence + the neighbouring towns a phone shows at z12
MAXZOOM=15                         # vector tiles overzoom to z19 in the browser
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/app/public/map"
OUT="$OUT_DIR/pvd-$BUILD.pmtiles"   # build date in the name: PMTiles clients cache byte ranges, so the URL must change with the data
TOOL_DIR="${TMPDIR:-/tmp}/go-pmtiles-$PMTILES_VERSION"
mkdir -p "$OUT_DIR" "$TOOL_DIR"
write_manifest() { printf '{"url":"/map/pvd-%s.pmtiles","build":"%s"}\n' "$BUILD" "$BUILD" > "$OUT_DIR/basemap.json"; }
if [ -s "$OUT" ] && [ "${FORCE:-0}" != "1" ]; then
  write_manifest; echo "basemap: $OUT already built from $BUILD"; exit 0
fi
if [ ! -x "$TOOL_DIR/pmtiles" ]; then
  arch="$(uname -m)"; case "$arch" in x86_64) a=x86_64;; aarch64|arm64) a=arm64;; *) echo "unsupported arch $arch"; exit 1;; esac
  os="$(uname -s)"; case "$os" in Linux) o=Linux;; Darwin) o=Darwin;; *) echo "unsupported os $os"; exit 1;; esac
  curl -fsSL -o "$TOOL_DIR/pmtiles.tgz" "https://github.com/protomaps/go-pmtiles/releases/download/v${PMTILES_VERSION}/go-pmtiles_${PMTILES_VERSION}_${o}_${a}.tar.gz"
  tar -xzf "$TOOL_DIR/pmtiles.tgz" -C "$TOOL_DIR" pmtiles
fi
"$TOOL_DIR/pmtiles" extract "https://build.protomaps.com/${BUILD}.pmtiles" "$OUT.tmp" --bbox="$BBOX" --maxzoom="$MAXZOOM"
mv "$OUT.tmp" "$OUT"
find "$OUT_DIR" -name 'pvd-*.pmtiles' ! -name "pvd-$BUILD.pmtiles" -delete
write_manifest
echo "basemap: wrote $OUT ($(du -h "$OUT" | cut -f1)) from Protomaps build $BUILD"
