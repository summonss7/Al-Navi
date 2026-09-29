# ============================================================
#  Al-Navi — резервная копия проекта в backups\
#
#  В архив (ZIP): все исходники + конфиги + дизайн-референсы.
#  НЕ кладётся: .git, node_modules, dist/, builds/, backups/,
#  кэши сборки (src-tauri\target, src-tauri\gen\schemas).
#  После создания архив проверяется на читаемость (tar -tf).
#  Держатся последние 8 архивов, более старые удаляются.
#
#  Восстановление: распаковать ZIP в папку проекта.
#  Запуск: двойным кликом по backup.bat (обёртка над этим файлом).
# ============================================================

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Set-Location -LiteralPath $PSScriptRoot

$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
if (-not (Test-Path 'backups')) { New-Item -ItemType Directory -Path 'backups' | Out-Null }
$zip = Join-Path 'backups' ("Al-Navi-backup-" + $stamp + ".zip")

$items = @(
    'AGENTS.md', 'README.md', 'CHANGELOG.md',
    'package.json', 'package-lock.json', 'index.html',
    'vite.config.ts', 'svelte.config.js', 'tsconfig.json',
    '.gitignore', 'backup.bat', 'backup.ps1',
    'src', 'src-tauri', 'scripts', 'images',
    'promt.txt'
)

$present = @(); $missing = @()
foreach ($i in $items) {
    if (Test-Path -LiteralPath $i) { $present += $i } else { $missing += $i }
}

Write-Host '============================================================'
Write-Host (" Резервная копия Al-Navi — " + $stamp)
Write-Host '============================================================'
Write-Host ''
if ($missing.Count -gt 0) { Write-Host ("Пропущено, не найдено: " + ($missing -join ', ')) }

Write-Host 'Создаю архив...'
& "$env:SystemRoot\System32\tar.exe" -a -c -f $zip `
    --exclude 'src-tauri/target' `
    --exclude 'src-tauri/gen/schemas' `
    @present
if ($LASTEXITCODE -ne 0) {
    Write-Host ("ОШИБКА: архивация не удалась, код " + $LASTEXITCODE)
    exit 1
}

# проверка целостности: архив должен читаться и быть не пустым
$entryCount = (& "$env:SystemRoot\System32\tar.exe" -tf $zip | Measure-Object -Line).Lines
if ($LASTEXITCODE -ne 0 -or $entryCount -lt 10) {
    Write-Host ("ОШИБКА: архив не прошёл проверку (файлов внутри: " + $entryCount + ")")
    exit 1
}
$sizeMB = [math]::Round((Get-Item -LiteralPath $zip).Length / 1MB, 1)

# Ротация: держать последние 8 архивов (имена с датой сортируются хронологически)
Get-ChildItem -Path 'backups' -Filter 'Al-Navi-backup-*.zip' |
    Sort-Object Name -Descending |
    Select-Object -Skip 8 |
    ForEach-Object {
        Write-Host ("Удаляю старый архив: " + $_.Name)
        Remove-Item -LiteralPath $_.FullName
    }

Write-Host ''
Write-Host '============================================================'
Write-Host (" Готово: " + $zip)
Write-Host ("         " + $entryCount + " файлов, " + $sizeMB + " МБ — проверка целостности пройдена")
Write-Host '============================================================'
