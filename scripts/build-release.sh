#!/usr/bin/env bash
# Al-Navi release build:
#   1. builds the frontend (dist/)
#   2. builds the release exe (GNU toolchain, MSYS2 in PATH — see README)
#   3. copies it to builds/Al-Navi-<version>-<timestamp>.exe
# Version comes from Cargo.toml ([package] version) and is also embedded
# in the binary together with the build timestamp (shown in the title bar).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1) frontend
echo "==> Building frontend..."
npm run build

# 2) release binary (MSYS2 ucrt64 provides gcc/dlltool for the GNU toolchain)
export PATH="/c/Users/CUSTOM/msys64/ucrt64/bin:$PATH"
echo "==> Building release binary..."
(cd src-tauri && cargo +stable-x86_64-pc-windows-gnu build --release)

# 3) version + timestamp -> builds/
VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed 's/version = "\(.*\)"/\1/')"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p "$ROOT/builds"
OUT="$ROOT/builds/Al-Navi-${VERSION}-${STAMP}.exe"
cp -f src-tauri/target/release/al-navi.exe "$OUT"

echo "==> Done: $OUT"
