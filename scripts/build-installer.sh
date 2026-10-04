#!/usr/bin/env bash
# Al-Navi Windows setup (M8): packs the freshly built release exe with Inno
# Setup into builds/Al-Navi-Setup-<version>-<stamp>.exe.
#
# Prereq: the release exe exists at src-tauri/target/release/al-navi.exe
# (scripts/build-release.sh builds it; build-release.sh also calls this
# script automatically when ISCC is found).
#
# Inno Setup itself is a per-user install, no admin needed:
#   winget install --id JRSoftware.InnoSetup --scope user
# (or download from https://jrsoftware.org/isdl.php). Override the compiler
# path via  ISCC=/path/to/ISCC.exe scripts/build-installer.sh
#
# Usage: scripts/build-installer.sh [stamp]   (stamp defaults to now)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

STAMP="${1:-$(date +%Y%m%d-%H%M)}"

# Inno Setup compiler: env override -> per-user winget location -> machine
ISCC="${ISCC:-}"
if [ -z "$ISCC" ]; then
  for cand in \
    "$LOCALAPPDATA/Programs/Inno Setup 6/ISCC.exe" \
    "/c/Program Files (x86)/Inno Setup 6/ISCC.exe"; do
    if [ -x "$cand" ]; then ISCC="$cand"; break; fi
  done
fi
if [ -z "$ISCC" ]; then
  echo "!! Inno Setup (ISCC.exe) not found." >&2
  echo "   Install per-user without admin:" >&2
  echo "   winget install --id JRSoftware.InnoSetup --scope user" >&2
  exit 1
fi

EXE="src-tauri/target/release/al-navi.exe"
if [ ! -f "$EXE" ]; then
  echo "!! $EXE not found — run scripts/build-release.sh first." >&2
  exit 1
fi

VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed 's/version = "\(.*\)"/\1/')"
mkdir -p "$ROOT/builds"

# MSYS bash rewrites arguments that look like Unix paths (/D..., /O...)
# into Windows paths — disable the conversion for this call.
export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL="*"
BUILDS_WIN="$(cygpath -w "$ROOT/builds")"
echo "==> Compiling setup (Inno Setup ${VERSION}, ${STAMP})..."
"$ISCC" /DAppVersion="$VERSION" /DStamp="$STAMP" /O"$BUILDS_WIN" \
  "$(cygpath -w "$ROOT/scripts/al-navi.iss")"

OUT="$ROOT/builds/Al-Navi-Setup-${VERSION}-${STAMP}.exe"
if [ ! -f "$OUT" ]; then
  echo "!! ISCC reported success but $OUT is missing" >&2
  exit 1
fi
echo "==> Done: $OUT"
