<#
  openGym on Windows: one command to build and (re)start everything.

  Installs API deps, builds the frontend, fetches exercise media if missing, then starts
  or reloads both PM2 apps and saves the PM2 dump so they resurrect on boot.
  Safe to re-run: this is also the update command after `git pull`.

  Run from an *Administrator* PowerShell. The PM2 daemon is started at boot by the S4U task
  with RunLevel=Highest, so a non-elevated shell gets EPERM on its pipe (and spawns a stray
  daemon trying):
    powershell -ExecutionPolicy Bypass -File C:\Users\jwcb2\opengym\app\host\build.ps1
#>
param([switch]$SkipInstall)

$ErrorActionPreference = 'Stop'
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host 'Run this from an Administrator PowerShell (the PM2 daemon is elevated).' -ForegroundColor Red; exit 1 }
$App  = Split-Path $PSScriptRoot -Parent
$Pm2  = "$env:APPDATA\npm\pm2.cmd"
$Env  = Join-Path $App '.env'

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Run($exe, [string[]]$argv, $cwd) {
  # npm writes notices to stderr; judge success by exit code, not by stderr
  Push-Location $cwd
  try {
    $ErrorActionPreference = 'Continue'
    & $exe @argv 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3 | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed (exit $LASTEXITCODE)" }
  } finally { $ErrorActionPreference = 'Stop'; Pop-Location }
}
function Probe($url) {
  for ($i = 0; $i -lt 10; $i++) {
    try { $r = Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 5; return $r.StatusCode } catch { Start-Sleep 2 }
  }
  return 'DOWN'
}

# --- config -------------------------------------------------------------------
if (-not (Test-Path $Env)) {
  Copy-Item (Join-Path $PSScriptRoot 'env.example') $Env
  Write-Host "Created $Env from env.example. Set ACCESS_PIN in it, then re-run." -ForegroundColor Yellow
  exit 1
}
$pin = (Select-String -Path $Env -Pattern '^\s*ACCESS_PIN=(.*)$' | Select-Object -First 1).Matches.Groups[1].Value.Trim()
if (-not $pin) { Write-Host "ACCESS_PIN is empty in $Env - set it, then re-run." -ForegroundColor Yellow; exit 1 }

New-Item -ItemType Directory -Force (Join-Path $App 'data'), (Join-Path $PSScriptRoot 'logs') | Out-Null

# --- build --------------------------------------------------------------------
if (-not $SkipInstall) {
  Step 'API dependencies'
  Run 'npm' @('ci', '--omit=dev', '--include=optional') (Join-Path $App 'api')
  Step 'Frontend dependencies'
  Run 'npm' @('ci') (Join-Path $App 'frontend')
}
Step 'Frontend build'
Run 'npm' @('run', 'build') (Join-Path $App 'frontend')

$img = Join-Path $App 'media\img'
if (-not (Test-Path $img) -or -not (Get-ChildItem $img -Filter *.jpg | Select-Object -First 1)) {
  Step 'Exercise media (~140 MB, one time)'
  $tmp = Join-Path $env:TEMP "opengym-media-$(Get-Random)"
  Run 'git' @('clone', '--depth', '1', 'https://github.com/hasaneyldrm/exercises-dataset', $tmp) $App
  New-Item -ItemType Directory -Force $img, (Join-Path $App 'media\gif') | Out-Null
  Copy-Item "$tmp\images\*.jpg" $img
  Copy-Item "$tmp\videos\*.gif" (Join-Path $App 'media\gif')
  Remove-Item $tmp -Recurse -Force
}

# --- run ----------------------------------------------------------------------
Step 'PM2 start/reload'
Run $Pm2 @('startOrReload', (Join-Path $PSScriptRoot 'ecosystem.config.cjs'), '--update-env') $App
Run $Pm2 @('save') $App

Step 'Health'
Write-Host ("    api  :4201  {0}" -f (Probe 'http://127.0.0.1:4201/api/health'))
Write-Host ("    web  :4200  {0}" -f (Probe 'http://127.0.0.1:4200/__health'))
Write-Host ("    HomeDash :4000  {0}" -f (Probe 'http://127.0.0.1:4000/health'))
