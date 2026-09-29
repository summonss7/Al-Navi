#!/usr/bin/env bash
# Al-Navi release build:
#   1. builds the frontend (dist/)
#   2. builds the release exe (GNU toolchain, MSYS2 in PATH — see README)
#   3. copies it to builds/Al-Navi-<version>-<timestamp>.exe
#   4. updates the installed working copy in C:\Program Files\Al-Navi (if any)
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

# 4) update the installed working copy. The exe is a single self-contained
#    file — no DLLs to ship: the GNU build links its runtime statically and
#    WebView2 is a system component (verify with
#    objdump -p src-tauri/target/release/al-navi.exe | grep "DLL Name").
PF_DIR="/c/Program Files/Al-Navi"
SRC_EXE="src-tauri/target/release/al-navi.exe"
if [ -d "$PF_DIR" ]; then
  echo "==> Updating $PF_DIR (the running copy will be closed)..."
  # a running exe cannot be replaced on Windows — unsaved editor docs are lost
  taskkill //IM Al-Navi.exe //F >/dev/null 2>&1 || true
  if cp -f "$SRC_EXE" "$PF_DIR/Al-Navi.exe" 2>/dev/null; then
    echo "    updated"
  else
    echo "    write denied — retrying elevated (confirm the UAC prompt)..."
    EXE_WIN="$(cygpath -w "$ROOT/$SRC_EXE")"
    PS_TMP="$(mktemp --suffix=.ps1)"
    printf "Copy-Item -LiteralPath '%s' -Destination 'C:\\Program Files\\Al-Navi\\Al-Navi.exe' -Force\n" "$EXE_WIN" > "$PS_TMP"
    powershell -NoProfile -Command \
      "Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$(cygpath -w "$PS_TMP")'" \
      >/dev/null 2>&1 || true
    rm -f "$PS_TMP"
    SRC_SIZE="$(stat -c %s "$SRC_EXE")"
    DST_SIZE="$(stat -c %s "$PF_DIR/Al-Navi.exe" 2>/dev/null || echo 0)"
    if [ "$SRC_SIZE" = "$DST_SIZE" ]; then
      echo "    updated (elevated)"
    else
      echo "    FAILED — copy $OUT into C:\\Program Files\\Al-Navi manually"
    fi
  fi
else
  echo "==> No installed copy at C:\\Program Files\\Al-Navi — skipping"
fi
