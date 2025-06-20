@echo off
echo ⚡ FAST EMAIL MONITORING OPTIONS ⚡
echo.
echo 1. INSTANT (Real-time IMAP IDLE) - Truly instant notifications
echo 2. FAST (1 minute polling) - Quick and simple
echo 3. MEDIUM (3 minute polling) - Balanced approach
echo 4. WEBHOOK (Gmail API Push) - Most reliable, requires setup
echo.
set /p choice="Choose monitoring speed (1-4): "

if "%choice%"=="1" (
    echo.
    echo 🚀 Starting REAL-TIME monitoring with IMAP IDLE...
    echo ⚡ Pages will be created INSTANTLY when emails arrive!
    echo.
    python email_monitor_realtime.py
) else if "%choice%"=="2" (
    echo.
    echo 🚀 Starting FAST monitoring (every 1 minute)...
    echo ⏱️ Pages will be created within 1-2 minutes!
    echo.
    python email_monitor.py
) else if "%choice%"=="3" (
    echo.
    echo 🚀 Starting MEDIUM monitoring (every 3 minutes)...
    echo ⏱️ Pages will be created within 3-4 minutes!
    echo.
    python -c "
import sys
from email_monitor import EmailMonitor, load_config
config = load_config()
monitor = EmailMonitor(config['email_settings'])
monitor.run_continuous_monitoring(check_interval=180)
    "
) else if "%choice%"=="4" (
    echo.
    echo 🚀 Starting WEBHOOK monitoring (Gmail API Push)...
    echo ⚡ Requires Google Cloud setup - see instructions!
    echo.
    python gmail_webhook_monitor.py
) else (
    echo Invalid choice. Please run again and choose 1-4.
    pause
)

pause 