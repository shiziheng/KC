#Requires -Version 5.1
<#
  KC-PAY-GPT one-click deploy / start console  (Windows / PowerShell)
  ------------------------------------------------------------------
  Usage (non-technical admin: just double-click the matching .bat):
    powershell -File kc-deploy_20261007.ps1            # interactive menu
    powershell -File kc-deploy_20261007.ps1 start       # start all (default)
    powershell -File kc-deploy_20261007.ps1 stop        # stop all (data kept)
    powershell -File kc-deploy_20261007.ps1 deploy      # pull latest + rebuild + start
    powershell -File kc-deploy_20261007.ps1 inject      # re-apply Xboard frontend injection only
    powershell -File kc-deploy_20261007.ps1 status      # show container status
    powershell -File kc-deploy_20261007.ps1 verify      # compare running containers vs deploy-manifest.json
    powershell -File kc-deploy_20261007.ps1 list        # print the service list from deploy-manifest.json

  SINGLE SOURCE OF TRUTH:
    The service list lives in deploy-manifest.json next to this script. start/stop/deploy/
    status/verify all read it, so adding or renaming a service means editing ONLY the
    manifest -- both the Windows (.ps1) and Linux (.sh) engines follow automatically.
    Run `verify` any time to detect drift between the manifest and what is running.
#>
param(
  [string]$Action
)

$SCRIPT_VERSION = '20261007'
$ErrorActionPreference = 'Continue'

# ============ paths ============
$dockerExe    = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$desktopExe   = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$kcDir        = $PSScriptRoot
$manifestPath = Join-Path $kcDir 'deploy-manifest.json'

# ============ global state ============
$script:docker    = $null
$script:usePlugin = $false
$script:dcExe     = $null

# ============ output helpers ============
function C    { param([string]$fg,[string]$m) Write-Host $m -ForegroundColor $fg }
function Step { param([string]$m) Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok   { param([string]$m) Write-Host "    [OK] $m" -ForegroundColor Green }
function Warn { param([string]$m) Write-Host "    [!] $m" -ForegroundColor Yellow }
function Err  { param([string]$m) Write-Host "    [X] $m" -ForegroundColor Red }

# ============ load manifest (single source of truth) ============
function Load-Manifest {
  if (-not (Test-Path $manifestPath)) {
    Err "deploy-manifest.json not found next to this script ($manifestPath)."
    Err "It is the single source of truth for the service list; restore it before running."
    exit 1
  }
  try {
    $script:manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  } catch {
    Err "deploy-manifest.json is not valid JSON: $($_.Exception.Message)"
    exit 1
  }
  if (-not $script:manifest.services) {
    Err "deploy-manifest.json has no 'services' array."
    exit 1
  }
}

# ============ docker locate ============
function Get-DockerPath {
  if (Test-Path $dockerExe) { return $dockerExe }
  $c = Get-Command docker -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

function Ensure-Docker {
  $p = Get-DockerPath
  if (-not $p) {
    Err "Docker not found. Install Docker Desktop (WSL2 mode):"
    C Yellow "    https://www.docker.com/products/docker-desktop/"
    exit 1
  }
  $script:docker = $p

  & $script:docker compose version >$null 2>&1
  if ($LASTEXITCODE -eq 0) {
    $script:usePlugin = $true
  } else {
    $dc = Get-Command docker-compose -ErrorAction SilentlyContinue
    if ($dc) { $script:dcExe = $dc.Source } else {
      Err "Docker is installed but missing the compose component. Upgrade Docker Desktop."
      exit 1
    }
  }

  & $script:docker info >$null 2>&1
  if ($LASTEXITCODE -ne 0) {
    if (-not (Test-Path $desktopExe)) {
      Err "Docker daemon is not running and Docker Desktop was not found. Start Docker manually and retry."
      exit 1
    }
    Warn "Docker daemon not running. Starting Docker Desktop (wait about 30~60s)..."
    Start-Process $desktopExe
    $t = 0
    while ($t -lt 150) {
      Start-Sleep -Seconds 5; $t += 5
      & $script:docker info >$null 2>&1
      if ($LASTEXITCODE -eq 0) { Ok "Docker is ready"; return }
      Write-Host "." -NoNewline
    }
    Err "Docker start timed out. Open Docker Desktop manually and retry."
    exit 1
  } else {
    Ok "Docker daemon is running"
  }
}

# ============ compose wrapper ============
function Invoke-Compose {
  param([string]$file, [string]$proj, [string[]]$cmdArgs)
  if ($script:usePlugin) {
    & $script:docker compose -f $file -p $proj @cmdArgs
  } else {
    & $script:dcExe -f $file -p $proj @cmdArgs
  }
}

# ============ health check ============
function Wait-Http {
  param([string]$url, [string]$label, [int]$timeout = 120)
  if (-not $url) { return $true }
  Step "Waiting for $label ($url)"
  $t = 0
  while ($t -lt $timeout) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 5 -Method Get
      if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
        Ok "$label is ready (HTTP $($r.StatusCode))"
        return $true
      }
    } catch { }
    Start-Sleep -Seconds 3; $t += 3
    Write-Host "." -NoNewline
  }
  Warn "$label did not respond within ${timeout}s; continuing (verify in browser later)"
  return $false
}

# ============ resolve compose file path (env override > manifest path > candidate search) ============
function Resolve-ComposePath {
  param($svc)
  if ($svc.type -ne 'compose') { return $null }
  if ($env:XBOARD_DIR -and (Test-Path (Join-Path $env:XBOARD_DIR 'docker-compose.yml'))) {
    return Join-Path $env:XBOARD_DIR 'docker-compose.yml'
  }
  $p = Join-Path $kcDir $svc.compose_path
  if (Test-Path $p) { return $p }
  $cands = @(
    (Join-Path $kcDir '..\\Xboard'),
    (Join-Path $kcDir 'Xboard'),
    'D:/tools/Xboard',
    '/opt/xboard'
  )
  foreach ($c in $cands) {
    $cp = Join-Path $c 'docker-compose.yml'
    if (Test-Path $cp) { return $cp }
  }
  return $null
}

# ============ Xboard container patches: check + auto-repair (2026-10-11) ============
# Container rebuilds wipe in-container patches (1/3/4 once lost silently: checkout blocked / wrong commission).
# Delegates to the node tool (same impl as manual/CI): verify first, auto-repair per tools/xboard-patches/README.md.
# NOTE: keep this block ASCII-only -- PowerShell 5.1 mis-decodes UTF-8 Chinese comments in no-BOM files.
function Check-XboardPatches {
  Step "Checking Xboard container patches (auto-repair when missing)"
  $running = & $script:docker ps --filter "name=^xboard$" --format '{{.Names}}' 2>$null
  if (-not $running) { Warn "xboard container not running; skip patch check"; return }

  $nodeExe = $null
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
  if (-not $nodeExe) {
    $guess = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path $guess) { $nodeExe = $guess }
  }
  if (-not $nodeExe) {
    Warn "node not found; skip patch check (manual: node tools/xboard-patch-check.js --fix)"
    return
  }
  $tool = Join-Path $kcDir 'tools/xboard-patch-check.js'
  if (-not (Test-Path $tool)) { Warn "missing $tool; skip patch check"; return }

  & $nodeExe $tool --fix
  if ($LASTEXITCODE -eq 0) { Ok "Xboard patches verified (auto-repaired if needed)" }
  else { Err "Patch check failed - see output above or tools/xboard-patches/README.md" }
}

# ============ Xboard frontend injection (only for services with inject=true) ============
function Apply-XboardInjection {
  Step "Applying Xboard frontend injection (custom_html + cache clear + octane reload)"
  $running = & $script:docker ps --filter "name=^xboard$" --format '{{.Names}}' 2>$null
  if (-not $running) { Warn "xboard container not running; skip injection (start Xboard first)"; return }

  $files = @(
    @{src = (Join-Path $kcDir 'tools/kc_activate_inject.html');   dst = 'xboard:/www/kc_activate_inject.html' },
    @{src = (Join-Path $kcDir 'tools/kc_panel_inject.html');       dst = 'xboard:/www/kc_panel_inject.html' },
    @{src = (Join-Path $kcDir 'tools/kc_theme_inject.html');       dst = 'xboard:/www/kc_theme_inject.html' },
    @{src = (Join-Path $kcDir 'tools/xboard-set-custom-html.php'); dst = 'xboard:/www/xboard-set-custom-html.php' }
  )
  foreach ($f in $files) {
    if (-not (Test-Path $f.src)) { Warn "Missing source file: $($f.src), skip"; return }
    & $script:docker cp $f.src $f.dst
  }
  & $script:docker exec xboard php /www/xboard-set-custom-html.php
  & $script:docker exec xboard php artisan optimize:clear
  & $script:docker exec xboard php artisan octane:reload
  Ok "Frontend injection applied"
  Check-XboardPatches
}

# ============ generic service actions (driven by manifest) ============
function Start-Service {
  param($svc, [bool]$build)
  Step "Starting service: $($svc.name)"
  if ($svc.type -eq 'compose') {
    $file = Resolve-ComposePath $svc
    if (-not $file -or -not (Test-Path $file)) { Err "Cannot find compose file for $($svc.id) (set XBOARD_DIR env or place Xboard next to this folder)"; return }
    foreach ($e in $svc.requires_env) {
      if (-not (Test-Path (Join-Path $kcDir $e))) { Warn "$e missing in KC folder; docker-compose.yml defaults will be used (copy from .env.example and fill in)" }
    }
    $a = @('up', '-d')
    if ($build -and $svc.build) { $a += '--build' }
    Invoke-Compose $file $svc.project $a
  } elseif ($svc.type -eq 'standalone') {
    $exists = & $script:docker ps -a --filter "name=^$($svc.containers[0])$" --format '{{.Names}}' 2>$null
    if (-not $exists) {
      $volParts = $svc.volume -split ':'
      $hostVol = Join-Path $kcDir $volParts[0]
      if (-not (Test-Path $hostVol)) { New-Item -ItemType Directory -Path $hostVol -Force >$null }
      & $script:docker run -d --pull=always --name $svc.containers[0] --restart=unless-stopped `
        -p $svc.ports[0] "-v${hostVol}:$($volParts[1])" $svc.image
    } else {
      & $script:docker start $svc.containers[0] >$null 2>&1
    }
  } else {
    Err "Unknown service type: $($svc.type) for $($svc.id)"
    return
  }
  Wait-Http $svc.health_url $svc.name
  if ($svc.inject) { Apply-XboardInjection }
}

function Stop-Service {
  param($svc)
  Step "Stopping service: $($svc.name)"
  if ($svc.type -eq 'compose') {
    $file = Resolve-ComposePath $svc
    if ($file -and (Test-Path $file)) { Invoke-Compose $file $svc.project @('stop') }
    else { Warn "Cannot find compose file for $($svc.id); skipping" }
  } elseif ($svc.type -eq 'standalone') {
    & $script:docker stop $svc.containers[0] >$null 2>&1
  }
  Ok "Stopped $($svc.name)"
}

function Deploy-Service {
  param($svc)
  Step "Deploying service: $($svc.name)"
  if ($svc.type -eq 'compose') {
    $file = Resolve-ComposePath $svc
    if (-not $file -or -not (Test-Path $file)) { Err "Cannot find compose file for $($svc.id)"; return }
    Invoke-Compose $file $svc.project @('pull')
    $a = @('up', '-d')
    if ($svc.build) { $a += '--build' }
    Invoke-Compose $file $svc.project $a
  } elseif ($svc.type -eq 'standalone') {
    $exists = & $script:docker ps -a --filter "name=^$($svc.containers[0])$" --format '{{.Names}}' 2>$null
    if ($exists) { & $script:docker rm -f $svc.containers[0] >$null 2>&1 }
    $volParts = $svc.volume -split ':'
    $hostVol = Join-Path $kcDir $volParts[0]
    if (-not (Test-Path $hostVol)) { New-Item -ItemType Directory -Path $hostVol -Force >$null }
    & $script:docker run -d --pull=always --name $svc.containers[0] --restart=unless-stopped `
      -p $svc.ports[0] "-v${hostVol}:$($volParts[1])" $svc.image
  }
  Wait-Http $svc.health_url $svc.name
  if ($svc.inject) { Apply-XboardInjection }
}

# ============ open admin urls ============
function Open-Urls {
  Step "Opening admin backends (if not auto-opened, visit manually)"
  foreach ($svc in $script:manifest.services) {
    foreach ($u in $svc.access_urls) {
      try { Start-Process $u | Out-Null; Ok "Opened $u" }
      catch { Warn "Could not open $u automatically; visit manually" }
    }
  }
}

# ============ status ============
function Show-Status {
  Step "Current container status"
  $filters = @()
  foreach ($svc in $script:manifest.services) {
    foreach ($c in $svc.containers) { $filters += '--filter'; $filters += "name=$c" }
  }
  & $script:docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' @filters
  Write-Host ""
  C White "Access URLs:"
  foreach ($svc in $script:manifest.services) {
    foreach ($u in $svc.access_urls) { C White "  $($svc.name): $u" }
  }
}

# ============ verify (drift detection) ============
function Verify-Deploy {
  Step "Verifying running containers against deploy-manifest.json"
  $expected = @()
  foreach ($s in $script:manifest.services) { foreach ($c in $s.containers) { $expected += $c } }

  $running = @(& $script:docker ps --format '{{.Names}}' 2>$null) | Where-Object { $_ }
  $all = @(& $script:docker ps -a --format '{{.Names}}' 2>$null) | Where-Object { $_ }

  $missing = $expected | Where-Object { $running -notcontains $_ }
  $extra   = $running | Where-Object { $expected -notcontains $_ }

  Write-Host ""
  C White "Expected containers from manifest ($($expected.Count)):"
  foreach ($s in $script:manifest.services) {
    foreach ($c in $s.containers) {
      if ($running -contains $c) { C Green "  [UP]   $c  ($($s.name))" }
      elseif ($all -contains $c) { C Yellow "  [DOWN] $c  ($($s.name)) -- container exists but is stopped" }
      else { C Red "  [MISS] $c  ($($s.name)) -- not created" }
    }
  }
  if ($extra.Count -gt 0) {
    Write-Host ""
    Warn "Running containers NOT in manifest (drift):"
    foreach ($e in $extra) { Warn "  $e" }
  }

  Write-Host ""
  $upCount = ($expected | Where-Object { $running -contains $_ }).Count
  if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
    Ok "All $upCount/$($expected.Count) expected containers are running and no drift detected."
  } else {
    if ($missing.Count -gt 0) { Err "$($missing.Count) expected container(s) missing/down." }
    if ($extra.Count -gt 0) { Warn "$($extra.Count) unexpected container(s) running (not defined in manifest)." }
    Err "Verification found drift. Edit deploy-manifest.json to align, or start/stop services to match."
  }
}

# ============ list (manifest table, no docker needed) ============
function List-Services {
  Step "Service list from deploy-manifest.json (manifest_version $($script:manifest.manifest_version))"
  Write-Host ""
  foreach ($s in $script:manifest.services) {
    C Cyan "  [$($s.id)] $($s.name)  <$($s.type)>"
    C White "      containers : $($s.containers -join ', ')"
    C White "      ports      : $($s.ports -join ', ')"
    if ($s.type -eq 'compose') { C White "      compose    : $($s.compose_path) (project $($s.project))" }
    else { C White "      image      : $($s.image)  volume: $($s.volume)" }
    if ($s.health_url) { C White "      health     : $($s.health_url)" }
    C White "      access     : $($s.access_urls -join ', ')"
    C White "      inject     : $($s.inject)"
  }
  Write-Host ""
  C White "To add/remove/rename a service, edit deploy-manifest.json only; both engines follow automatically."
}

# ============ interactive menu ============
function Show-Menu {
  Write-Host ""
  Write-Host "===== KC-PAY-GPT one-click console =====" -ForegroundColor White
  Write-Host "  1) Start all (default)" -ForegroundColor Green
  Write-Host "  2) Stop all" -ForegroundColor Yellow
  Write-Host "  3) Deploy update (pull latest + rebuild)" -ForegroundColor Cyan
  Write-Host "  4) Re-apply Xboard frontend injection only" -ForegroundColor Cyan
  Write-Host "  5) Show status" -ForegroundColor White
  Write-Host "  6) Verify running vs manifest (drift check)" -ForegroundColor White
  Write-Host "  7) List services from manifest" -ForegroundColor White
  Write-Host "  q) Quit" -ForegroundColor White
  $c = Read-Host "Choose (1/2/3/4/5/6/7/q)"
  switch ($c) {
    '1'     { $script:Action = 'start' }
    '2'     { $script:Action = 'stop' }
    '3'     { $script:Action = 'deploy' }
    '4'     { $script:Action = 'inject' }
    '5'     { $script:Action = 'status' }
    '6'     { $script:Action = 'verify' }
    '7'     { $script:Action = 'list' }
    'q'     { $script:Action = 'quit' }
    default { $script:Action = 'start' }
  }
}

# ============ main ============
Load-Manifest
if (-not $Action) { Show-Menu }

if ($Action -eq 'quit') { exit 0 }

C White "KC-PAY-GPT one-click deploy console  (version $SCRIPT_VERSION)"
if ($Action -ne 'list') { Ensure-Docker }

switch ($Action) {
  'start'  { foreach ($svc in $script:manifest.services) { Start-Service $svc $false }; Show-Status; Open-Urls }
  'stop'   { foreach ($svc in $script:manifest.services) { Stop-Service $svc }; Show-Status }
  'deploy' { foreach ($svc in $script:manifest.services) { Deploy-Service $svc }; Show-Status; Open-Urls }
  'inject' { Apply-XboardInjection; Show-Status }
  'status' { Show-Status }
  'verify' { Verify-Deploy }
  'list'   { List-Services }
  default  { Err "Unknown action: $Action" }
}

Write-Host ""
C White "Done. The window stays open; press any key to close."