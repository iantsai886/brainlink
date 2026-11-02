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
$SourceUi = Join-Path $Root 'ui\index.html'
$StagedUi = Join-Path $Stage 'app\ui\index.html'
if (-not (Test-Path -LiteralPath $StagedUi) -or (Get-FileHash -LiteralPath $SourceUi -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $StagedUi -Algorithm SHA256).Hash) {
  throw 'The Windows package stage is stale. Run packaging/windows/build-windows.ps1 before the installed-app smoke test.'
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
$OldHermesHome = $env:HERMES_HOME
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
  $InstalledApp = Join-Path $InstallDir 'app'
  $InstalledNode = Join-Path $InstallDir 'node\node.exe'
  $OcrSmoke = Join-Path $Root 'scripts\smoke-installed-ocr.mjs'
  $HtmlSmoke = Join-Path $Root 'scripts\smoke-installed-html.mjs'
  $HermesHome = Join-Path $TestRoot 'hermes-profile'
  New-Item -ItemType Directory -Path $HermesHome -Force | Out-Null
  $HermesConfig = Join-Path $HermesHome 'config.yaml'
  Set-Content -LiteralPath $HermesConfig -Value "model: deepseek/deepseek-chat`nhooks:`n  on_session_start:`n    - command: 'echo preserve-user-hook'`n" -NoNewline
  $env:HERMES_HOME = $HermesHome
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
  if ($page.Content -notmatch 'href="#s-ingestion" data-main-nav="s-ingestion" data-i18n="nav.sources"') { throw 'Installed Setup is missing direct Sources navigation to folder scanning.' }
  if ($page.Content -notmatch 'id="ingestion-enabled"' -or $page.Content -notmatch 'id="ingestion-auto-file"' -or $page.Content -notmatch 'id="ingestion-run"' -or $page.Content -notmatch 'id="ingestion-startup-warning"') { throw 'Installed Setup is missing the scheduled scan, auto-file, manual scan, or sign-in startup guidance control.' }
  $OcrFixtures = @('ocr-sample.png', 'ocr-portuguese.png', 'ocr-traditional-chinese.png') | ForEach-Object { Join-Path $Root "test\fixtures\$_" }
  & $InstalledNode $OcrSmoke $InstalledApp @OcrFixtures | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'The installed OCR runtime could not read its local image fixture.' }
  & $InstalledNode $HtmlSmoke $InstalledApp | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'The installed HTML parser could not safely extract its fictional fixture.' }
  $englishLocale = Invoke-RestMethod "http://127.0.0.1:$($instance.port)/locales/en.json" -TimeoutSec 5
  if ($englishLocale.'nav.sources' -ne 'Sources') { throw 'Installed Setup is missing the Sources navigation label.' }
  foreach ($key in @('ingestion.enabled', 'ingestion.autoFile', 'ingestion.run', 'ingestion.destination')) {
    if (-not $englishLocale.PSObject.Properties[$key].Value) { throw "Installed Setup is missing the folder-ingestion label: $key" }
  }
  foreach ($key in @('ingestion.retryProposal', 'ingestion.partialFiling', 'ingestion.confirmRetryProposal')) {
    if (-not $englishLocale.PSObject.Properties[$key].Value) { throw "Installed Setup is missing the partial-filing recovery label: $key" }
  }
  # Exercise the installed local API with a fictional vault: force an entity-note
  # collision, confirm the existing file is preserved and retry is available, then
  # remove only the fixture collision and verify the main note is not duplicated.
  $vaultPath = Join-Path $TestRoot 'fictional-vault'
  $rawFolder = Join-Path $vaultPath 'Raw'
  $knowledgeFolder = Join-Path $vaultPath 'Knowledge'
  New-Item -ItemType Directory -Path $rawFolder -Force | Out-Null
  New-Item -ItemType Directory -Path $knowledgeFolder -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $rawFolder 'Source.md') -Value "# Fictional source`n`nA fictional Quality team runs a short checklist." -NoNewline
  $vaultBody = @{ name = 'Fictional QA'; path = $vaultPath } | ConvertTo-Json -Compress
  $headers = @{ 'X-BrainLink-Token' = $token }
  $connect = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/vault" -Method Post -Headers $headers -ContentType 'application/json' -Body $vaultBody -TimeoutSec 5
  if (-not $connect.ok) { throw 'Could not connect the isolated fictional vault to installed Setup.' }
  $scanBody = @{ targets = @(@{ vault = 'Fictional QA'; folder = 'Raw' }) } | ConvertTo-Json -Depth 5 -Compress
  $scan = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/ingestion/run" -Method Post -Headers $headers -ContentType 'application/json' -Body $scanBody -TimeoutSec 10
  if (@($scan.candidates).Count -ne 1) { throw 'Installed folder scan did not find exactly the fictional source.' }
  # Seed a valid local draft from the scanned source revision. This exercises the
  # installed filing path without requiring Ollama or sending fixture data anywhere.
  $sourceId = [string]$scan.candidates[0].source_id
  $revision = [string]$scan.candidates[0].revision
  $draftIdentity = [Text.Encoding]::UTF8.GetBytes("Fictional QA`0$sourceId`0$revision")
  $sha = [Security.Cryptography.SHA256]::HashData($draftIdentity)
  $draftId = [Convert]::ToHexString($sha).ToLowerInvariant()
  $now = [DateTime]::UtcNow.ToString('o')
  $draftRecord = [ordered]@{
    schema = 1; id = $draftId; status = 'pending'; created_at = $now
    draft = [ordered]@{
      status = 'unverified_draft'; source_id = $sourceId; revision = $revision
      vault = 'Fictional QA'; folder = 'Raw'; source_path = 'Raw/Source.md'
      title = 'Fictional filing retry'; summary = 'A fictional installer recovery test.'
      body = "# Fictional filing retry`n`nThis fixture tests safe retry behavior.`n`n## Source`n[[Raw/Source]]"
      memory_type = 'episodic'; entities = @(@{ type = 'team'; title = 'Fictional quality team'; description = 'A fictional team for the installer retry smoke.'; evidence = 'A fictional Quality team runs a short checklist.' })
      relationships = @(); related_notes = @(); related_basis = 'source_and_draft'; destinations = @('Knowledge'); model = 'fixture'; generated_at = $now
    }
  }
  $draftDir = Join-Path $BrainLinkHome 'ingestion\drafts'
  New-Item -ItemType Directory -Path $draftDir -Force | Out-Null
  $draftFile = Join-Path $draftDir "$draftId.json"
  $draftRecord | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $draftFile -NoNewline
  $localDate = Get-Date -Format 'yyyy-MM-dd'
  $conflictPath = Join-Path $knowledgeFolder "$localDate — Fictional quality team.md"
  Set-Content -LiteralPath $conflictPath -Value "# Existing user file`n`nKeep this exact content." -NoNewline
  $saveBody = @{ draft_id = $draftId; destination = 'Knowledge'; related_note_paths = @(); entity_choices = @(@{ index = 0; scope = 'organisation' }); relationship_indexes = @(); confirm = $true } | ConvertTo-Json -Depth 5 -Compress
  $partial = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/ingestion/save-draft" -Method Post -Headers $headers -ContentType 'application/json' -Body $saveBody -TimeoutSec 10
  if (-not $partial.partial -or -not $partial.written) { throw 'Installed filing did not report the expected recoverable entity-name conflict.' }
  if ((Get-Content -LiteralPath $conflictPath -Raw) -ne "# Existing user file`n`nKeep this exact content.") { throw 'Installed filing changed the existing conflict file.' }
  $pending = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/ingestion/drafts" -Method Get -Headers $headers -TimeoutSec 5
  if (@($pending.drafts).Count -ne 1 -or -not $pending.drafts[0].filing) { throw 'Installed UI does not retain the partial draft for retry.' }
  Remove-Item -LiteralPath $conflictPath
  $retryBody = @{ draft_id = $draftId; destination = 'Knowledge'; confirm = $true } | ConvertTo-Json -Compress
  $retried = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/ingestion/save-draft" -Method Post -Headers $headers -ContentType 'application/json' -Body $retryBody -TimeoutSec 10
  if ($retried.partial -or $retried.path -ne $partial.path) { throw 'Installed retry did not finish using the already-saved main note.' }
  $savedRelative = [string]$partial.path -replace '^Fictional QA/', ''
  if (-not $savedRelative -or (Get-Content -LiteralPath (Join-Path $vaultPath $savedRelative) -Raw).Length -eq 0) { throw 'Installed retry lost the already-saved main note.' }
  $pendingAfterRetry = Invoke-RestMethod -Uri "http://127.0.0.1:$($instance.port)/api/ingestion/drafts" -Method Get -Headers $headers -TimeoutSec 5
  if (@($pendingAfterRetry.drafts).Count -ne 0) { throw 'Installed retry left a completed draft in the pending list.' }
  $headers = @{ 'X-BrainLink-Token' = $token }
  $hooksUrl = "http://127.0.0.1:$($instance.port)/api/sessions/hooks"
  $hookSetUrl = "http://127.0.0.1:$($instance.port)/api/sessions/hooks/set"
  $hookState = Invoke-RestMethod -Uri $hooksUrl -Method Post -Headers $headers -ContentType 'application/json' -Body '{}' -TimeoutSec 5
  $hermesHook = @($hookState.clients | Where-Object client -eq 'hermes') | Select-Object -First 1
  if (-not $hermesHook -or $hermesHook.configured -or -not $hermesHook.privileged_shell_hook) { throw 'Installed Setup did not show the isolated Hermes reminder as disabled and privilege-scoped.' }
  $enableBody = @{ client = 'hermes'; enabled = $true } | ConvertTo-Json -Compress
  $enabledHook = Invoke-RestMethod -Uri $hookSetUrl -Method Post -Headers $headers -ContentType 'application/json' -Body $enableBody -TimeoutSec 5
  if (-not $enabledHook.configured) { throw 'Installed Setup could not enable its Hermes reminder in the isolated profile.' }
  $configuredYaml = Get-Content -LiteralPath $HermesConfig -Raw
  if ($configuredYaml -notmatch 'echo preserve-user-hook' -or $configuredYaml -notmatch 'on_session_finalize' -or $configuredYaml -notmatch 'session-end-cue') { throw 'Installed Hermes setup did not preserve the existing hook while adding BrainLink.' }
  $disableBody = @{ client = 'hermes'; enabled = $false } | ConvertTo-Json -Compress
  $disabledHook = Invoke-RestMethod -Uri $hookSetUrl -Method Post -Headers $headers -ContentType 'application/json' -Body $disableBody -TimeoutSec 5
  $restoredYaml = Get-Content -LiteralPath $HermesConfig -Raw
  if ($disabledHook.configured -or $restoredYaml -notmatch 'echo preserve-user-hook' -or $restoredYaml -match 'session-end-cue') { throw 'Installed Hermes setup did not remove only its own hook.' }
  if ($page.Content -notmatch 'sessions\.hookHermesConfirm|user permissions') { throw 'Installed UI is missing the Hermes shell-hook permission warning.' }
  Write-Output "PASS: installed BrainLink $Version starts from its bundled runtime; both shortcuts work; Setup and folder-ingestion controls load; partial filing preserves a conflict and retries without duplicating the main note; and Hermes hook enable/disable preserves only the temporary profile settings."
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
    $env:HERMES_HOME = $OldHermesHome
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
