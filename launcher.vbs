Dim sh : Set sh = CreateObject("WScript.Shell")
sh.Run "taskkill /F /IM node.exe", 0, True
sh.Run "node """ & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\server.js""", 0, False
