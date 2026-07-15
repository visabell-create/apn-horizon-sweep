# Always-on APN horizon sweep — local background starter (INDEFINITE)
#
# Usage:
#   .\scripts\always-on-sweep.ps1              # start loop in background
#   .\scripts\always-on-sweep.ps1 -Foreground # run in this terminal
#   .\scripts\always-on-sweep.ps1 -Stop       # stop via flag + PID kill
#   .\scripts\always-on-sweep.ps1 -Once       # single cycle then exit

param(
    [switch]$Foreground,
    [switch]$Stop,
    [switch]$Once,
    [int]$MaxChecks = 180,
    [int]$SleepSec = 90,
    [switch]$NoGit
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$PidFile = Join-Path $Root "state\always-on.pid"
$LogFile = Join-Path $Root "state\always-on.log"
$StopFlag = Join-Path $Root "state\ALWAYS_ON_STOP"

function Get-TrackedPid {
    if (-not (Test-Path $PidFile)) { return $null }
    $raw = (Get-Content $PidFile -Raw).Trim()
    if ($raw -match '^\d+$') { return [int]$raw }
    return $null
}

if ($Stop) {
    New-Item -ItemType File -Force -Path $StopFlag | Out-Null
    Write-Host "Wrote stop flag: $StopFlag"
    $trackedPid = Get-TrackedPid
    if (-not $trackedPid) {
        Write-Host "No PID in $PidFile"
        exit 0
    }
    Start-Sleep -Seconds 2
    $alive = Get-Process -Id $trackedPid -ErrorAction SilentlyContinue
    if ($alive) {
        try {
            Stop-Process -Id $trackedPid -Force -ErrorAction Stop
            Write-Host "Force-stopped always-on pid $trackedPid"
        } catch {
            Write-Host "Could not kill $trackedPid - check manually."
        }
    } else {
        Write-Host "Process $trackedPid already exited."
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue
    exit 0
}

# Starting means indefinite - clear leftover stop flag
Remove-Item $StopFlag -Force -ErrorAction SilentlyContinue

$existing = Get-TrackedPid
if ($existing) {
    $alive = Get-Process -Id $existing -ErrorAction SilentlyContinue
    if ($alive) {
        Write-Host "INDEFINITE always-on already running as pid $existing (log: $LogFile)"
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$nodeArgs = @("scripts\always-on-sweep.mjs")
if ($Once) {
    $nodeArgs += "--once"
} else {
    $nodeArgs += "--loop"
}
$nodeArgs += "--max-checks=$MaxChecks"
$nodeArgs += "--sleep-sec=$SleepSec"
if ($NoGit) { $nodeArgs += "--no-git" }

if ($Foreground -or $Once) {
    Write-Host "Running: node $($nodeArgs -join ' ')"
    & node @nodeArgs
    exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
$ErrLog = Join-Path $Root "state\always-on.err.log"
$proc = Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrLog `
    -PassThru

Set-Content -Path $PidFile -Value "$($proc.Id)" -NoNewline
Write-Host "Started INDEFINITE always-on pid=$($proc.Id)"
Write-Host "  PID file: $PidFile"
Write-Host "  Log:      $LogFile"
Write-Host "  Err log:  $ErrLog"
Write-Host "  Stop:     .\scripts\always-on-sweep.ps1 -Stop"
Write-Host "  Or:       New-Item state\ALWAYS_ON_STOP"
