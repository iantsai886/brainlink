; BrainLink MCP - Windows installer (NSIS 3). Per-user install, no admin rights needed.
; Built by build-windows.sh (macOS/Linux) or build-windows.ps1 (Windows), which pass:
;   /DVERSION=1.1.0 /DSTAGE=<staged files> /DOUTFILE=<installer path> [/DSIGN=<sign command>]
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "BrainLink MCP ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\BrainLink"
InstallDirRegKey HKCU "Software\BrainLink" "InstallDir"
BrandingText "BrainLink MCP ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "BrainLink MCP"
VIAddVersionKey "CompanyName" "Iango"
VIAddVersionKey "FileDescription" "BrainLink MCP installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "(c) Iango"

!ifdef SIGN
  !finalize '${SIGN} "%1"'
  !uninstfinalize '${SIGN} "%1"'
!endif

!define MUI_ICON "BrainLink.ico"
!define MUI_UNICON "BrainLink.ico"
!define MUI_ABORTWARNING
!define MUI_WELCOMEPAGE_TITLE "Install BrainLink MCP"
!define MUI_WELCOMEPAGE_TEXT "One Obsidian / Markdown second brain for every AI you use: Claude, ChatGPT Codex, Cursor, Gemini and more.$\r$\n$\r$\nYour notes never leave this computer. BrainLink only changes an AI app's settings when you press Connect, and keeps a backup each time.$\r$\n$\r$\nNo administrator rights are needed."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenSetup
!define MUI_FINISHPAGE_RUN_TEXT "Open BrainLink Setup"
!define MUI_FINISHPAGE_RUN_CHECKED

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}\app\LICENSE.txt"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "TradChinese"

Function OpenSetup
  Exec '"$SYSDIR\wscript.exe" "$INSTDIR\BrainLink.vbs"'
FunctionEnd

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\BrainLink"

Section "BrainLink" SecMain
  SetOutPath "$INSTDIR"
  ; Replace the program files on upgrade; settings live in %APPDATA%\BrainLink and are kept.
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  File /r "${STAGE}\*"
  WriteUninstaller "$INSTDIR\Uninstall BrainLink.exe"

  CreateDirectory "$SMPROGRAMS\BrainLink"
  CreateShortcut "$SMPROGRAMS\BrainLink\BrainLink.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\BrainLink.vbs"' "$INSTDIR\BrainLink.ico"
  CreateShortcut "$DESKTOP\BrainLink.lnk" "$SYSDIR\wscript.exe" '"$INSTDIR\BrainLink.vbs"' "$INSTDIR\BrainLink.ico"
  CreateShortcut "$SMPROGRAMS\BrainLink\Uninstall BrainLink.lnk" "$INSTDIR\Uninstall BrainLink.exe"

  ; Put `brainlink` on the user's PATH (no admin; takes effect in new terminals).
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\bin'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if (-not $$p) { $$p='' }; if (($$p -split ';') -notcontains $$d) { [Environment]::SetEnvironmentVariable('Path', ($$p.TrimEnd(';') + ';' + $$d).TrimStart(';'), 'User') }"`
  Pop $0

  WriteRegStr HKCU "Software\BrainLink" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "BrainLink MCP"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Iango"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\BrainLink.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall BrainLink.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Remove only the exact BrainLink-managed per-user startup launcher; preserve any user-owned file.
  IfFileExists "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\BrainLink Background.vbs" 0 +5
  FileOpen $0 "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\BrainLink Background.vbs" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "' BrainLink managed startup launcher v1$\r$\n" 0 +2
  Delete "$APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\BrainLink Background.vbs"
  ; Remove BrainLink from connected AI apps first (keeps their other settings; backups are made).
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
    nsExec::ExecToLog '"$INSTDIR\node\node.exe" "$INSTDIR\app\bin\brainlink.mjs" disconnect-all'
    Pop $0
  ${EndIf}
  nsExec::ExecToLog `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$d='$INSTDIR\bin'; $$p=[Environment]::GetEnvironmentVariable('Path','User'); if ($$p) { [Environment]::SetEnvironmentVariable('Path', (($$p -split ';') | Where-Object { $$_ -and $$_ -ne $$d }) -join ';', 'User') }"`
  Pop $0
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\node"
  RMDir /r "$INSTDIR\bin"
  Delete "$INSTDIR\BrainLink.vbs"
  Delete "$INSTDIR\BrainLink.ico"
  Delete "$INSTDIR\Uninstall BrainLink.exe"
  Delete "$DESKTOP\BrainLink.lnk"
  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\BrainLink"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\BrainLink"
  ; Notes and %APPDATA%\BrainLink (settings) are left in place on purpose.
SectionEnd
