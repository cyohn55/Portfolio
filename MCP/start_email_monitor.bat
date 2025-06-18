@echo off
echo 📧 Starting Email-to-Portfolio Automation System...
echo.
echo Configuration:
echo - Receiving Email: email.to.portfolio.site@gmail.com
echo - Authorized Sender: cyohn55@yahoo.com
echo - Check Interval: Every 5 minutes
echo.
echo Press Ctrl+C to stop monitoring
echo.
python email_monitor.py
pause 