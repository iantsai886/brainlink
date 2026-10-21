' Start-menu launcher: opens BrainLink Setup in the browser without a console window.
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
CreateObject("WScript.Shell").Run """" & dir & "\node\node.exe"" """ & dir & "\app\bin\brainlink.mjs"" setup --app", 0, False
