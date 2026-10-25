' Starts Bolt without a console window and opens its window.
' Pass --no-open to only start it in the background (used at Windows startup).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For Each a In WScript.Arguments
  args = args & " " & a
Next
nodeExe = "node"
If fso.FileExists(dir & "\node-path.txt") Then
  nodeExe = Trim(fso.OpenTextFile(dir & "\node-path.txt").ReadLine())
End If
sh.Run """" & nodeExe & """ """ & dir & "\bin\bolt.js"" start" & args, 0, False
