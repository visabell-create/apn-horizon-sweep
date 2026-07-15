# Autonomous next-batch helper
# On each AGENT_LOOP_TICK_apn_horizon:
# 1. Read state/cursor.json -> nextCursor, horizonQueue, donePages
# 2. Open portal.assessor.lacounty.gov/parceldetail/{digits}
# 3. Run perpetual-horizon-v1 with MAX_CHECKS=280 (same pace)
# 4. Archive under runs/RUN-NNN-YYYY-MM-DD-horizon/
# 5. Update state/cursor.json + runs/INDEX.md
# 6. Immediately continue — never halt

$ErrorActionPreference = "Stop"
$Root = "C:\Users\Authorized User\apn-horizon-sweep"
$state = Get-Content -Raw (Join-Path $Root "state\cursor.json") | ConvertFrom-Json
$n = ($state.completedRuns | Measure-Object).Count + 1
$runId = "RUN-{0:D3}" -f $n
$digits = $state.nextCursor -replace '-',''
@{
  runId = $runId
  startAin = $digits
  nextCursor = $state.nextCursor
  queueCount = @($state.horizonQueue).Count
  doneCount = @($state.donePages).Count
  maxChecks = 280
  softJump = 12
  hardJump = 20
  message = "Ready for agent CDP horizon sweep"
} | ConvertTo-Json | Set-Content (Join-Path $Root "state\next_job.json") -Encoding UTF8
Write-Output "Prepared $runId start=$($state.nextCursor)"
