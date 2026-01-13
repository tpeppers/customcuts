@echo off
echo Installing CustomCuts Whisper Native Host...
python "%~dp0install.py"
if %ERRORLEVEL% EQU 0 (
    echo.
    echo Installation successful!
    echo You may need to restart Chrome for changes to take effect.
) else (
    echo.
    echo Installation failed. Please check the error messages above.
)
pause
