<#
  openGym nightly backup: zip app\data into opengym\backups\opengym-YYYY-MM-DD.zip, keep the newest 30.

  Run daily by the S4U task `openGym-Backup` (registered by Claude, 2026-10-22). Safe to run by hand
  from any shell; it never touches PM2. data\ is copied to a staging folder first so a write in
  progress can't leave a half-written file in the zip.
    powershell -ExecutionPolicy Bypass -File C:\Users\jwcb2\opengym\app\host\backup.ps1

  Restore: stop the api (`pm2 stop opengym-api`, admin shell), move app\data aside, expand the zip
  into app\data, `pm2 start opengym-api`. See host\UPDATE.md.
#>
param(
  [string]$DestDir = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'backups'),
  [int]$Keep = 30
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$App     = Split-Path $PSScriptRoot -Parent
$Data    = Join-Path $App 'data'
$LogFile = Join-Path $PSScriptRoot 'logs\backup.log'
New-Item -ItemType Directory -Force $DestDir, (Split-Path $LogFile) | Out-Null

function Write-Log($msg) {
  "[{0:yyyy-MM-dd HH:mm:ss}] {1}" -f (Get-Date), $msg | Add-Content -Path $LogFile -Encoding utf8
}

$stage = Join-Path $env:TEMP "opengym-backup-$(Get-Random)"
try {
  if (-not (Test-Path (Join-Path $Data 'db.json'))) { throw "no db.json in $Data - refusing to write an empty backup" }

  Copy-Item $Data $stage -Recurse
  $zip = Join-Path $DestDir ('opengym-{0:yyyy-MM-dd}.zip' -f (Get-Date))
  $tmp = "$zip.partial"
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $tmp, [IO.Compression.CompressionLevel]::Optimal, $false)
  Move-Item $tmp $zip -Force   # same-day re-run replaces that day's zip

  $files = (Get-ChildItem $stage -Recurse -File).Count
  Write-Log ("OK {0} ({1} files, {2:N1} KB)" -f (Split-Path $zip -Leaf), $files, ((Get-Item $zip).Length / 1KB))

  $old = Get-ChildItem $DestDir -Filter 'opengym-*.zip' | Sort-Object Name -Descending | Select-Object -Skip $Keep
  foreach ($f in $old) { Remove-Item $f.FullName -Force; Write-Log "pruned $($f.Name)" }
} catch {
  Write-Log "FAILED: $($_.Exception.Message)"
  exit 1
} finally {
  if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
}
