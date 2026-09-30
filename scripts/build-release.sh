#!/usr/bin/env bash
# Al-Navi release build:
#   1. builds the frontend (dist/)
#   2. builds the release exe (GNU toolchain, MSYS2 in PATH — see README)
#   3. copies it to builds/Al-Navi-<version>-<timestamp>.exe
#   4. updates the installed working copy in C:\Al-Navi (created on demand)
# Version comes from Cargo.toml ([package] version) and is also embedded
# in the binary together with the build timestamp (shown in the title bar).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# 1) frontend
echo "==> Building frontend..."
npm run build

# 2) release binary (MSYS2 ucrt64 provides gcc/dlltool for the GNU toolchain).
#    --features custom-protocol embeds the frontend into the exe (what
#    `tauri build` does); without it the window would wait for a dev server.
export PATH="/c/Users/CUSTOM/msys64/ucrt64/bin:$PATH"
echo "==> Building release binary..."
(cd src-tauri && cargo +stable-x86_64-pc-windows-gnu build --release --features custom-protocol)

# 3) version + timestamp -> builds/
VERSION="$(grep -m1 '^version = ' src-tauri/Cargo.toml | sed 's/version = "\(.*\)"/\1/')"
STAMP="$(date +%Y%m%d-%H%M)"
mkdir -p "$ROOT/builds"
OUT="$ROOT/builds/Al-Navi-${VERSION}-${STAMP}.exe"
cp -f src-tauri/target/release/al-navi.exe "$OUT"

echo "==> Done: $OUT"

# 4) update the installed working copy. The exe is a single self-contained
#    file — no DLLs to ship: the GNU build links its runtime statically and
#    WebView2 is a system component (verify with
#    objdump -p src-tauri/target/release/al-navi.exe | grep "DLL Name").
# C:\Al-Navi is a normal user-writable folder, so no elevation/UAC is needed.
PF_DIR="/c/Al-Navi"
SRC_EXE="src-tauri/target/release/al-navi.exe"
if [ -d "$PF_DIR" ] || mkdir -p "$PF_DIR" 2>/dev/null; then
  echo "==> Updating $PF_DIR (the running copy will be closed)..."
  # a running exe cannot be replaced on Windows — unsaved editor docs are lost
  taskkill //IM Al-Navi.exe //F >/dev/null 2>&1 || true
  if cp -f "$SRC_EXE" "$PF_DIR/Al-Navi.exe" 2>/dev/null; then
    echo "    updated"
    # the exe path never changes, so Explorer keeps serving the icon from its
    # per-path cache — desktop shortcuts would keep showing the old icon even
    # for freshly created ones. ie4uinit -show rebuilds the cache (Win10/11,
    # no admin, no Explorer restart). It does NOT touch the small-size caches
    # the taskbar uses — for a stale taskbar pin run scripts/fix-icon-cache.ps1.
    ie4uinit.exe -show >/dev/null 2>&1 || true
  else
    echo "    FAILED — copy $OUT into C:\\Al-Navi manually"
  fi
fi
