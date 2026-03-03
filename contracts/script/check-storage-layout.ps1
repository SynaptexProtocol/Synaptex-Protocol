$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$forge = Join-Path $env:USERPROFILE ".foundry\bin\forge.exe"
if (-not (Test-Path $forge)) {
  throw "forge not found at $forge"
}

$outDir = Join-Path $root "storage-layout"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$targets = @(
  "src/AgentNFA.sol:AgentNFA",
  "src/SeasonSettler.sol:SeasonSettler",
  "src/LearningRootOracle.sol:LearningRootOracle",
  "src/AgentAccount.sol:AgentAccount"
)

foreach ($target in $targets) {
  $name = ($target.Split(":")[1])
  $out = Join-Path $outDir "$name.json"
  & $forge inspect $target storage-layout | Out-File -FilePath $out -Encoding utf8
  Write-Output "wrote $out"
}

Write-Output "storage layout snapshots updated in $outDir"

