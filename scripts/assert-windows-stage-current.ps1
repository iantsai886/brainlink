param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][string]$Stage
)
$ErrorActionPreference = 'Stop'
$StaleFiles = [System.Collections.Generic.List[string]]::new()
foreach ($Tree in @('bin', 'src', 'ui', 'samples', 'skills')) {
  $SourceDirectory = Join-Path $Root $Tree
  $StagedDirectory = Join-Path $Stage "app\$Tree"
  if (-not (Test-Path -LiteralPath $StagedDirectory -PathType Container)) {
    $StaleFiles.Add("$Tree (missing staged directory)")
    continue
  }
  foreach ($SourceFile in Get-ChildItem -LiteralPath $SourceDirectory -Recurse -File) {
    $RelativePath = [System.IO.Path]::GetRelativePath($SourceDirectory, $SourceFile.FullName)
    if ($Tree -eq 'ui' -and $RelativePath -match '^app[\\/]test([\\/]|$)') { continue }
    $StagedFile = Join-Path $StagedDirectory $RelativePath
    if (-not (Test-Path -LiteralPath $StagedFile -PathType Leaf)) {
      $StaleFiles.Add("$Tree\$RelativePath (missing)")
      continue
    }
    if ((Get-FileHash -LiteralPath $SourceFile.FullName -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $StagedFile -Algorithm SHA256).Hash) {
      $StaleFiles.Add("$Tree\$RelativePath (content differs)")
    }
  }
}
foreach ($File in @('package.json', 'LICENSE.txt', 'README.md')) {
  $SourceFile = Join-Path $Root $File
  $StagedFile = Join-Path $Stage "app\$File"
  if (-not (Test-Path -LiteralPath $StagedFile -PathType Leaf) -or (Get-FileHash -LiteralPath $SourceFile -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $StagedFile -Algorithm SHA256).Hash) {
    $StaleFiles.Add("$File (missing or content differs)")
  }
}
if ($StaleFiles.Count) {
  $Details = ($StaleFiles | Select-Object -First 8) -join ', '
  throw "The Windows package stage is stale ($Details). Run packaging/windows/build-windows.ps1 before the package smoke test."
}
Write-Output 'PASS: Windows package stage matches all current bundled source files.'
