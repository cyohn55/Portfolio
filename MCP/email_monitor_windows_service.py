#!/usr/bin/env python3
"""
Windows Service version of Email Monitor
This version runs as a proper Windows service and can survive sleep/wake cycles
"""

import win32serviceutil
import win32service
import win32event
import servicemanager
import socket
import time
import os
import sys
import logging

# Add current directory to path to import our modules
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from email_monitor import EmailMonitor, load_config

class EmailMonitorWindowsService(win32serviceutil.ServiceFramework):
    _svc_name_ = "PortfolioEmailMonitor"
    _svc_display_name_ = "Portfolio Email Monitor Service"
    _svc_description_ = "Monitors email for portfolio website updates. Runs continuously and survives sleep/wake cycles."
    
    def __init__(self, args):
        win32serviceutil.ServiceFramework.__init__(self, args)
        self.hWaitStop = win32event.CreateEvent(None, 0, 0, None)
        socket.setdefaulttimeout(60)
        self.running = True
        
        # Set up logging for Windows Service
        self.setup_service_logging()
        
    def setup_service_logging(self):
        """Configure logging for Windows service"""
        log_path = os.path.join(os.path.dirname(__file__), 'email_monitor_service.log')
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler(log_path),
            ]
        )
        self.logger = logging.getLogger(__name__)
        
    def SvcStop(self):
        """Stop the service"""
        self.logger.info("Email Monitor Windows Service stopping...")
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        win32event.SetEvent(self.hWaitStop)
        self.running = False
        
    def SvcDoRun(self):
        """Main service loop"""
        self.logger.info("Email Monitor Windows Service starting...")
        servicemanager.LogMsg(servicemanager.EVENTLOG_INFORMATION_TYPE,
                            servicemanager.PYS_SERVICE_STARTED,
                            (self._svc_name_, ''))
        
        try:
            # Load configuration
            config = load_config()
            email_config = config['email_settings']
            
            # Create monitor instance
            monitor = EmailMonitor(email_config)
            self.logger.info("Email monitor initialized successfully")
            
            # Main service loop
            while self.running:
                try:
                    # Check for emails
                    monitor.process_new_emails()
                    
                    # Wait 60 seconds or until stop event
                    if win32event.WaitForSingleObject(self.hWaitStop, 60000) == win32event.WAIT_OBJECT_0:
                        break
                        
                except Exception as e:
                    self.logger.error(f"Error in service loop: {e}")
                    # Sleep on error to prevent rapid cycling
                    time.sleep(60)
                    
        except Exception as e:
            self.logger.error(f"Fatal error in service: {e}")
            servicemanager.LogErrorMsg(f"Portfolio Email Monitor Service error: {e}")
        
        self.logger.info("Email Monitor Windows Service stopped")

def install_service():
    """Install the Windows service"""
    try:
        win32serviceutil.InstallService(
            EmailMonitorWindowsService,
            EmailMonitorWindowsService._svc_name_,
            EmailMonitorWindowsService._svc_display_name_,
            description=EmailMonitorWindowsService._svc_description_
        )
        print("✅ Service installed successfully!")
        print(f"Service Name: {EmailMonitorWindowsService._svc_name_}")
        print(f"Display Name: {EmailMonitorWindowsService._svc_display_name_}")
        print("\nTo start the service:")
        print(f"  net start {EmailMonitorWindowsService._svc_name_}")
        print("\nTo stop the service:")
        print(f"  net stop {EmailMonitorWindowsService._svc_name_}")
        print("\nTo uninstall the service:")
        print(f"  python {__file__} remove")
        
    except Exception as e:
        print(f"❌ Failed to install service: {e}")
        print("Make sure you're running as administrator!")

def remove_service():
    """Remove the Windows service"""
    try:
        win32serviceutil.RemoveService(EmailMonitorWindowsService._svc_name_)
        print("✅ Service removed successfully!")
    except Exception as e:
        print(f"❌ Failed to remove service: {e}")

if __name__ == '__main__':
    if len(sys.argv) == 1:
        # Run as service
        servicemanager.Initialize()
        servicemanager.PrepareToHostSingle(EmailMonitorWindowsService)
        servicemanager.StartServiceCtrlDispatcher()
    else:
        # Handle command line arguments
        if sys.argv[1].lower() == 'install':
            install_service()
        elif sys.argv[1].lower() == 'remove':
            remove_service()
        elif sys.argv[1].lower() == 'start':
            win32serviceutil.StartService(EmailMonitorWindowsService._svc_name_)
            print("✅ Service started!")
        elif sys.argv[1].lower() == 'stop':
            win32serviceutil.StopService(EmailMonitorWindowsService._svc_name_)
            print("✅ Service stopped!")
        else:
            # Default service handling
            win32serviceutil.HandleCommandLine(EmailMonitorWindowsService) 