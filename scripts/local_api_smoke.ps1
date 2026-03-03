$ErrorActionPreference = "Stop"

$base = $env:ARENA_API_BASE
if ([string]::IsNullOrWhiteSpace($base)) {
  $base = "http://127.0.0.1:3000"
}

$address = "0x1111111111111111111111111111111111111111"
$trace = "smoke-" + [Guid]::NewGuid().ToString("N")

Write-Host "[smoke] base=$base"

$nonceResp = Invoke-RestMethod -Uri "$base/api/v1/auth/siwe/nonce?address=$address" -Method GET -Headers @{ "X-Trace-Id" = $trace }
$nonce = $nonceResp.data.nonce
if (-not $nonce) { throw "nonce not returned" }
Write-Host "[smoke] nonce ok"

$message = "I am $address and nonce $nonce"
$verifyBody = @{
  address = $address
  nonce = $nonce
  message = $message
  signature = "0xdeadbeef"
} | ConvertTo-Json

$verifyResp = Invoke-RestMethod -Uri "$base/api/v1/auth/siwe/verify" -Method POST -ContentType "application/json" -Headers @{ "X-Trace-Id" = $trace } -Body $verifyBody
$token = $verifyResp.data.session_token
if (-not $token) { throw "session token not returned" }
Write-Host "[smoke] verify ok"

$headers = @{
  "Authorization" = "Bearer $token"
  "X-Idempotency-Key" = ("smoke-agent-" + [Guid]::NewGuid().ToString("N"))
  "X-Trace-Id" = $trace
}

$agentBody = @{
  agent_id = "smoke-webhook"
  owner_address = $address
  display_name = "Smoke Webhook"
  connection_type = "webhook"
  endpoint = "http://127.0.0.1:9001/decide"
  enabled = $true
} | ConvertTo-Json

$upsert = Invoke-RestMethod -Uri "$base/api/v1/registry/agents" -Method POST -ContentType "application/json" -Headers $headers -Body $agentBody
if (-not $upsert.data.agent_id) { throw "agent upsert failed" }
Write-Host "[smoke] upsert ok"

$toggleBody = @{ enabled = $false } | ConvertTo-Json
$toggle = Invoke-RestMethod -Uri "$base/api/v1/registry/agents/smoke-webhook/enable" -Method PATCH -ContentType "application/json" -Headers @{ "Authorization" = "Bearer $token"; "X-Trace-Id" = $trace } -Body $toggleBody
if ($toggle.data.enabled -ne $false) { throw "agent disable failed" }
Write-Host "[smoke] disable ok"

$delete = Invoke-RestMethod -Uri "$base/api/v1/registry/agents/smoke-webhook" -Method DELETE -Headers @{ "Authorization" = "Bearer $token"; "X-Trace-Id" = $trace }
if ($delete.removed -ne $true) { throw "agent delete failed" }
Write-Host "[smoke] delete ok"

Write-Host "[smoke] all checks passed"
