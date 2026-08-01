Option Explicit

Dim shell, fileSystem, rootDirectory, pythonwPath, appPath, command
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
rootDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
pythonwPath = fileSystem.BuildPath(rootDirectory, ".venv\Scripts\pythonw.exe")
appPath = fileSystem.BuildPath(rootDirectory, "tv_float.py")

If Not fileSystem.FileExists(pythonwPath) Then
    MsgBox "Missing Python runtime: " & pythonwPath, vbCritical, "TVFloat"
    WScript.Quit 2
End If

command = Chr(34) & pythonwPath & Chr(34) & " " & Chr(34) & appPath & Chr(34)
shell.Run command, 0, False
