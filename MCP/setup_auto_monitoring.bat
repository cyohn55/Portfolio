@echo off
echo 🚀 Setting up Email Monitor Auto-Start
echo.
echo This will create a Windows Task Scheduler entry to run the email monitor automatically.
echo.

set SCRIPT_DIR=%~dp0
set PYTHON_SCRIPT=%SCRIPT_DIR%email_monitor.py
set TASK_NAME=Portfolio_Email_Monitor

echo Creating Windows Task Scheduler entry...
echo.

REM Create a task that runs at startup and every 5 minutes if it stops
schtasks /create /tn "%TASK_NAME%" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /ru "SYSTEM" /f
if errorlevel 1 (
    echo ❌ Failed to create task. Trying with current user...
    schtasks /create /tn "%TASK_NAME%" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /f
)

REM Also create a task that runs every hour to ensure it's still running
schtasks /create /tn "%TASK_NAME%_Hourly" /tr "python \"%PYTHON_SCRIPT%\"" /sc hourly /f

echo.
echo ✅ Email monitor scheduled tasks created!
echo.
echo Tasks created:
echo - %TASK_NAME%: Runs at startup
echo - %TASK_NAME%_Hourly: Runs every hour as backup
echo.
echo To manage these tasks:
echo 1. Open Task Scheduler (taskschd.msc)
echo 2. Look for Portfolio_Email_Monitor tasks
echo.
echo Starting the monitor now...
python "%PYTHON_SCRIPT%"

pause 