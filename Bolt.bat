@echo off
rem Runs Bolt in this console window (shows a log). Use Bolt.vbs to run it hidden.
rem   Bolt.bat              start and open the window
rem   Bolt.bat add <url>    queue a download from the command line
if "%~1"=="" (
  node "%~dp0bin\bolt.js" start
) else (
  node "%~dp0bin\bolt.js" %*
)
