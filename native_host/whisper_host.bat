@echo off
setlocal

:: Log file for debugging
set LOGFILE=%~dp0whisper_host_bat.log

:: Try to find Python
echo [%date% %time%] Starting whisper_host.bat >> "%LOGFILE%"

:: Use the full Python path from WindowsApps
set PYTHON_EXE=C:\Users\taimp\AppData\Local\Microsoft\WindowsApps\PythonSoftwareFoundation.Python.3.13_qbz5n2kfra8p0\python.exe

if not exist "%PYTHON_EXE%" (
    echo [%date% %time%] Python not found at %PYTHON_EXE% >> "%LOGFILE%"
    set PYTHON_EXE=python
)

echo [%date% %time%] Using Python: %PYTHON_EXE% >> "%LOGFILE%"
echo [%date% %time%] Running: %PYTHON_EXE% "%~dp0whisper_host.py" >> "%LOGFILE%"

"%PYTHON_EXE%" "%~dp0whisper_host.py" 2>> "%LOGFILE%"

echo [%date% %time%] Script exited with code %ERRORLEVEL% >> "%LOGFILE%"
