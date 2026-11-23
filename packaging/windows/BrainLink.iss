; Inno Setup 6 script: per-user install (no admin), Start-menu entry, `brainlink` on PATH.
; Built by build-windows.ps1, which stages files into ..\..\build\windows\stage.
#define AppVersion GetEnv("BRAINLINK_VERSION")
#define Stage "..\..\build\windows\stage"
#ifdef BRAINLINK_SMOKE_TEST
#define ProductAppId "{{D4A160C8-6D2C-4F44-9D35-8D10A92F7B31}"
#define ProductName "BrainLink QA Smoke"
#define ProductDir "{localappdata}\Programs\BrainLink-QA-Smoke"
#define ProductGroup "BrainLink QA Smoke"
#define ProductShortcut "BrainLink QA Smoke"
#define ProductStartupLauncher "BrainLink QA Smoke Background.vbs"
#define ProductOutput "BrainLink-QA-Smoke-Setup-" + AppVersion
#else
#define ProductAppId "{{6F2B8E4C-9A51-4C1E-B7D3-2B1A9E5C7F40}"
#define ProductName "BrainLink"
#define ProductDir "{localappdata}\Programs\BrainLink"
#define ProductGroup "BrainLink"
#define ProductShortcut "BrainLink"
#define ProductStartupLauncher "BrainLink Background.vbs"
#define ProductOutput "BrainLink-Setup-" + AppVersion
#endif

[Setup]
AppId={#ProductAppId}
AppName={#ProductName}
AppVersion={#AppVersion}
AppPublisher=Iango
DefaultDirName={#ProductDir}
DefaultGroupName={#ProductGroup}
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename={#ProductOutput}
LicenseFile=..\..\LICENSE.txt
SetupIconFile=BrainLink.ico
UninstallDisplayIcon={app}\BrainLink.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ChangesEnvironment=yes
; Code signing (Azure Trusted Signing or an OV/EV certificate). Define the "brainlink" sign
; tool in the Inno Setup IDE or pass /Sbrainlink="signtool sign /fd sha256 /tr http://timestamp.acs.microsoft.com /td sha256 /dlib ... $f".
#ifdef SIGN
SignTool=brainlink
SignedUninstaller=yes
#endif

[Files]
Source: "{#Stage}\node\*"; DestDir: "{app}\node"; Flags: recursesubdirs ignoreversion
Source: "{#Stage}\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
Source: "brainlink.cmd"; DestDir: "{app}\bin"; Flags: ignoreversion
Source: "BrainLink.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "BrainLink.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#ProductShortcut}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; IconFilename: "{app}\BrainLink.ico"
Name: "{autodesktop}\{#ProductShortcut}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; IconFilename: "{app}\BrainLink.ico"
Name: "{group}\Uninstall BrainLink"; Filename: "{uninstallexe}"

[Registry]
; Add {app}\bin to the user's PATH once.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; Description: "Open BrainLink Setup"; Flags: postinstall nowait skipifsilent

[Code]
var BrainLinkInstallBin: String;

function GetCurrentProcessId: LongWord;
  external 'GetCurrentProcessId@kernel32.dll stdcall';

function NeedsAddPath(Dir: string): Boolean;
var Paths: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then begin Result := True; exit; end;
  Result := Pos(';' + Lowercase(Dir) + ';', ';' + Lowercase(Paths) + ';') = 0;
end;

function SamePathEntry(Left, Right: String): Boolean;
begin
  Left := Trim(Left);
  Right := Trim(Right);
  if (Length(Left) >= 2) and (Left[1] = '"') and (Left[Length(Left)] = '"') then begin
    Delete(Left, Length(Left), 1);
    Delete(Left, 1, 1);
  end;
  if (Length(Right) >= 2) and (Right[1] = '"') and (Right[Length(Right)] = '"') then begin
    Delete(Right, Length(Right), 1);
    Delete(Right, 1, 1);
  end;
  while (Length(Left) > 3) and ((Left[Length(Left)] = '\') or (Left[Length(Left)] = '/')) do Delete(Left, Length(Left), 1);
  while (Length(Right) > 3) and ((Right[Length(Right)] = '\') or (Right[Length(Right)] = '/')) do Delete(Right, Length(Right), 1);
  Result := CompareText(Left, Right) = 0;
end;

procedure RemoveBrainLinkFromUserPath;
var
  Paths, Target, Segment, Remaining: String;
  StartPos, SeparatorPos, EndPos: Integer;
  Changed: Boolean;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then exit;
  Target := BrainLinkInstallBin;
  if Target = '' then Target := ExpandConstant('{app}\bin');
  Changed := False;
  Remaining := '';
  StartPos := 1;
  while StartPos <= Length(Paths) + 1 do begin
    SeparatorPos := Pos(';', Copy(Paths, StartPos, Length(Paths) - StartPos + 1));
    if SeparatorPos = 0 then EndPos := Length(Paths) + 1
    else EndPos := StartPos + SeparatorPos - 1;
    Segment := Copy(Paths, StartPos, EndPos - StartPos);
    if SamePathEntry(Segment, Target) then begin
      Changed := True;
    end else begin
      if Remaining <> '' then Remaining := Remaining + ';';
      Remaining := Remaining + Segment;
    end;
    StartPos := EndPos + 1;
  end;
  if Changed then begin
    if Remaining = '' then RegDeleteValue(HKCU, 'Environment', 'Path')
    else if not RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Remaining) then Log('Could not remove BrainLink from the user PATH.');
  end;
end;

procedure RemoveBrainLinkStartupLauncher;
var
  StartupFile: String;
  Contents: AnsiString;
begin
  StartupFile := ExpandConstant('{userappdata}\Microsoft\Windows\Start Menu\Programs\Startup\{#ProductStartupLauncher}');
  if FileExists(StartupFile) and LoadStringFromFile(StartupFile, Contents) then begin
    if Pos('BrainLink managed startup launcher v1', Contents) > 0 then begin
      if not DeleteFile(StartupFile) then Log('Could not remove the BrainLink startup launcher.');
    end;
  end;
end;

procedure StopRunningBrainLinkInInstallDir(InstallDir: String);
var
  StopScript, ScriptText, PowerShellExe, Parameters: String;
  ResultCode: Integer;
begin
  if (InstallDir = '') or (not DirExists(InstallDir)) then exit;
  StopScript := ExpandConstant('{tmp}\BrainLinkStopRunning-' + IntToStr(GetCurrentProcessId) + '.ps1');
  ScriptText := '$ErrorActionPreference = ''SilentlyContinue''' + #13#10 +
    '$prefix = $args[0].TrimEnd(''\'', ''/'') + ''\node\''' + #13#10 +
    '$procs = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })' + #13#10 +
    'foreach ($p in $procs) { & (Join-Path $env:WINDIR ''System32\taskkill.exe'') /PID ([int]$p.ProcessId) /T /F | Out-Null }' + #13#10 +
    '$deadline = [DateTime]::UtcNow.AddSeconds(8)' + #13#10 +
    'while ([DateTime]::UtcNow -lt $deadline) {' + #13#10 +
    '  $left = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })' + #13#10 +
    '  if ($left.Count -eq 0) { break }' + #13#10 +
    '  Start-Sleep -Milliseconds 200' + #13#10 +
    '}' + #13#10;
  if SaveStringToFile(StopScript, ScriptText, False) then begin
    PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    Parameters := '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + StopScript + '" "' + InstallDir + '"';
    if not Exec(PowerShellExe, Parameters, '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then begin
      Log('Could not stop running BrainLink processes before install/uninstall.');
    end;
    DeleteFile(StopScript);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  InstallDir: String;
begin
  if CurStep = ssInstall then begin
    InstallDir := ExpandConstant('{app}');
    if DirExists(InstallDir) then begin
      StopRunningBrainLinkInInstallDir(InstallDir);
      // Remove previous app and runtime trees so upgraded installs never keep stale files.
      // User config and vaults live in %APPDATA%\BrainLink and are never touched.
      DelTree(InstallDir + '\app', True, True, True);
      DelTree(InstallDir + '\node', True, True, True);
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then begin
    BrainLinkInstallBin := ExpandConstant('{app}\bin');
    StopRunningBrainLinkInInstallDir(ExpandConstant('{app}'));
    RemoveBrainLinkFromUserPath;
  end;
  if CurUninstallStep = usPostUninstall then begin
    RemoveBrainLinkFromUserPath;
    RemoveBrainLinkStartupLauncher;
  end;
  if CurUninstallStep = usDone then begin
    RemoveBrainLinkFromUserPath;
    RemoveBrainLinkStartupLauncher;
  end;
end;

procedure DeinitializeUninstall;
var
  CleanupScript, ScriptText, PowerShellExe, Parameters: String;
  ResultCode: Integer;
begin
  RemoveBrainLinkStartupLauncher;
  CleanupScript := ExpandConstant('{userappdata}\BrainLinkPathCleanup-' + IntToStr(GetCurrentProcessId) + '.ps1');
  ScriptText := '$ErrorActionPreference = ''SilentlyContinue''' + #13#10 +
    '$target = $args[0].Trim().Trim(''"'').TrimEnd(''\'', ''/'')' + #13#10 +
    '$parentPid = [int]$args[1]' + #13#10 +
    'while (Get-Process -Id $parentPid -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 100 }' + #13#10 +
    '$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey(''Environment'', $true)' + #13#10 +
    'if ($key) {' + #13#10 +
    '  $path = $key.GetValue(''Path'', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)' + #13#10 +
    '  if ($null -ne $path) {' + #13#10 +
    '    $parts = @($path -split '';'' | Where-Object { -not [string]::Equals($_.Trim().Trim(''"'').TrimEnd(''\'', ''/''), $target, [StringComparison]::OrdinalIgnoreCase) })' + #13#10 +
    '    if ($parts.Count -ne @($path -split '';'' ).Count) { if ($parts.Count) { $key.SetValue(''Path'', ($parts -join '';''), [Microsoft.Win32.RegistryValueKind]::ExpandString) } else { $key.DeleteValue(''Path'', $false) } }' + #13#10 +
    '  }' + #13#10 +
    '  $key.Close()' + #13#10 +
    '}' + #13#10 +
    'Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue' + #13#10;
  if SaveStringToFile(CleanupScript, ScriptText, False) then begin
    PowerShellExe := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
    Parameters := '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + CleanupScript + '" "' + BrainLinkInstallBin + '" "' + IntToStr(GetCurrentProcessId) + '"';
    if not Exec(PowerShellExe, Parameters, '', SW_HIDE, ewNoWait, ResultCode) then begin
      Log('Could not start the final PATH cleanup helper.');
      DeleteFile(CleanupScript);
    end;
  end else begin
    Log('Could not write the final PATH cleanup helper.');
  end;
end;
