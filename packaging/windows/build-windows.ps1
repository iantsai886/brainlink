# Builds dist\BrainLink-Setup-<version>.exe on Windows.
# Needs: PowerShell 7 and Inno Setup 6 (iscc.exe on PATH or default location).
# Optional signing: set $env:BRAINLINK_SIGN=1 and configure the "brainlink" sign tool (see BrainLink.iss).
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = Resolve-Path "$Here\..\.."
$Version = (Get-Content "$Root\package.json" | ConvertFrom-Json).version
$NodeVersion = (Get-Content "$Root\vendor\node\VERSION").Trim()
$NodeDist = "https://nodejs.org/dist/v$NodeVersion"
$Stage = "$Root\build\windows\stage"
Remove-Item -Recurse -Force "$Root\build\windows" -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$Stage\node", "$Stage\app", "$Root\vendor\node" | Out-Null

# 1. Official Node runtime, checksum-verified.
$Zip = "node-$NodeVersion-win-x64.zip"
$ZipPath = "$Root\vendor\node\$Zip"
if (-not (Test-Path "$Root\vendor\node\SHASUMS256.txt")) { Invoke-WebRequest "$NodeDist/SHASUMS256.txt" -OutFile "$Root\vendor\node\SHASUMS256.txt" }
if (-not (Test-Path $ZipPath)) { Invoke-WebRequest "$NodeDist/$Zip" -OutFile $ZipPath }
$SumLine = Select-String -Path "$Root\vendor\node\SHASUMS256.txt" -Pattern " $Zip$" | Select-Object -First 1
if (-not $SumLine) { throw "No official checksum found for $Zip" }
$Expected = $SumLine.Line.Split(" ")[0]
$Actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
if ($Expected -ne $Actual) { throw "Checksum mismatch for $Zip" }
Expand-Archive $ZipPath -DestinationPath "$Root\build\windows\node-unzip"
Copy-Item "$Root\build\windows\node-unzip\node-$NodeVersion-win-x64\node.exe", "$Root\build\windows\node-unzip\node-$NodeVersion-win-x64\LICENSE" "$Stage\node\"

# 2. App files (no tests, tools, vendor or keys).
foreach ($p in "bin", "src", "ui", "samples", "package.json", "LICENSE.txt", "README.md") { Copy-Item -Recurse "$Root\$p" "$Stage\app\" }

# 3. Installer.
$env:BRAINLINK_VERSION = $Version
$Iscc = (Get-Command iscc.exe -ErrorAction SilentlyContinue).Source
if (-not $Iscc) { $Iscc = "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe" }
$IsccArgs = @("$Here\BrainLink.iss")
if ($env:BRAINLINK_SIGN -eq "1") { $IsccArgs = @("/DSIGN") + $IsccArgs }
& $Iscc @IsccArgs
Get-FileHash "$Root\dist\BrainLink-Setup-$Version.exe" -Algorithm SHA256 | Format-List
