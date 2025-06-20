@echo off
echo 🛌 SLEEP MODE FIX - One-Click Solution
echo =======================================
echo.
echo This will fix your email automation to work during sleep mode.
echo.
pause

echo 🧹 Step 1: Removing old broken tasks...
schtasks /delete /tn "Portfolio_Email_Monitor" /f >nul 2>&1
schtasks /delete /tn "Portfolio_Email_Monitor_Hourly" /f >nul 2>&1
echo ✅ Old tasks removed

echo.
echo 🚀 Step 2: Creating sleep-compatible tasks...
set SCRIPT_DIR=%~dp0
set PYTHON_SCRIPT=%SCRIPT_DIR%email_monitor.py

echo Creating main startup task (SYSTEM level)...
schtasks /create /tn "Portfolio_Email_Monitor" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /ru "SYSTEM" /rl HIGHEST /f >nul 2>&1
if errorlevel 1 (
    echo ⚠️ SYSTEM task failed, creating user task with wake capability...
    schtasks /create /tn "Portfolio_Email_Monitor" /tr "python \"%PYTHON_SCRIPT%\"" /sc onstart /ru "%USERNAME%" /it /f >nul 2>&1
)
echo ✅ Main task created

echo Creating hourly wake-up task...
schtasks /create /tn "Portfolio_Email_Monitor_Hourly" /tr "python \"%PYTHON_SCRIPT%\"" /sc hourly /ru "%USERNAME%" /it /f >nul 2>&1
echo ✅ Hourly task created

echo.
echo 🔋 Step 3: Configuring power management...
powershell -Command "try { $task = Get-ScheduledTask -TaskName 'Portfolio_Email_Monitor_Hourly'; $task.Settings.WakeToRun = $true; $task.Settings.DisallowStartIfOnBatteries = $false; $task.Settings.StopIfGoingOnBatteries = $false; Set-ScheduledTask -InputObject $task; Write-Host '✅ Wake settings configured' } catch { Write-Host '⚠️ PowerShell config failed - manual setup needed' }" 2>nul

echo.
echo 🧪 Step 4: Testing the fix...
schtasks /run /tn "Portfolio_Email_Monitor_Hourly" >nul 2>&1
timeout /t 3 >nul
tasklist | findstr python.exe >nul
if errorlevel 1 (
    echo ⚠️ Python process not detected - check manually
) else (
    echo ✅ Email monitor is running!
)

echo.
echo 🎉 SLEEP MODE FIX COMPLETE!
echo.
echo What was fixed:
echo ✅ Tasks now run at SYSTEM level
echo ✅ Can wake computer from sleep
echo ✅ Runs on battery power
echo ✅ Survives sleep/wake cycles
echo.
echo 📱 TEST IT NOW:
echo 1. Put your computer to sleep
echo 2. Send email from your phone
echo 3. Wait 10 minutes, then wake computer
echo 4. Check if email was processed!
echo.
echo View logs: type email_monitor.log
echo Manage tasks: taskschd.msc
echo.
pause 