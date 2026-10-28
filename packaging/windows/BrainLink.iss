; Inno Setup 6 script: per-user install (no admin), Start-menu entry, `brainlink` on PATH.
; Built by build-windows.ps1, which stages files into ..\..\build\windows\stage.
#define AppVersion GetEnv("BRAINLINK_VERSION")
#define Stage "..\..\build\windows\stage"

[Setup]
AppId={{6F2B8E4C-9A51-4C1E-B7D3-2B1A9E5C7F40}
AppName=BrainLink
AppVersion={#AppVersion}
AppPublisher=Iango
DefaultDirName={localappdata}\Programs\BrainLink
DefaultGroupName=BrainLink
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist
OutputBaseFilename=BrainLink-Setup-{#AppVersion}
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
Name: "{group}\BrainLink"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; IconFilename: "{app}\BrainLink.ico"
Name: "{autodesktop}\BrainLink"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; IconFilename: "{app}\BrainLink.ico"
Name: "{group}\Uninstall BrainLink"; Filename: "{uninstallexe}"

[Registry]
; Add {app}\bin to the user's PATH once.
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}\bin"; Check: NeedsAddPath(ExpandConstant('{app}\bin'))

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\BrainLink.vbs"""; Description: "Open BrainLink Setup"; Flags: postinstall nowait skipifsilent

[Code]
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
  Paths, Target, Segment: String;
  StartPos, SeparatorPos, EndPos: Integer;
  Changed: Boolean;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then exit;
  Target := ExpandConstant('{app}\bin');
  Changed := False;
  StartPos := 1;
  while StartPos <= Length(Paths) + 1 do begin
    SeparatorPos := Pos(';', Copy(Paths, StartPos, Length(Paths) - StartPos + 1));
    if SeparatorPos = 0 then EndPos := Length(Paths) + 1
    else EndPos := StartPos + SeparatorPos - 1;
    Segment := Copy(Paths, StartPos, EndPos - StartPos);
    if SamePathEntry(Segment, Target) then begin
      Changed := True;
      if EndPos <= Length(Paths) then Delete(Paths, StartPos, EndPos - StartPos + 1)
      else if StartPos > 1 then Delete(Paths, StartPos - 1, EndPos - StartPos + 1)
      else Delete(Paths, StartPos, EndPos - StartPos);
      StartPos := 1;
    end else StartPos := EndPos + 1;
  end;
  if Changed then begin
    if Paths = '' then RegDeleteValue(HKCU, 'Environment', 'Path')
    else if not RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Paths) then Log('Could not remove BrainLink from the user PATH.');
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then RemoveBrainLinkFromUserPath;
end;
