@echo off
rem BrainLink command: runs the bundled Node runtime, so no system Node is needed.
"%~dp0..\node\node.exe" "%~dp0..\app\bin\brainlink.mjs" %*
