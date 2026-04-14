@echo off
setlocal

:: Log file for debugging the launcher itself
set LOGFILE=%~dp0customcuts_host_bat.log

echo [%date% %time%] Starting customcuts_host.bat >> "%LOGFILE%"

:: Use conda environment with Python 3.12 (shared with whisper host)
set CONDA_EXE=C:\Users\taimp\anaconda3\Scripts\conda.exe
set CONDA_ENV=customcuts

echo [%date% %time%] Using conda env: %CONDA_ENV% >> "%LOGFILE%"

"%CONDA_EXE%" run -n %CONDA_ENV% --no-capture-output python "%~dp0customcuts_host.py" 2>> "%LOGFILE%"

echo [%date% %time%] Script exited with code %ERRORLEVEL% >> "%LOGFILE%"
