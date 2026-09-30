# Al-Navi: rebuild Windows shell icon caches (run manually, no admin needed).
# Use case: after the app icon changed, desktop shortcuts pick up the new icon
# (build-release.sh already runs `ie4uinit -show` for that), but the taskbar
# keeps serving stale 16-32px icons from iconcache_16/32.db — those per-path
# entries survive `ie4uinit` because the pinned exe path never changes.
#
# What it does: stops Explorer, deletes the icon cache databases, restarts
# Explorer (Windows rebuilds them from the exe resources on demand).
# Side effects: open File Explorer windows close; the taskbar/desktop blink
# for a few seconds. Other applications are not affected.
#
# Afterwards re-pin the taskbar icon if it still shows the old glyph
# (unpin, then pin again — ideally from the auto-updated working copy
# C:\Al-Navi\Al-Navi.exe, not a manual Desktop copy of the exe).

$ErrorActionPreference = 'Continue'

$explorerDir = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Explorer'
$caches = @(Get-ChildItem -Path $explorerDir -Filter 'iconcache_*.db' -ErrorAction SilentlyContinue)
$legacy = Join-Path $env:LOCALAPPDATA 'IconCache.db'
if (Test-Path -LiteralPath $legacy) { $caches += Get-Item -LiteralPath $legacy }

if (-not $caches) {
    Write-Host 'No icon cache files found — nothing to do.'
    exit 0
}

Write-Host "Stopping Explorer..."
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

# Explorer may take a moment to release the handles; retry a few times.
$left = @()
foreach ($attempt in 1..5) {
    $left = @()
    foreach ($f in $caches) {
        try { Remove-Item -LiteralPath $f.FullName -Force -ErrorAction Stop } catch { $left += $f }
    }
    if (-not $left) { break }
    Start-Sleep -Seconds 1
}

foreach ($f in $caches) {
    if ($left -notcontains $f) { Write-Host "deleted  $($f.Name)" }
}
foreach ($f in $left) { Write-Host "LOCKED  $($f.Name) (skip)" }

Write-Host "Starting Explorer..."
Start-Process explorer.exe
Start-Sleep -Seconds 2

if ($left) {
    Write-Host ''
    Write-Host 'Some cache files were locked. Close File Explorer windows and run again.'
    exit 1
}
Write-Host 'Done. If the taskbar still shows the old icon, unpin and re-pin it.'
