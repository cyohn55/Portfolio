@echo off
echo 🚀 Setting up Email Monitor Auto-Start (SLEEP-MODE COMPATIBLE)
echo.
echo This will create Windows Task Scheduler entries that work even during sleep/wake cycles.
echo.

set SCRIPT_DIR=%~dp0
set PYTHON_SCRIPT=%SCRIPT_DIR%email_monitor.py
set TASK_NAME=Portfolio_Email_Monitor
set TASK_NAME_HOURLY=Portfolio_Email_Monitor_Hourly

echo Creating Windows Task Scheduler entries...
echo.

REM Delete existing tasks first
schtasks /delete /tn "%TASK_NAME%" /f >nul 2>&1
schtasks /delete /tn "%TASK_NAME_HOURLY%" /f >nul 2>&1

REM Create main task that runs at startup with SYSTEM privileges (survives sleep)
echo Creating main startup task...
schtasks /create /tn "%TASK_NAME%" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /ru "SYSTEM" /rl HIGHEST /f
if errorlevel 1 (
    echo ❌ Failed to create SYSTEM task. Creating with current user but with wake capability...
    schtasks /create /tn "%TASK_NAME%" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /ru "%USERNAME%" /it /f
    REM /it flag allows task to run interactively
)

REM Create hourly backup task that can wake the computer
echo Creating hourly backup task with wake capability...
schtasks /create /tn "%TASK_NAME_HOURLY%" /tr "python \"%PYTHON_SCRIPT%\"" /sc hourly /ru "%USERNAME%" /it /f

REM Configure the hourly task to wake the computer
schtasks /change /tn "%TASK_NAME_HOURLY%" /enable
echo Configuring wake settings for hourly task...
powershell -Command "& {$task = Get-ScheduledTask -TaskName '%TASK_NAME_HOURLY%'; $task.Settings.WakeToRun = $true; $task.Settings.DisallowStartIfOnBatteries = $false; $task.Settings.StopIfGoingOnBatteries = $false; Set-ScheduledTask -InputObject $task}"

echo.
echo ✅ Email monitor scheduled tasks created with sleep-mode compatibility!
echo.
echo Tasks created:
echo - %TASK_NAME%: Runs at startup (SYSTEM level)
echo - %TASK_NAME_HOURLY%: Runs every hour + can wake computer
echo.
echo 🔋 Power Management Features:
echo - ✅ Can wake computer from sleep
echo - ✅ Runs on battery power
echo - ✅ Survives sleep/wake cycles
echo.
echo To manage these tasks:
echo 1. Open Task Scheduler (taskschd.msc)
echo 2. Look for Portfolio_Email_Monitor tasks
echo 3. Check "Conditions" tab to verify wake settings
echo.
echo Testing the configuration...
schtasks /run /tn "%TASK_NAME_HOURLY%"
echo.
echo ✅ Setup complete! Your email monitor will now work even during sleep mode.

pause 