@echo off
rem PetBuddy launcher (dev mode: runs Electron from node_modules)
set "PET_DIR=%~dp0"
rem strip trailing backslash: %~dp0 ends with \ and "...petbuddy\" would let \"
rem escape the closing quote, so Electron gets an app path ending in a literal "
if "%PET_DIR:~-1%"=="\" set "PET_DIR=%PET_DIR:~0,-1%"
if not exist "%PET_DIR%\node_modules\electron\dist\electron.exe" (
  echo [PetBuddy] Electron not installed. Run: npm install
  pause
  exit /b 1
)
start "" "%PET_DIR%\node_modules\electron\dist\electron.exe" "%PET_DIR%" %*
