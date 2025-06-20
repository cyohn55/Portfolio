#!/usr/bin/env python3
"""
Wake Controller - Email-based Computer Wake Management
Processes wake-up commands sent via email to control computer sleep behavior
"""

import re
import subprocess
import logging
import time
import threading
from datetime import datetime, timedelta
from typing import Dict, Optional, Tuple

logger = logging.getLogger(__name__)

class WakeController:
    def __init__(self):
        self.wake_thread = None
        self.stop_wake_thread = False
        self.current_wake_mode = "normal"  # normal, frequent, awake
        self.awake_until = None
        
    def detect_wake_command(self, subject: str, body: str) -> Optional[Dict]:
        """
        Detect wake commands in email subject/body
        Returns dict with command details or None if no command found
        """
        # Look for [Wake Up] at the start of subject line (case insensitive)
        wake_pattern = r'^\s*\[wake\s+up\](.*)$'
        match = re.search(wake_pattern, subject, re.IGNORECASE)
        
        if not match:
            return None
        
        command_text = match.group(1).strip() if match.group(1) else ""
        
        # Parse different wake command types
        if not command_text:
            # Simple [Wake Up] command
            return {
                'type': 'wake_once',
                'description': 'Wake computer once'
            }
        
        # [Wake Up] every X minutes/hours
        every_pattern = r'every\s+(\d+)\s+(minutes?|mins?|hours?|hrs?)'
        every_match = re.search(every_pattern, command_text, re.IGNORECASE)
        
        if every_match:
            amount = int(every_match.group(1))
            unit = every_match.group(2).lower()
            
            # Convert to minutes
            if unit.startswith('h'):
                interval_minutes = amount * 60
            else:
                interval_minutes = amount
                
            return {
                'type': 'wake_frequent',
                'interval_minutes': interval_minutes,
                'description': f'Wake every {amount} {every_match.group(2)}'
            }
        
        # [Wake Up] for X hours/minutes  
        for_pattern = r'for\s+(\d+)\s+(minutes?|mins?|hours?|hrs?)'
        for_match = re.search(for_pattern, command_text, re.IGNORECASE)
        
        if for_match:
            amount = int(for_match.group(1))
            unit = for_match.group(2).lower()
            
            # Convert to minutes
            if unit.startswith('h'):
                duration_minutes = amount * 60
            else:
                duration_minutes = amount
                
            return {
                'type': 'stay_awake',
                'duration_minutes': duration_minutes,
                'description': f'Stay awake for {amount} {for_match.group(2)}'
            }
        
        # If we found [Wake Up] but couldn't parse the command, default to wake once
        return {
            'type': 'wake_once',
            'description': f'Wake computer once (unrecognized command: {command_text})'
        }
    
    def execute_wake_command(self, command: Dict) -> bool:
        """Execute the wake command and return success status"""
        try:
            if command['type'] == 'wake_once':
                return self._wake_once()
            elif command['type'] == 'wake_frequent':
                return self._set_frequent_wake(command['interval_minutes'])
            elif command['type'] == 'stay_awake':
                return self._stay_awake(command['duration_minutes'])
            else:
                logger.error(f"Unknown wake command type: {command['type']}")
                return False
        except Exception as e:
            logger.error(f"Error executing wake command: {e}")
            return False
    
    def _wake_once(self) -> bool:
        """Wake the computer once (immediate action)"""
        logger.info("Executing immediate wake command")
        
        # The computer is already awake if we're processing this email
        # But we can ensure it stays awake briefly and log the action
        try:
            # Prevent sleep for 5 minutes to ensure email processing completes
            subprocess.run([
                'powercfg', '/requestsoverride', 'PROCESS', 'python.exe', 'SYSTEM'
            ], check=False, capture_output=True)
            
            # Set a timer to remove the override
            threading.Timer(300, self._remove_power_override).start()  # 5 minutes
            
            logger.info("✅ Computer woken up and will stay awake for 5 minutes")
            return True
            
        except Exception as e:
            logger.error(f"Failed to execute wake command: {e}")
            return False
    
    def _set_frequent_wake(self, interval_minutes: int) -> bool:
        """Set up frequent wake schedule"""
        logger.info(f"Setting up frequent wake every {interval_minutes} minutes")
        
        try:
            # Create new scheduled task with frequent interval
            task_name = "Portfolio_Email_Monitor_FREQUENT"
            script_path = self._get_script_path()
            
            # Delete existing frequent task if exists
            subprocess.run([
                'schtasks', '/delete', '/tn', task_name, '/f'
            ], check=False, capture_output=True)
            
            # Create new frequent task
            result = subprocess.run([
                'schtasks', '/create', '/tn', task_name,
                '/tr', f'"{script_path}"',
                '/sc', 'minute', '/mo', str(interval_minutes),
                '/f'
            ], check=True, capture_output=True, text=True)
            
            # Configure wake settings
            self._configure_task_wake_settings(task_name)
            
            # Disable the normal hourly task temporarily
            subprocess.run([
                'schtasks', '/change', '/tn', 'Portfolio_Email_Monitor_WORKING', '/disable'
            ], check=False, capture_output=True)
            
            self.current_wake_mode = "frequent"
            logger.info(f"✅ Frequent wake schedule set: every {interval_minutes} minutes")
            
            # Set up auto-revert after 24 hours
            threading.Timer(86400, self._revert_to_normal_schedule).start()
            
            return True
            
        except Exception as e:
            logger.error(f"Failed to set frequent wake schedule: {e}")
            return False
    
    def _stay_awake(self, duration_minutes: int) -> bool:
        """Keep computer awake for specified duration"""
        logger.info(f"Keeping computer awake for {duration_minutes} minutes")
        
        try:
            # Set power override to prevent sleep
            subprocess.run([
                'powercfg', '/requestsoverride', 'PROCESS', 'python.exe', 'SYSTEM', 'DISPLAY'
            ], check=False, capture_output=True)
            
            # Calculate when to stop staying awake
            self.awake_until = datetime.now() + timedelta(minutes=duration_minutes)
            self.current_wake_mode = "awake"
            
            # Set timer to remove override
            threading.Timer(duration_minutes * 60, self._remove_power_override).start()
            
            logger.info(f"✅ Computer will stay awake until {self.awake_until.strftime('%I:%M %p')}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to keep computer awake: {e}")
            return False
    
    def _configure_task_wake_settings(self, task_name: str):
        """Configure a task to wake the computer"""
        try:
            # Use PowerShell to set wake settings
            ps_command = f"""
            $task = Get-ScheduledTask -TaskName '{task_name}'
            $task.Settings.WakeToRun = $true
            $task.Settings.DisallowStartIfOnBatteries = $false
            $task.Settings.StopIfGoingOnBatteries = $false
            Set-ScheduledTask -InputObject $task
            """
            
            subprocess.run([
                'powershell', '-Command', ps_command
            ], check=False, capture_output=True)
            
        except Exception as e:
            logger.warning(f"Could not configure wake settings for {task_name}: {e}")
    
    def _get_script_path(self) -> str:
        """Get the path to the run_email_monitor.bat script"""
        import os
        script_dir = os.path.dirname(os.path.abspath(__file__))
        return os.path.join(script_dir, 'run_email_monitor.bat')
    
    def _remove_power_override(self):
        """Remove power override to allow normal sleep behavior"""
        try:
            subprocess.run([
                'powercfg', '/requestsoverride', 'PROCESS', 'python.exe'
            ], check=False, capture_output=True)
            
            if self.current_wake_mode == "awake":
                self.current_wake_mode = "normal"
                self.awake_until = None
                logger.info("✅ Power override removed - computer can sleep normally")
                
        except Exception as e:
            logger.error(f"Failed to remove power override: {e}")
    
    def _revert_to_normal_schedule(self):
        """Revert back to normal hourly wake schedule"""
        try:
            # Disable frequent task
            subprocess.run([
                'schtasks', '/change', '/tn', 'Portfolio_Email_Monitor_FREQUENT', '/disable'
            ], check=False, capture_output=True)
            
            # Re-enable normal task
            subprocess.run([
                'schtasks', '/change', '/tn', 'Portfolio_Email_Monitor_WORKING', '/enable'
            ], check=False, capture_output=True)
            
            self.current_wake_mode = "normal"
            logger.info("✅ Reverted to normal hourly wake schedule")
            
        except Exception as e:
            logger.error(f"Failed to revert to normal schedule: {e}")
    
    def get_current_status(self) -> Dict:
        """Get current wake controller status"""
        status = {
            'mode': self.current_wake_mode,
            'timestamp': datetime.now().isoformat()
        }
        
        if self.awake_until:
            status['awake_until'] = self.awake_until.isoformat()
            status['minutes_remaining'] = int((self.awake_until - datetime.now()).total_seconds() / 60)
        
        return status

# Global instance
wake_controller = WakeController() 