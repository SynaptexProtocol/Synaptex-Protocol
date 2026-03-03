$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$node = "C:\Users\yhxu4\AppData\Local\nvm\v20.20.0\node.exe"
$arenaCmd = "cli/dist/index.js"

$env:ARENA_AGENT_SECRET_DEMO_WEBHOOK = "local-dev-secret"
$env:PATH = "C:\Users\yhxu4\AppData\Local\nvm\v20.20.0;C:\Users\yhxu4\AppData\Roaming\npm;" + $env:PATH

$mockWebhook = $null
$arena = $null
try {
  Write-Host "[e2e] starting mock webhook..."
  $mockWebhook = Start-Process -FilePath "python" -ArgumentList "scripts/mock_webhook_agent.py" -WorkingDirectory $root -PassThru -WindowStyle Hidden

  Write-Host "[e2e] starting arena..."
  $arena = Start-Process -FilePath $node -ArgumentList "$arenaCmd arena start --config config/arena.yaml --agent-config config/agent.yaml" -WorkingDirectory $root -PassThru -WindowStyle Hidden

  Write-Host "[e2e] waiting for API health..."
  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    try {
      $h = Invoke-RestMethod -Uri "http://127.0.0.1:3000/health" -Method GET -TimeoutSec 2
      if ($h.ok) { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw "arena API not healthy in time" }

  Write-Host "[e2e] running API smoke..."
  & powershell -ExecutionPolicy Bypass -File "$root\scripts\local_api_smoke.ps1"
  if ($LASTEXITCODE -ne 0) { throw "local_api_smoke failed" }

  Write-Host "[e2e] done"
} finally {
  if ($arena -and -not $arena.HasExited) {
    Stop-Process -Id $arena.Id -Force -ErrorAction SilentlyContinue
  }
  if ($mockWebhook -and -not $mockWebhook.HasExited) {
    Stop-Process -Id $mockWebhook.Id -Force -ErrorAction SilentlyContinue
  }
}

