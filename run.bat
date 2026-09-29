@echo off
rem Being launcher - double-click entry point.
rem Starts the local server (own window) and opens the chat UI in the browser.
rem ASCII-only + CRLF on purpose: non-ASCII bytes in the cmd-parsed header
rem get read as OEM code page and break the first lines.
setlocal
chcp 65001 >nul
cd /d "%~dp0"

rem Keep in sync with "port" in config.json.
set "PORT=8619"
set "URL=http://127.0.0.1:%PORT%/"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH. Install Python 3 first.
  pause
  exit /b 1
)
where curl >nul 2>nul
if errorlevel 1 (
  echo [ERROR] curl not found. Windows 10 1803+ ships it.
  pause
  exit /b 1
)

rem -Check: report what this script would do, start nothing, open nothing.
if /i "%~1"=="-Check" (
  echo mode    : check only
  echo script  : %~f0
  echo port    : %PORT%
  echo url     : %URL%
  echo python  : & where python
  echo config  :
  python -c "import json;d=json.load(open('config.json',encoding='utf-8'));v=d.get('vision') or {};g=d.get('imagegen') or {};on=bool(v.get('endpoint') and v.get('model') and g.get('endpoint') and g.get('model'));print('  model   :',d.get('model'));print('  endpoint:',d.get('endpoint'));print('  api_key :','set' if d.get('api_key') else 'MISSING');print('  delay   :',d.get('delay'));print('  vision  :','set' if v.get('model') else 'MISSING');print('  imagegen:','set' if g.get('model') else 'MISSING');print('  nickname+photo:','ON' if on else 'OFF (fill vision AND imagegen)')"
  curl -s -o NUL --max-time 1 "%URL%" 2>nul
  if errorlevel 1 (echo status  : not running) else (echo status  : already running)
  exit /b 0
)

curl -s -o NUL --max-time 1 "%URL%" 2>nul
if not errorlevel 1 (
  echo Being is already running - opening the browser.
  start "" "%URL%"
  exit /b 0
)

echo Starting Being ... close the "Being server" window to stop it.
start "Being server" cmd /c "python server.py"

rem Wait until it answers, then open the UI. ping, not timeout: timeout needs
rem a console input handle and dies when stdio is redirected.
for /l %%i in (1,1,60) do (
  curl -s -o NUL --max-time 1 "%URL%" 2>nul
  if not errorlevel 1 goto :ready
  ping -n 2 127.0.0.1 >nul
)
echo [ERROR] the server did not come up within 60 seconds.
echo Look at the "Being server" window for the traceback.
pause
exit /b 1

:ready
start "" "%URL%"
exit /b 0
