' Start-menu launcher: opens BrainLink Setup in the browser without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
args = "setup --app"
port = shell.ExpandEnvironmentStrings("%BRAINLINK_SETUP_PORT%")
If port <> "%BRAINLINK_SETUP_PORT%" And IsNumeric(port) Then
  portValue = CDbl(port)
  If portValue >= 1 And portValue <= 65535 And portValue = Fix(portValue) Then args = args & " --port " & CLng(portValue)
End If
If shell.ExpandEnvironmentStrings("%BRAINLINK_NO_OPEN%") = "1" Then args = args & " --no-open"
shell.Run """" & dir & "\node\node.exe"" """ & dir & "\app\bin\brainlink.mjs"" " & args, 0, False
