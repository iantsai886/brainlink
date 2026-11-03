# Build and run a real v1.2.7 -> current Windows installer upgrade in isolated paths.
param([string]$FromTag = 'v1.2.7', [string]$PreparedInstallerRoot = '')
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CurrentVersion = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
if ([version]$CurrentVersion -le [version]'1.2.7') { throw 'Current package version must be newer than the selected upgrade baseline.' }
if (-not (git -C $Root tag --list $FromTag)) { throw "Baseline tag not found: $FromTag" }
$OldVersion = (git -C $Root show "$FromTag`:package.json" | ConvertFrom-Json).version
if ([version]$OldVersion -ge [version]$CurrentVersion) { throw "Baseline $OldVersion is not older than current $CurrentVersion." }
$IsccCandidates = @(
  (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
if (-not $IsccCandidates) { throw 'Inno Setup 6 is required.' }
$Iscc = @($IsccCandidates)[0]
$CurrentStage = Join-Path $Root 'build\windows\stage'
if (-not (Test-Path (Join-Path $CurrentStage 'node\node.exe')) -or -not (Test-Path (Join-Path $CurrentStage 'app\bin\brainlink.mjs'))) {
  throw 'Current Windows stage is missing. Run packaging/windows/build-windows.ps1 first.'
}
& (Join-Path $PSScriptRoot 'assert-windows-stage-current.ps1') -Root $Root -Stage $CurrentStage
$TestRoot = Join-Path $env:TEMP ('brainlink-upgrade-smoke-' + [guid]::NewGuid().ToString('N'))
$OldRoot = Join-Path $TestRoot 'source-old'
$OldStage = Join-Path $OldRoot 'build\windows\stage'
$OldOutput = Join-Path $TestRoot 'old-output'
$CurrentOutput = Join-Path $TestRoot 'current-output'
$InstallDir = Join-Path $TestRoot 'installed'
$BrainLinkHome = Join-Path $TestRoot 'home'
$StartMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BrainLink QA Smoke'
$StartMenuShortcut = Join-Path $StartMenuFolder 'BrainLink QA Smoke.lnk'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'BrainLink QA Smoke.lnk'
$StartupFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$StartupFile = Join-Path $StartupFolder 'BrainLink QA Smoke Background.vbs'
$StartupMarker = "' BrainLink managed startup launcher v1"
$CurrentQaIss = Join-Path $Root 'packaging\windows\BrainLink-QA-Upgrade.iss'
$OriginalEnvironmentKeyExists = Test-Path 'HKCU:\Environment'
$OriginalPathValueExists = $false
$OriginalPath = $null
if ($OriginalEnvironmentKeyExists) {
  $originalEnvironment = Get-ItemProperty 'HKCU:\Environment' -ErrorAction SilentlyContinue
  $OriginalPathValueExists = $null -ne $originalEnvironment -and $originalEnvironment.PSObject.Properties.Name -contains 'Path'
  if ($OriginalPathValueExists) { $OriginalPath = $originalEnvironment.Path }
}
$OldBrainLinkHome = $env:BRAINLINK_HOME
$OldNoOpen = $env:BRAINLINK_NO_OPEN
$OldSetupPort = $env:BRAINLINK_SETUP_PORT
$Process = $null
$OldWorktreeAdded = $false
$OldInstalled = $false
$CurrentInstalled = $false
$Success = $false
$StartupFileCreated = $false
$BaselineUninstallerHash = $null
$StartupFolderExisted = Test-Path -LiteralPath $StartupFolder -PathType Container

function Invoke-HiddenAndWait([string]$FilePath, [string[]]$Arguments) {
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Command failed with exit code $($process.ExitCode): $FilePath" }
}

function Build-OldStage {
  New-Item -ItemType Directory -Force (Join-Path $OldStage 'node'), (Join-Path $OldStage 'app'), (Join-Path $OldRoot 'dist'), $OldOutput | Out-Null
  Copy-Item -LiteralPath (Join-Path $CurrentStage 'node\node.exe') -Destination (Join-Path $OldStage 'node')
  Copy-Item -LiteralPath (Join-Path $CurrentStage 'node\LICENSE') -Destination (Join-Path $OldStage 'node')
  foreach ($item in @('bin', 'src', 'ui', 'skills', 'package.json', 'LICENSE.txt', 'README.md')) {
    $source = Join-Path $OldRoot $item
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $OldStage 'app') -Recurse -Force }
  }
  Remove-Item -LiteralPath (Join-Path $OldStage 'app\ui\app\test') -Recurse -Force -ErrorAction SilentlyContinue
  $store = Join-Path $OldStage 'app\node_modules\brainlink-store'
  New-Item -ItemType Directory -Force $store | Out-Null
  foreach ($item in @('memory-store.mjs', 'errors.mjs', 'package.json')) {
    Copy-Item -LiteralPath (Join-Path $Root "vendor\brainlink-store\$item") -Destination $store
  }
  $yaml = Join-Path $OldStage 'app\node_modules\yaml'
  New-Item -ItemType Directory -Force $yaml | Out-Null
  Copy-Item -Path (Join-Path $Root 'node_modules\yaml\*') -Destination $yaml -Recurse -Force
  $oldPackaging = Join-Path $OldRoot 'packaging\windows'
  foreach ($item in @('brainlink.cmd', 'BrainLink.vbs', 'BrainLink.ico')) {
    Copy-Item -LiteralPath (Join-Path $oldPackaging $item) -Destination (Join-Path $OldStage 'app') -Force
  }
  $issPath = Join-Path $oldPackaging 'BrainLink.iss'
  $iss = Get-Content -LiteralPath $issPath -Raw
  $iss = [regex]::Replace($iss, '(?m)^AppId=.*$', 'AppId={{D4A160C8-6D2C-4F44-9D35-8D10A92F7B31}')
  $iss = [regex]::Replace($iss, '(?m)^AppName=.*$', 'AppName=BrainLink QA Smoke')
  $iss = [regex]::Replace($iss, '(?m)^DefaultDirName=.*$', ('DefaultDirName=' + $InstallDir.Replace('\', '/')))
  $iss = [regex]::Replace($iss, '(?m)^DefaultGroupName=.*$', 'DefaultGroupName=BrainLink QA Smoke')
  $iss = [regex]::Replace($iss, '(?m)^OutputBaseFilename=.*$', 'OutputBaseFilename=BrainLink-QA-Upgrade-Setup-{#AppVersion}')
  $iss = [regex]::Replace($iss, '(?m)^OutputDir=.*$', ('OutputDir=' + $OldOutput.Replace('\', '/')))
  $iss = [regex]::Replace($iss, '(?m)^LicenseFile=.*$', ('LicenseFile=' + (Join-Path $OldRoot 'LICENSE.txt').Replace('\', '/')))
  $iss = $iss.Replace('Name: "{group}\BrainLink"', 'Name: "{group}\BrainLink QA Smoke"').Replace('Name: "{group}\Uninstall BrainLink"', 'Name: "{group}\Uninstall BrainLink QA Smoke"')
  $qaIss = Join-Path $oldPackaging 'BrainLink-QA-Smoke.iss'
  Set-Content -LiteralPath $qaIss -Value $iss -Encoding utf8
  $env:BRAINLINK_VERSION = $OldVersion
  & $Iscc $qaIss | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Could not build the isolated baseline installer.' }
  return Join-Path $OldOutput "BrainLink-QA-Upgrade-Setup-$OldVersion.exe"
}

function Start-IsolatedApp([string]$Version, [string]$Label) {
  $portProbe = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $portProbe.Start(); $port = $portProbe.LocalEndpoint.Port; $portProbe.Stop()
  $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($StartMenuShortcut)
  if (-not (Test-Path -LiteralPath $shortcut.TargetPath)) { throw "$Label upgrade shortcut target is missing." }
  $nodeExe = Join-Path $InstallDir 'node\node.exe'
  $cliPath = Join-Path $InstallDir 'app\bin\brainlink.mjs'
  if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $cliPath)) { throw "$Label bundled runtime or CLI is missing." }
  $arguments = '"' + $cliPath + '" setup --app --port ' + $port + ' --no-open'
  $stdoutPath = Join-Path $TestRoot "$Label.stdout.log"
  $stderrPath = Join-Path $TestRoot "$Label.stderr.log"
  $launcher = Start-Process -FilePath $nodeExe -ArgumentList $arguments -WorkingDirectory $InstallDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  $script:Process = Get-CimInstance Win32_Process -Filter "ProcessId = $($launcher.Id)" -ErrorAction SilentlyContinue
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $health = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    $script:Process = Get-CimInstance Win32_Process -Filter "ProcessId = $($launcher.Id)" -ErrorAction SilentlyContinue
    if ($script:Process -and $script:Process.ExecutablePath -and -not $script:Process.ExecutablePath.StartsWith(($InstallDir.TrimEnd('\') + '\'), [StringComparison]::OrdinalIgnoreCase)) { throw "$Label launch used a runtime outside the isolated install." }
    if ($script:Process -and $script:Process.CommandLine -notmatch [regex]::Escape("--port $port")) { throw "$Label launch did not use the isolated loopback port." }
    if ($script:Process) { try { $health = Invoke-RestMethod "http://127.0.0.1:$port/health" -TimeoutSec 2 } catch { $health = $null } }
    if ($health) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $script:Process -or $health.app -ne 'brainlink' -or $health.version -ne $Version) {
    $stdout = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { '' }
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { '' }
    $launcher.Refresh()
    throw "$Label app health did not report expected version $Version (health=$($health | ConvertTo-Json -Compress); launcherExit=$($launcher.ExitCode); stdout=$stdout; stderr=$stderr)."
  }
  return $health
}

function Stop-IsolatedApp {
  $installPrefix = $InstallDir.TrimEnd('\') + '\'
  $appProcesses = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) })
  foreach ($appProcess in $appProcesses) {
    & (Join-Path $env:WINDIR 'System32\taskkill.exe') /PID ([int]$appProcess.ProcessId) /T /F | Out-Null
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 200
    $remaining = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase) })
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
  if ($remaining.Count -gt 0) { throw 'Isolated BrainLink processes are still running.' }
  $script:Process = $null
}

try {
  foreach ($path in @($DesktopShortcut, $StartMenuFolder, $StartupFile)) {
    if (Test-Path -LiteralPath $path) { throw "A QA upgrade artifact already exists; refusing to replace it: $path" }
  }
  New-Item -ItemType Directory -Force $TestRoot, $StartupFolder, $BrainLinkHome, $CurrentOutput | Out-Null
  Set-Content -LiteralPath $StartupFile -Value $StartupMarker -NoNewline
  $StartupFileCreated = $true
  git -C $Root worktree add --detach $OldRoot $FromTag | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'Could not create the isolated baseline source worktree.' }
  $OldWorktreeAdded = $true
  if ($PreparedInstallerRoot) {
    $OldInstaller = Join-Path $PreparedInstallerRoot "old-output\BrainLink-QA-Upgrade-Setup-$OldVersion.exe"
    $CurrentInstaller = Join-Path $PreparedInstallerRoot "current-output\BrainLink-QA-Smoke-Setup-$CurrentVersion.exe"
    if (-not (Test-Path -LiteralPath $OldInstaller) -or -not (Test-Path -LiteralPath $CurrentInstaller)) { throw 'The prepared test installer pair is incomplete.' }
  } else {
    $OldInstaller = Build-OldStage
    $CurrentInstaller = Join-Path $CurrentOutput "BrainLink-QA-Smoke-Setup-$CurrentVersion.exe"
    if (Test-Path -LiteralPath $CurrentQaIss) { throw 'A temporary QA installer script already exists; refusing to replace it.' }
    $currentIssText = Get-Content -LiteralPath (Join-Path $Root 'packaging\windows\BrainLink.iss') -Raw
    $currentIssText = [regex]::Replace($currentIssText, '(?m)^DefaultDirName=.*$', ('DefaultDirName=' + $InstallDir.Replace('\', '/')))
    Set-Content -LiteralPath $CurrentQaIss -Value $currentIssText -Encoding utf8
    $script:CurrentQaIssCreated = $true
    $env:BRAINLINK_VERSION = $CurrentVersion
    & $Iscc '/DBRAINLINK_SMOKE_TEST' "/O$CurrentOutput" $CurrentQaIss | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $CurrentInstaller)) { throw 'Could not build the isolated current installer.' }
  }

  Set-Content -LiteralPath (Join-Path $BrainLinkHome 'upgrade-canary.json') -Value '{"keep":"preserve-user-data-on-upgrade"}' -NoNewline
  $CanaryHash = (Get-FileHash -LiteralPath (Join-Path $BrainLinkHome 'upgrade-canary.json') -Algorithm SHA256).Hash
  $env:BRAINLINK_HOME = $BrainLinkHome
  $env:BRAINLINK_NO_OPEN = '1'
  $OldInstalled = $true
  Invoke-HiddenAndWait $OldInstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$InstallDir`"", '/GROUP="BrainLink QA Smoke"')
  $BaselineUninstallerHash = (Get-FileHash -LiteralPath (Join-Path $InstallDir 'unins000.dat') -Algorithm SHA256).Hash
  Start-IsolatedApp $OldVersion 'Baseline'
  Stop-IsolatedApp
  Write-Output "PASS: isolated v$OldVersion installation launched before upgrade."

  $CurrentInstalled = $true
  Invoke-HiddenAndWait $CurrentInstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$InstallDir`"", '/GROUP="BrainLink QA Smoke"')
  $uninstaller = Join-Path $InstallDir 'unins000.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Upgrade did not leave an uninstaller in the isolated install.' }
  $uninstallerVersion = (Get-Item -LiteralPath $uninstaller).VersionInfo.ProductVersion
  Write-Output "Current uninstaller file version: $uninstallerVersion"
  if ($uninstallerVersion -and [version]$uninstallerVersion -lt [version]$CurrentVersion) { throw "Upgrade retained the old $uninstallerVersion uninstaller instead of $CurrentVersion." }
  $currentUninstallerHash = (Get-FileHash -LiteralPath (Join-Path $InstallDir 'unins000.dat') -Algorithm SHA256).Hash
  if ($currentUninstallerHash -eq $BaselineUninstallerHash) { throw 'Upgrade left the baseline uninstall data unchanged; the upgraded app would uninstall with the old cleanup rules.' }
  Copy-Item -LiteralPath (Join-Path $InstallDir 'unins000.exe') -Destination (Join-Path $TestRoot 'captured-uninstaller.exe')
  Copy-Item -LiteralPath (Join-Path $InstallDir 'unins000.dat') -Destination (Join-Path $TestRoot 'captured-uninstaller.dat')
  if ((Get-FileHash -LiteralPath (Join-Path $BrainLinkHome 'upgrade-canary.json') -Algorithm SHA256).Hash -ne $CanaryHash) { throw 'Upgrade changed or removed the user-data canary.' }
  if (-not (Test-Path -LiteralPath $DesktopShortcut) -or -not (Test-Path -LiteralPath $StartMenuShortcut)) { throw 'Upgraded app did not create its expected shortcuts.' }
  Start-IsolatedApp $CurrentVersion 'Upgraded'
  Stop-IsolatedApp
  Write-Output "PASS: v$OldVersion -> v$CurrentVersion installed in place; the existing user-data canary was preserved; upgraded Setup health passed."
  $Success = $true
} finally {
  try {
    Stop-IsolatedApp
    if ($CurrentInstalled -or $OldInstalled) {
      $uninstaller = Join-Path $InstallDir 'unins000.exe'
      if (Test-Path -LiteralPath $uninstaller) { Invoke-HiddenAndWait $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/LOG=`"$(Join-Path $TestRoot 'uninstall.log')`"") }
      if (Test-Path -LiteralPath $InstallDir) { throw 'QA uninstaller left its isolated install directory behind.' }
      if (Test-Path -LiteralPath $DesktopShortcut) { throw 'QA uninstaller left its desktop shortcut behind.' }
      if (Test-Path -LiteralPath $StartMenuFolder) { throw 'QA uninstaller left its Start menu shortcuts behind.' }
      if ($CurrentInstalled -and (Test-Path -LiteralPath $StartupFile)) { throw 'QA uninstaller retained an unexpected startup entry.' }
      if (-not (Test-Path -LiteralPath (Join-Path $BrainLinkHome 'upgrade-canary.json'))) { throw 'Uninstall removed isolated user data.' }
      $pathDeadline = [DateTime]::UtcNow.AddSeconds(10)
      do {
        Start-Sleep -Milliseconds 200
        $currentPath = if (Test-Path 'HKCU:\Environment') { (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path } else { $null }
      } while ($currentPath -ne $OriginalPath -and [DateTime]::UtcNow -lt $pathDeadline)
      if ($currentPath -ne $OriginalPath) {
        $originalEntries = @($OriginalPath -split ';' | Where-Object { $_ })
        $currentEntries = @($currentPath -split ';' | Where-Object { $_ })
        $missingEntries = @($originalEntries | Where-Object { $currentEntries -notcontains $_ }).Count
        $extra = @($currentEntries | Where-Object { $originalEntries -notcontains $_ })
        $testBin = (Join-Path $InstallDir 'bin').TrimEnd('\', '/')
        $extraFromTestInstall = @($extra | Where-Object { [string]::Equals($_.Trim().Trim('"').TrimEnd('\', '/'), $testBin, [StringComparison]::OrdinalIgnoreCase) }).Count
        Write-Warning "Uninstall changed the user PATH (missing prior entries: $missingEntries; extra entries: $($extra.Count); isolated app path left behind: $($extraFromTestInstall -gt 0))."
        $Success = $false
      } else {
        Write-Output 'PASS: upgraded uninstall removed the isolated app, preserved user data, and restored PATH.'
      }
    }
  } finally {
    $env:BRAINLINK_HOME = $OldBrainLinkHome
    $env:BRAINLINK_NO_OPEN = $OldNoOpen
    $env:BRAINLINK_SETUP_PORT = $OldSetupPort
    $env:BRAINLINK_VERSION = $null
    if ($StartupFileCreated -and (Test-Path -LiteralPath $StartupFile) -and (Get-Content -LiteralPath $StartupFile -Raw) -eq $StartupMarker) { Remove-Item -LiteralPath $StartupFile -Force }
    if ($script:CurrentQaIssCreated -and (Test-Path -LiteralPath $CurrentQaIss)) { Remove-Item -LiteralPath $CurrentQaIss -Force }
    $currentPathValue = if (Test-Path 'HKCU:\Environment') { (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path } else { $null }
    if ($OriginalPathValueExists) {
      Set-ItemProperty 'HKCU:\Environment' -Name Path -Value $OriginalPath
    } elseif ($null -ne $currentPathValue) {
      Remove-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue
    }
    if (-not $StartupFolderExisted -and (Test-Path -LiteralPath $StartupFolder)) { Remove-Item -LiteralPath $StartupFolder -ErrorAction SilentlyContinue }
    if ($Success) {
      if ($OldWorktreeAdded) { git -C $Root worktree remove --force $OldRoot | Out-Host }
      $tempFull = [System.IO.Path]::GetFullPath($TestRoot)
      $tempPrefix = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
      if (-not $tempFull.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or -not (Split-Path $tempFull -Leaf).StartsWith('brainlink-upgrade-smoke-')) { throw 'Refusing to clean an unexpected QA path.' }
      Remove-Item -LiteralPath $tempFull -Recurse -Force
    } else { Write-Warning "Upgrade smoke artifacts preserved for diagnosis at $TestRoot" }
  }
}
