# Build a uniquely identified QA installer, install it in a temporary folder,
# start its bundled runtime, check Setup over loopback, then uninstall it.
param([switch]$SkipCompile)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
$IsccCandidates = @(
  (Get-Command iscc.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
if (-not $IsccCandidates) { throw 'Inno Setup 6 is required. Build the Windows stage first, then install Inno Setup 6.' }
$Iscc = @($IsccCandidates)[0]
$Stage = Join-Path $Root 'build\windows\stage'
if (-not (Test-Path (Join-Path $Stage 'node\node.exe')) -or -not (Test-Path (Join-Path $Stage 'app\bin\brainlink.mjs'))) {
  throw 'The Windows package stage is missing. Run packaging/windows/build-windows.ps1 first.'
}
$TestRoot = Join-Path $env:TEMP ('brainlink-install-smoke-' + [guid]::NewGuid().ToString('N'))
$InstallDir = Join-Path $TestRoot 'installed'
$BrainLinkHome = Join-Path $TestRoot 'home'
$DesktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'BrainLink QA Smoke.lnk'
$StartMenuFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BrainLink QA Smoke'
$StartMenuShortcut = Join-Path $StartMenuFolder 'BrainLink QA Smoke.lnk'
$StartupFolder = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
$StartupFile = Join-Path $StartupFolder 'BrainLink QA Smoke Background.vbs'
$StartupMarker = "' BrainLink managed startup launcher v1"
$ReusableInstaller = Join-Path $Root "dist\BrainLink-QA-Smoke-Setup-$Version.exe"
$Installer = if ($SkipCompile) { $ReusableInstaller } else { Join-Path $TestRoot "BrainLink-QA-Smoke-Setup-$Version.exe" }
$OriginalPathExists = Test-Path 'HKCU:\Environment'
$OriginalPath = if ($OriginalPathExists) { (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path } else { $null }
$OldBrainLinkHome = $env:BRAINLINK_HOME
$OldBrainLinkVersion = $env:BRAINLINK_VERSION
$OldSetupPort = $env:BRAINLINK_SETUP_PORT
$OldNoOpen = $env:BRAINLINK_NO_OPEN
$Process = $null
$Installed = $false
$Success = $false
$StartupFileCreated = $false
$StartupFolderExisted = Test-Path -LiteralPath $StartupFolder -PathType Container

function Invoke-HiddenAndWait([string]$FilePath, [string[]]$Arguments) {
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -PassThru -Wait -WindowStyle Hidden
  if ($process.ExitCode -ne 0) { throw "Command failed with exit code $($process.ExitCode): $FilePath" }
}

try {
  if (Test-Path -LiteralPath $DesktopShortcut) { throw 'A BrainLink QA Smoke desktop shortcut already exists; refusing to replace it.' }
  if (Test-Path -LiteralPath $StartMenuFolder) { throw 'A BrainLink QA Smoke Start menu folder already exists; refusing to replace it.' }
  if (Test-Path -LiteralPath $StartupFile) { throw 'A BrainLink QA Smoke startup file already exists; refusing to replace it.' }
  New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $StartupFolder -Force | Out-Null
  Set-Content -LiteralPath $StartupFile -Value $StartupMarker -NoNewline
  $StartupFileCreated = $true
  if (-not $SkipCompile) {
    $env:BRAINLINK_VERSION = $Version
    & $Iscc '/DBRAINLINK_SMOKE_TEST' "/O$TestRoot" (Join-Path $Root 'packaging\windows\BrainLink.iss') | Out-Host
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Installer)) { throw 'Could not compile the isolated QA installer.' }
  } elseif (-not (Test-Path -LiteralPath $Installer)) { throw "The reusable QA installer does not exist: $Installer" }

  $Installed = $true
  Invoke-HiddenAndWait $Installer @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', "/DIR=`"$InstallDir`"", '/GROUP="BrainLink QA Smoke"')
  if (-not (Test-Path -LiteralPath $DesktopShortcut) -or -not (Test-Path -LiteralPath $StartMenuShortcut)) { throw 'Installer did not create both expected shortcuts.' }

  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcutPath in @($DesktopShortcut, $StartMenuShortcut)) {
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if (-not $shortcut.TargetPath.EndsWith('\wscript.exe', [StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected shortcut target: $($shortcut.TargetPath)" }
    if ($shortcut.Arguments -notlike '*BrainLink.vbs*') { throw 'Shortcut does not launch the installed BrainLink app launcher.' }
    if (-not (Test-Path -LiteralPath ($shortcut.Arguments -replace '^.*?"([^"]+BrainLink\.vbs)".*$', '$1'))) { throw 'Shortcut launcher file is missing.' }
  }

  $env:BRAINLINK_HOME = $BrainLinkHome
  New-Item -ItemType Directory -Path $BrainLinkHome -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $BrainLinkHome 'qa-preserve.txt') -Value 'keep-local-settings-on-uninstall' -NoNewline
  $env:BRAINLINK_NO_OPEN = '1'
  $portProbe = [System.Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  $portProbe.Start()
  $setupPort = $portProbe.LocalEndpoint.Port
  $portProbe.Stop()
  $env:BRAINLINK_SETUP_PORT = "$setupPort"
  $shortcut = $shell.CreateShortcut($StartMenuShortcut)
  Start-Process -FilePath $shortcut.TargetPath -ArgumentList $shortcut.Arguments -WorkingDirectory $InstallDir -WindowStyle Hidden
  $InstanceFile = Join-Path $BrainLinkHome 'setup-instance.json'
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $health = $null
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-Path -LiteralPath $InstanceFile) {
      $instance = Get-Content -LiteralPath $InstanceFile -Raw | ConvertFrom-Json
      $Process = Get-CimInstance Win32_Process -Filter "ProcessId = $($instance.pid)" -ErrorAction SilentlyContinue
      $installPrefix = $InstallDir.TrimEnd('\') + '\'
      if ($Process -and $Process.ExecutablePath -and -not $Process.ExecutablePath.StartsWith($installPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The installed shortcut started a process outside its isolated installation.' }
      if ($Process -and $Process.CommandLine -notmatch [regex]::Escape("--port $setupPort")) { throw 'The installed shortcut did not pass its isolated loopback port.' }
      if ($Process) {
        try { $health = Invoke-RestMethod "http://127.0.0.1:$($instance.port)/health" -TimeoutSec 2 } catch { $health = $null }
        if ($health) { break }
      }
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $Process) { throw 'The installed shortcut target did not start an isolated Setup process before the timeout.' }
  if ($health.app -ne 'brainlink' -or $health.version -ne $Version) { throw 'Installed Setup did not answer its loopback health check.' }
  $token = (Get-Content -LiteralPath (Join-Path $BrainLinkHome 'setup-token') -Raw).Trim()
  $page = Invoke-WebRequest "http://127.0.0.1:$($instance.port)/?t=$token" -Headers @{ 'X-BrainLink-Token' = $token } -TimeoutSec 5
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch 'BrainLink Setup') { throw 'Installed Setup UI did not load with its local session token.' }
  Write-Output "PASS: installed BrainLink $Version starts from its bundled runtime; both shortcuts point to the installed launcher; Setup health and UI checks passed."
  $Success = $true
} finally {
  try {
    if ($Process) {
      Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
      Wait-Process -Id $Process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
    }
    if ($Installed) {
      $uninstaller = Join-Path $InstallDir 'unins000.exe'
      if (Test-Path -LiteralPath $uninstaller) {
        Invoke-HiddenAndWait $uninstaller @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART')
      }
      if (Test-Path -LiteralPath $InstallDir) { throw 'QA uninstaller left its isolated install directory behind.' }
      if (Test-Path -LiteralPath $DesktopShortcut) { throw 'QA uninstaller left the desktop shortcut behind.' }
      if (Test-Path -LiteralPath $StartMenuFolder) { throw 'QA uninstaller left the Start menu shortcuts behind.' }
      if (Test-Path -LiteralPath $StartupFile) { throw 'QA uninstaller left its owned start-at-sign-in entry behind.' }
      if (-not (Test-Path -LiteralPath (Join-Path $BrainLinkHome 'qa-preserve.txt'))) { throw 'Uninstall removed BrainLink user data from the isolated home.' }
      $currentPath = if (Test-Path 'HKCU:\Environment') { (Get-ItemProperty 'HKCU:\Environment' -Name Path -ErrorAction SilentlyContinue).Path } else { $null }
      if ($currentPath -ne $OriginalPath) { throw 'Uninstall did not restore the user PATH exactly.' }
      Write-Output 'PASS: isolated uninstall removed only its app and shortcuts, preserved the isolated user home, and restored the prior PATH.'
    }
  } finally {
    $env:BRAINLINK_HOME = $OldBrainLinkHome
    $env:BRAINLINK_VERSION = $OldBrainLinkVersion
    $env:BRAINLINK_SETUP_PORT = $OldSetupPort
    $env:BRAINLINK_NO_OPEN = $OldNoOpen
  }
  if ($StartupFileCreated -and (Test-Path -LiteralPath $StartupFile)) {
    if ((Get-Content -LiteralPath $StartupFile -Raw) -eq $StartupMarker) { Remove-Item -LiteralPath $StartupFile -Force }
    else { Write-Warning 'The QA startup file changed during testing and was preserved.' }
  }
  if (-not $StartupFolderExisted -and (Test-Path -LiteralPath $StartupFolder -PathType Container)) {
    Remove-Item -LiteralPath $StartupFolder -ErrorAction SilentlyContinue
  }
  if ($Success) { Remove-Item -LiteralPath $TestRoot -Recurse -Force -ErrorAction SilentlyContinue }
  else { Write-Warning "QA logs preserved for diagnosis at $TestRoot" }
}
