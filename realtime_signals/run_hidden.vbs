Option Explicit

Dim shell, fileSystem, scriptDirectory, scriptName, scriptPath, command, exitCode
If WScript.Arguments.Count <> 1 Then
    WScript.Quit 2
End If

scriptName = WScript.Arguments(0)
If InStr(scriptName, "\") > 0 Or InStr(scriptName, "/") > 0 Then
    WScript.Quit 3
End If

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fileSystem.BuildPath(scriptDirectory, scriptName)
command = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " _
    & Chr(34) & scriptPath & Chr(34)
exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
