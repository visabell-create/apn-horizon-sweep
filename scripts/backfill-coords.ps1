# Indefinite LA County Assessor coords backfill - local background starter
#
# Usage:
#   .\scripts\backfill-coords.ps1              # start indefinite loop in background
#   .\scripts\backfill-coords.ps1 -Foreground  # run in this terminal
#   .\scripts\backfill-coords.ps1 -Stop        # stop via flag + PID kill
#   .\scripts\backfill-coords.ps1 -Once        # one pass then exit
#   .\scripts\backfill-coords.ps1 -Batch 100   # process up to 100 pending then exit

param(
    [switch]$Foreground,
    [switch]$Stop,
    [switch]$Once,
    [int]$Batch = 0,
    [int]$SleepSec = 120,
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$PidFile = Join-Path $Root "state\coords-backfill.pid"
$LogFile = Join-Path $Root "state\coords-backfill.log"
$StopFlag = Join-Path $Root "state\COORDS_BACKFILL_STOP"

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
            Write-Host "Force-stopped coords-backfill pid $trackedPid"
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
if ($existing -and -not $Once -and $Batch -eq 0) {
    $alive = Get-Process -Id $existing -ErrorAction SilentlyContinue
    if ($alive) {
        Write-Host "INDEFINITE coords backfill already running as pid $existing (log: $LogFile)"
        exit 0
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

$nodeArgs = @("scripts\backfill-coords.mjs")
if ($Once) {
    Write-Host "One-pass mode"
} elseif ($Batch -gt 0) {
    $nodeArgs += "--batch=$Batch"
} else {
    $nodeArgs += "--loop"
    $nodeArgs += "--sleep-sec=$SleepSec"
}
if ($NoBuild) { $nodeArgs += "--no-build" }

if ($Foreground -or $Once -or $Batch -gt 0) {
    Write-Host "Running: node $($nodeArgs -join ' ')"
    & node @nodeArgs
    exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
$ErrLog = Join-Path $Root "state\coords-backfill.err.log"
$proc = Start-Process -FilePath "node" `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $LogFile `
    -RedirectStandardError $ErrLog `
    -PassThru

Set-Content -Path $PidFile -Value "$($proc.Id)" -NoNewline
Write-Host "Started INDEFINITE coords backfill pid=$($proc.Id)"
Write-Host "  PID file: $PidFile"
Write-Host "  Log:      $LogFile"
Write-Host "  Err log:  $ErrLog"
Write-Host "  Status:   state\status\COORDS-BACKFILL.md"
Write-Host "  Stop:     .\scripts\backfill-coords.ps1 -Stop"
Write-Host "  Or:       New-Item state\COORDS_BACKFILL_STOP"
