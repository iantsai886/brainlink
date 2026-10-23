@echo off
rem Removes BrainLink from every connected AI app, the Startup-folder autostart entry and the
rem installed copy under %LOCALAPPDATA%\BrainLink. Notes are never touched -- they live wherever
rem the vault folder is, never inside BrainLink's own install folder.
echo Uninstalling BrainLink...
"%~dp0node\node.exe" "%~dp0app\bin\brainlink.mjs" win-uninstall
echo.
pause
