#!/usr/bin/env python3
"""
Real-Time Email Monitor using IMAP IDLE
Provides instant notifications when new emails arrive
"""

import imaplib
import email
import time
import os
import sys
import json
import logging
import threading
import select
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from email.header import decode_header
import subprocess

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('email_monitor_realtime.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class RealTimeEmailMonitor:
    def __init__(self, email_config: Dict[str, str]):
        """Initialize real-time email monitor with IMAP IDLE support"""
        self.server = email_config['server']
        self.port = email_config['port']
        self.username = email_config['username']
        self.password = email_config['password']
        self.authorized_sender = email_config['authorized_sender']
        self.processed_emails = self.load_processed_emails()
        self.mail = None
        self.idle_thread = None
        self.stop_monitoring = False
        
    def load_processed_emails(self) -> set:
        """Load list of already processed email IDs"""
        try:
            if os.path.exists('processed_emails.json'):
                with open('processed_emails.json', 'r') as f:
                    return set(json.load(f))
        except Exception as e:
            logger.warning(f"Could not load processed emails: {e}")
        return set()
    
    def save_processed_emails(self):
        """Save list of processed email IDs"""
        try:
            with open('processed_emails.json', 'w') as f:
                json.dump(list(self.processed_emails), f)
        except Exception as e:
            logger.error(f"Could not save processed emails: {e}")
    
    def connect_to_email(self) -> Optional[imaplib.IMAP4_SSL]:
        """Connect to email server"""
        try:
            mail = imaplib.IMAP4_SSL(self.server, self.port)
            mail.login(self.username, self.password)
            logger.info("Successfully connected to email server for real-time monitoring")
            return mail
        except Exception as e:
            logger.error(f"Failed to connect to email server: {e}")
            return None
    
    def decode_email_header(self, header: str) -> str:
        """Decode email header"""
        try:
            decoded = decode_header(header)[0]
            if isinstance(decoded[0], bytes):
                return decoded[0].decode(decoded[1] or 'utf-8')
            return decoded[0]
        except Exception as e:
            logger.warning(f"Could not decode header: {e}")
            return header
    
    def extract_email_content(self, msg) -> Dict[str, str]:
        """Extract content from email message"""
        subject = self.decode_email_header(msg['Subject'] or 'No Subject')
        sender = self.decode_email_header(msg['From'] or '')
        
        # Extract email body
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        body = part.get_payload(decode=True).decode('utf-8')
                        break
                    except:
                        continue
        else:
            try:
                body = msg.get_payload(decode=True).decode('utf-8')
            except:
                body = str(msg.get_payload())
        
        return {
            'subject': subject,
            'sender': sender,
            'body': body,
            'date': msg['Date']
        }
    
    def is_authorized_sender(self, sender: str) -> bool:
        """Check if sender is authorized to create pages"""
        return self.authorized_sender.lower() in sender.lower()
    
    def is_page_creation_email(self, subject: str, body: str) -> bool:
        """Check if email is intended for page creation"""
        # Same logic as original monitor
        page_keywords = [
            'create page', 'new page', 'portfolio page', 'add page', 'website update'
        ]
        
        subject_lower = subject.lower()
        body_lower = body.lower()
        
        for keyword in page_keywords:
            if keyword in subject_lower or keyword in body_lower:
                return True
        
        if '#' in body and any(line.strip().startswith('#') for line in body.split('\n')):
            return True
        
        non_page_keywords = ['re:', 'fwd:', 'meeting', 'call', 'urgent']
        if not any(keyword in subject_lower for keyword in non_page_keywords):
            return True
        
        return False
    
    def create_page_from_email(self, raw_email_msg) -> Dict[str, any]:
        """Create web page from full email message"""
        try:
            temp_file = 'temp_email_realtime.eml'
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(raw_email_msg.as_string())
            
            result = subprocess.run([
                sys.executable, 'simple_email_processor.py', temp_file
            ], capture_output=True, text=True, cwd='.')
            
            if os.path.exists(temp_file):
                os.remove(temp_file)
            
            if result.returncode == 0:
                logger.info("Successfully created page from email (REAL-TIME)")
                return {"success": True, "output": result.stdout}
            else:
                logger.error(f"Failed to create page: {result.stderr}")
                return {"success": False, "error": result.stderr}
                
        except Exception as e:
            logger.error(f"Error creating page from email: {e}")
            return {"success": False, "error": str(e)}
    
    def process_new_email_instantly(self, email_id):
        """Process a single new email instantly"""
        try:
            email_id_str = email_id.decode() if isinstance(email_id, bytes) else str(email_id)
            
            if email_id_str in self.processed_emails:
                logger.info(f"Email already processed: {email_id_str}")
                return
            
            # Fetch full email
            status, msg_data = self.mail.fetch(email_id, '(RFC822)')
            if status != 'OK':
                logger.error(f"Failed to fetch email {email_id_str}")
                return
            
            # Parse email
            msg = email.message_from_bytes(msg_data[0][1])
            email_content = self.extract_email_content(msg)
            
            # Check if from authorized sender
            if not self.is_authorized_sender(email_content['sender']):
                logger.info(f"Email from unauthorized sender: {email_content['sender']}")
                return
            
            logger.info(f"INSTANT PROCESSING: New email from {email_content['sender']}: {email_content['subject']}")
            
            # Check if this email should create a page
            if self.is_page_creation_email(email_content['subject'], email_content['body']):
                result = self.create_page_from_email(msg)
                
                if result['success']:
                    logger.info(f"INSTANT SUCCESS: Created page '{email_content['subject']}' in real-time!")
                    self.processed_emails.add(email_id_str)
                    self.save_processed_emails()
                    
                    # Mark as read
                    try:
                        self.mail.store(email_id, '+FLAGS', '\\Seen')
                    except:
                        pass
                else:
                    logger.error(f"Failed to create page instantly: {result.get('error', 'Unknown error')}")
            else:
                logger.info(f"Email not marked for page creation: {email_content['subject']}")
                self.processed_emails.add(email_id_str)
                self.save_processed_emails()
                
        except Exception as e:
            logger.error(f"Error processing email instantly: {e}")
    
    def idle_loop(self):
        """IMAP IDLE loop for real-time notifications"""
        try:
            logger.info("Starting IMAP IDLE for real-time email notifications...")
            
            while not self.stop_monitoring:
                try:
                    # Start IDLE
                    self.mail.send(b'IDLE\r\n')
                    response = self.mail.readline()
                    logger.info("IDLE mode activated - waiting for new emails...")
                    
                    # Wait for notifications or timeout (29 minutes, Gmail disconnects after 30)
                    start_time = time.time()
                    while not self.stop_monitoring and (time.time() - start_time) < 1740:  # 29 minutes
                        try:
                            # Check if there's data available to read
                            ready = select.select([self.mail.sock], [], [], 10.0)  # 10 second timeout
                            if ready[0]:
                                response = self.mail.readline()
                                if b'EXISTS' in response:
                                    logger.info("NEW EMAIL DETECTED via IDLE!")
                                    # Stop IDLE to process emails
                                    self.mail.send(b'DONE\r\n')
                                    self.mail.readline()  # Read IDLE completion
                                    
                                    # Process new emails immediately
                                    self.check_and_process_new_emails()
                                    break
                        except Exception as e:
                            if not self.stop_monitoring:
                                logger.warning(f"IDLE loop error: {e}")
                            break
                    
                    # Refresh IDLE connection (Gmail requirement)
                    if not self.stop_monitoring:
                        try:
                            self.mail.send(b'DONE\r\n')
                            self.mail.readline()
                            logger.info("Refreshing IDLE connection...")
                        except:
                            pass
                            
                except Exception as e:
                    if not self.stop_monitoring:
                        logger.error(f"Error in IDLE loop: {e}")
                        logger.info("Reconnecting in 30 seconds...")
                        time.sleep(30)
                        self.reconnect()
                        
        except Exception as e:
            logger.error(f"Fatal error in IDLE loop: {e}")
    
    def check_and_process_new_emails(self):
        """Check for and process any new emails immediately"""
        try:
            # Search for recent emails from authorized sender
            yesterday = (datetime.now() - timedelta(days=1)).strftime('%d-%b-%Y')
            search_criteria = f'(FROM "{self.authorized_sender}" SINCE {yesterday})'
            status, messages = self.mail.search(None, search_criteria)
            
            if status == 'OK' and messages[0]:
                email_ids = messages[0].split()
                logger.info(f"Found {len(email_ids)} recent emails to check")
                
                # Process only unprocessed emails
                for email_id in email_ids:
                    email_id_str = email_id.decode()
                    if email_id_str not in self.processed_emails:
                        self.process_new_email_instantly(email_id)
                        
        except Exception as e:
            logger.error(f"Error checking new emails: {e}")
    
    def reconnect(self):
        """Reconnect to email server"""
        try:
            if self.mail:
                try:
                    self.mail.close()
                    self.mail.logout()
                except:
                    pass
            
            self.mail = self.connect_to_email()
            if self.mail:
                self.mail.select('inbox')
                return True
        except Exception as e:
            logger.error(f"Reconnection failed: {e}")
        return False
    
    def start_real_time_monitoring(self):
        """Start real-time email monitoring with IMAP IDLE"""
        logger.info("Starting REAL-TIME email monitoring system")
        logger.info(f"Monitoring emails from: {self.authorized_sender}")
        logger.info("New pages will be created INSTANTLY when emails arrive!")
        
        # Initial connection
        self.mail = self.connect_to_email()
        if not self.mail:
            logger.error("Failed to connect to email server")
            return
        
        # Select inbox
        self.mail.select('inbox')
        
        # Process any existing unprocessed emails first
        logger.info("Checking for any existing unprocessed emails...")
        self.check_and_process_new_emails()
        
        # Start IDLE monitoring in a separate thread
        self.idle_thread = threading.Thread(target=self.idle_loop)
        self.idle_thread.daemon = True
        self.idle_thread.start()
        
        try:
            # Keep main thread alive
            while True:
                time.sleep(1)
                if not self.idle_thread.is_alive():
                    logger.warning("IDLE thread died, restarting...")
                    if self.reconnect():
                        self.idle_thread = threading.Thread(target=self.idle_loop)
                        self.idle_thread.daemon = True
                        self.idle_thread.start()
                    else:
                        logger.error("Could not reconnect, switching to fallback polling...")
                        self.fallback_polling()
                        break
                        
        except KeyboardInterrupt:
            logger.info("Real-time monitoring stopped by user")
            self.stop_monitoring = True
            if self.mail:
                try:
                    self.mail.send(b'DONE\r\n')
                    self.mail.close()
                    self.mail.logout()
                except:
                    pass
    
    def fallback_polling(self):
        """Fallback to fast polling if IDLE fails"""
        logger.info("Falling back to fast polling (every 30 seconds)")
        while not self.stop_monitoring:
            try:
                if not self.mail:
                    self.reconnect()
                if self.mail:
                    self.check_and_process_new_emails()
                time.sleep(30)  # Check every 30 seconds as fallback
            except KeyboardInterrupt:
                break
            except Exception as e:
                logger.error(f"Error in fallback polling: {e}")
                time.sleep(60)

def load_config() -> Dict[str, any]:
    """Load configuration from JSON file"""
    try:
        with open('email_config.json', 'r') as f:
            config = json.load(f)
        return config
    except FileNotFoundError:
        logger.error("Configuration file 'email_config.json' not found")
        sys.exit(1)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in configuration file: {e}")
        sys.exit(1)

def main():
    """Main function for real-time monitoring"""
    # Load configuration
    config = load_config()
    email_config = config['email_settings']
    
    # Create real-time monitor
    monitor = RealTimeEmailMonitor(email_config)
    
    # Start real-time monitoring
    monitor.start_real_time_monitoring()

if __name__ == "__main__":
    main() 