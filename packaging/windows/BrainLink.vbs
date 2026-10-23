' Double-click launcher: installs BrainLink into %LOCALAPPDATA%\BrainLink and a Startup-folder
' autostart entry on first run (win-start, see src/winapp.mjs), then opens BrainLink Setup in the
' browser -- no console window, ever.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node\node.exe"" """ & dir & "\app\bin\brainlink.mjs"" win-start", 0, False
