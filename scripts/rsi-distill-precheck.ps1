<#
.SYNOPSIS
  Pre-write cap & backlog circuit-breaker guard for Hermes nightly Distill (JOB-002).
  Exits 0 if the planned write is permitted, or 1 with the exact refusal reason.
.EXAMPLE
  pwsh -NoProfile -File scripts/rsi-distill-precheck.ps1 -Cards 4 -Skills 1
  pwsh -NoProfile -File scripts/rsi-distill-precheck.ps1 -Cards 2 -Skills 1 -DemandSignal
#>
param(
  [string]$RunDate = (Get-Date -Format "yyyy-MM-dd"),
  [Parameter(Mandatory = $true)][int]$Cards,
  [Parameter(Mandatory = $true)][int]$Skills,
  [string]$SkillsDir = "G:\My Drive\Obsidian\Brain\60 Skills",
  [int]$MaxDrafts = 20,
  [switch]$DemandSignal
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$cli = Join-Path $repoRoot "bin\rsi-gate.mjs"

$argsList = @(
  $cli, "caps", "--precheck",
  "--run-date", $RunDate,
  "--cards", "$Cards",
  "--skills", "$Skills",
  "--skills-dir", $SkillsDir,
  "--max-drafts", "$MaxDrafts"
)
if ($DemandSignal) { $argsList += "--demand-signal" }

& node @argsList
exit $LASTEXITCODE
