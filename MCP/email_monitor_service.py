#!/usr/bin/env python3
"""
Email Monitor Service Wrapper
Robust wrapper that automatically restarts the email monitor if it crashes
Includes logging, error handling, and automatic recovery
"""

import os
import sys
import time
import logging
import subprocess
import signal
from datetime import datetime
from pathlib import Path

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('email_monitor_service.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class EmailMonitorService:
    def __init__(self):
        self.process = None
        self.running = True
        self.restart_count = 0
        self.max_restarts = 10  # Maximum restarts per hour
        self.restart_window = 3600  # 1 hour in seconds
        self.restart_times = []
        
    def cleanup_old_restarts(self):
        """Remove restart times older than the restart window"""
        current_time = time.time()
        self.restart_times = [t for t in self.restart_times if current_time - t < self.restart_window]
    
    def can_restart(self):
        """Check if we can restart (haven't exceeded max restarts)"""
        self.cleanup_old_restarts()
        return len(self.restart_times) < self.max_restarts
    
    def start_monitor(self):
        """Start the email monitor process"""
        try:
            cmd = [sys.executable, 'email_monitor.py']
            self.process = subprocess.Popen(
                cmd,
                cwd=os.path.dirname(os.path.abspath(__file__)),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True
            )
            logger.info(f"Email monitor started with PID: {self.process.pid}")
            return True
        except Exception as e:
            logger.error(f"Failed to start email monitor: {e}")
            return False
    
    def stop_monitor(self):
        """Stop the email monitor process"""
        if self.process and self.process.poll() is None:
            try:
                self.process.terminate()
                self.process.wait(timeout=10)
                logger.info("Email monitor stopped gracefully")
            except subprocess.TimeoutExpired:
                self.process.kill()
                logger.warning("Email monitor force-killed")
            except Exception as e:
                logger.error(f"Error stopping email monitor: {e}")
    
    def monitor_process(self):
        """Monitor the email monitor process and restart if needed"""
        while self.running:
            if not self.process or self.process.poll() is not None:
                # Process is not running
                if self.process and self.process.returncode != 0:
                    logger.warning(f"Email monitor exited with code: {self.process.returncode}")
                
                if self.can_restart():
                    logger.info("Restarting email monitor...")
                    self.restart_times.append(time.time())
                    if self.start_monitor():
                        self.restart_count += 1
                        logger.info(f"Email monitor restarted (restart #{self.restart_count})")
                    else:
                        logger.error("Failed to restart email monitor")
                        time.sleep(60)  # Wait before trying again
                else:
                    logger.error(f"Maximum restarts ({self.max_restarts}) reached in the last hour. Stopping service.")
                    break
            
            # Check process health every 30 seconds
            time.sleep(30)
    
    def signal_handler(self, signum, frame):
        """Handle shutdown signals"""
        logger.info(f"Received signal {signum}. Shutting down...")
        self.running = False
        self.stop_monitor()
        sys.exit(0)
    
    def run(self):
        """Main service loop"""
        logger.info("Starting Email Monitor Service")
        logger.info(f"Working directory: {os.getcwd()}")
        
        # Set up signal handlers
        signal.signal(signal.SIGINT, self.signal_handler)
        signal.signal(signal.SIGTERM, self.signal_handler)
        
        # Start initial monitor
        if not self.start_monitor():
            logger.error("Failed to start initial email monitor. Exiting.")
            return
        
        # Start monitoring loop
        try:
            self.monitor_process()
        except KeyboardInterrupt:
            logger.info("Service interrupted by user")
        except Exception as e:
            logger.error(f"Unexpected error in service: {e}")
        finally:
            self.stop_monitor()
            logger.info("Email Monitor Service stopped")

def main():
    """Main entry point"""
    service = EmailMonitorService()
    service.run()

if __name__ == "__main__":
    main() 