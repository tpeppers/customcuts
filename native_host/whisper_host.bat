@echo off
setlocal

:: Log file for debugging
set LOGFILE=%~dp0whisper_host_bat.log

echo [%date% %time%] Starting whisper_host.bat >> "%LOGFILE%"

:: Use conda environment with Python 3.12 and CUDA support
set CONDA_EXE=C:\Users\taimp\anaconda3\Scripts\conda.exe
set CONDA_ENV=customcuts

echo [%date% %time%] Using conda env: %CONDA_ENV% >> "%LOGFILE%"
echo [%date% %time%] Running via conda run >> "%LOGFILE%"

"%CONDA_EXE%" run -n %CONDA_ENV% --no-capture-output python "%~dp0whisper_host.py" 2>> "%LOGFILE%"

echo [%date% %time%] Script exited with code %ERRORLEVEL% >> "%LOGFILE%"
