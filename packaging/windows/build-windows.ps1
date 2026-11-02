# Builds dist\BrainLink-Setup-<version>.exe on Windows.
# Needs: PowerShell 7 and Inno Setup 6 (iscc.exe on PATH or default location).
# Optional signing: set $env:BRAINLINK_SIGN=1 and configure the "brainlink" sign tool (see BrainLink.iss).
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path "$Here\..\.."
$Version = (Get-Content "$Root\package.json" | ConvertFrom-Json).version
$NodeVersion = (Get-Content "$Root\vendor\node\VERSION").Trim()
$NodeDist = "https://nodejs.org/dist/v$NodeVersion"
$NodeArchivePrefix = "node-v$NodeVersion"
$Stage = "$Root\build\windows\stage"
Remove-Item -Recurse -Force "$Root\build\windows" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$Stage\node", "$Stage\app", "$Root\vendor\node" | Out-Null

# 1. Official Node runtime, checksum-verified.
$Zip = "$NodeArchivePrefix-win-x64.zip"
$ZipPath = "$Root\vendor\node\$Zip"
if (-not (Test-Path "$Root\vendor\node\SHASUMS256.txt")) { Invoke-WebRequest "$NodeDist/SHASUMS256.txt" -OutFile "$Root\vendor\node\SHASUMS256.txt" }
if (-not (Test-Path $ZipPath)) { Invoke-WebRequest "$NodeDist/$Zip" -OutFile $ZipPath }
$SumLine = Select-String -Path "$Root\vendor\node\SHASUMS256.txt" -Pattern " $Zip$" | Select-Object -First 1
if (-not $SumLine) { throw "No official checksum found for $Zip" }
$Expected = $SumLine.Line.Split(" ")[0]
$Actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) { throw "Checksum mismatch for $Zip" }
Expand-Archive $ZipPath -DestinationPath "$Root\build\windows\node-unzip"
Copy-Item "$Root\build\windows\node-unzip\$NodeArchivePrefix-win-x64\node.exe", "$Root\build\windows\node-unzip\$NodeArchivePrefix-win-x64\LICENSE" "$Stage\node\"

# 2. App files (no tests, tools, vendor or keys).
foreach ($p in "bin", "src", "ui", "samples", "skills", "package.json", "LICENSE.txt", "README.md") { Copy-Item -Recurse "$Root\$p" "$Stage\app\" }
Remove-Item -Recurse -Force "$Stage\app\ui\app\test" -ErrorAction SilentlyContinue
$Store = "$Stage\app\node_modules\brainlink-store"
New-Item -ItemType Directory -Force $Store | Out-Null
foreach ($p in "memory-store.mjs", "errors.mjs", "package.json") { Copy-Item "$Root\vendor\brainlink-store\$p" $Store }
$Yaml = "$Stage\app\node_modules\yaml"
New-Item -ItemType Directory -Force $Yaml | Out-Null
Copy-Item -Recurse "$Root\node_modules\yaml\*" $Yaml
$Pdfjs = "$Stage\app\node_modules\pdfjs-dist"
New-Item -ItemType Directory -Force $Pdfjs | Out-Null
Copy-Item -Recurse "$Root\node_modules\pdfjs-dist\*" $Pdfjs

# 3. Installer.
$env:BRAINLINK_VERSION = $Version
$IsccCommand = Get-Command iscc.exe -ErrorAction SilentlyContinue
$IsccCandidates = @()
if ($IsccCommand) { $IsccCandidates += $IsccCommand.Source }
$IsccCandidates += @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
)
$Iscc = $IsccCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $Iscc) { throw 'Inno Setup 6 compiler not found. Install it per-user or system-wide, or add ISCC.exe to PATH.' }
$IsccArgs = @("$Here\BrainLink.iss")
if ($env:BRAINLINK_SIGN -eq "1") { $IsccArgs = @("/DSIGN") + $IsccArgs }
& $Iscc @IsccArgs
if ($LASTEXITCODE -ne 0) { throw "Inno Setup compiler failed with exit code $LASTEXITCODE" }
Get-FileHash "$Root\dist\BrainLink-Setup-$Version.exe" -Algorithm SHA256 | Format-List
