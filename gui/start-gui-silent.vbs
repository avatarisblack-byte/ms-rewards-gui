' ===== Silent start of Microsoft Rewards GUI service (Silent Mode) =====
' Hides the console window (window mode 0) and runs start-gui.bat in the background.
' start-gui.bat no longer spawns PowerShell: the browser is opened with the native
' CMD "start" command, so no extra black window appears. Result: zero windows.
' NOTE: comments are ASCII-only so this file is encoding-independent.

Set shell = CreateObject("WScript.Shell")

' Window mode 0 = hidden (no CMD console window)
' False = do not wait for the bat to finish before returning
shell.Run "start-gui.bat", 0, False

Set shell = Nothing
