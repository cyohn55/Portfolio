#!/usr/bin/env python3
"""
Email Monitor for Portfolio Web Page Generation
Monitors email inbox and automatically creates web pages from emails sent by cyohn55@yahoo.com
"""

import imaplib
import email
import time
import os
import sys
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional
from email.header import decode_header
import subprocess

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('email_monitor.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class EmailMonitor:
    def __init__(self, email_config: Dict[str, str]):
        """
        Initialize email monitor
        
        Args:
            email_config: Dictionary with email configuration
                - server: IMAP server (e.g., 'imap.gmail.com')
                - port: IMAP port (usually 993 for SSL)
                - username: Your email username
                - password: Your email password or app password
                - authorized_sender: Email address authorized to create pages
        """
        self.server = email_config['server']
        self.port = email_config['port']
        self.username = email_config['username']
        self.password = email_config['password']
        self.authorized_sender = email_config['authorized_sender']
        self.processed_emails = self.load_processed_emails()
        
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
            logger.info("Successfully connected to email server")
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
        # Check for specific keywords or patterns
        page_keywords = [
            'create page',
            'new page',
            'portfolio page',
            'add page',
            'website update'
        ]
        
        subject_lower = subject.lower()
        body_lower = body.lower()
        
        # Check if subject or body contains page creation keywords
        for keyword in page_keywords:
            if keyword in subject_lower or keyword in body_lower:
                return True
        
        # Check if email has markdown-style content (headers with #)
        if '#' in body and any(line.strip().startswith('#') for line in body.split('\n')):
            return True
        
        # If subject doesn't contain common non-page words, assume it's a page
        non_page_keywords = ['re:', 'fwd:', 'meeting', 'call', 'urgent']
        if not any(keyword in subject_lower for keyword in non_page_keywords):
            return True
        
        return False
    
    def format_email_for_processing(self, email_data: Dict[str, str]) -> str:
        """Format email data for page processing"""
        formatted = f"Subject: {email_data['subject']}\n\n"
        formatted += email_data['body']
        return formatted
    
    def create_page_from_email(self, raw_email_msg) -> Dict[str, any]:
        """Create web page from full email message (preserves attachments)"""
        try:
            # Save full email message to temporary file
            temp_file = 'temp_email.eml'
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(raw_email_msg.as_string())
            
            # Call simplified email processor
            result = subprocess.run([
                sys.executable, 'simple_email_processor.py', temp_file
            ], capture_output=True, text=True, cwd='.')
            
            # Clean up temp file
            if os.path.exists(temp_file):
                os.remove(temp_file)
            
            if result.returncode == 0:
                logger.info("Successfully created page from email")
                return {"success": True, "output": result.stdout}
            else:
                logger.error(f"Failed to create page: {result.stderr}")
                return {"success": False, "error": result.stderr}
                
        except Exception as e:
            logger.error(f"Error creating page from email: {e}")
            return {"success": False, "error": str(e)}
    
    def process_new_emails(self):
        """Check for and process new emails - group by title and process most recent per title"""
        mail = self.connect_to_email()
        if not mail:
            return
        
        try:
            # Select inbox
            mail.select('inbox')
            
            # Search for emails from authorized sender (last 24 hours, read or unread)
            # This handles cases where emails are auto-marked as read
            yesterday = (datetime.now() - timedelta(days=1)).strftime('%d-%b-%Y')
            search_criteria = f'(FROM "{self.authorized_sender}" SINCE {yesterday})'
            status, messages = mail.search(None, search_criteria)
            
            if status != 'OK':
                logger.warning("Failed to search emails")
                return
            
            email_ids = messages[0].split()
            logger.info(f"Found {len(email_ids)} recent emails from {self.authorized_sender}")
            
            if not email_ids:
                return
            
            # Get email details (date, ID, and subject) for grouping by title
            email_details = []
            for email_id in email_ids:
                email_id_str = email_id.decode()
                    
                # Fetch email header for date and subject
                status, msg_data = mail.fetch(email_id, '(INTERNALDATE RFC822.HEADER)')
                if status != 'OK':
                    continue
                
                # Parse email for date and subject
                msg = email.message_from_bytes(msg_data[0][1])
                date_header = msg.get('Date', '')
                subject = msg.get('Subject', 'No Subject')
                
                try:
                    # Parse email date
                    email_date = email.utils.parsedate_to_datetime(date_header)
                    email_details.append({
                        'id': email_id,
                        'id_str': email_id_str,
                        'date': email_date,
                        'subject': subject,
                        'msg': msg
                    })
                except Exception as e:
                    logger.warning(f"Could not parse date for email {email_id_str}: {e}")
                    # Use current time as fallback
                    email_details.append({
                        'id': email_id,
                        'id_str': email_id_str,
                        'date': datetime.now(),
                        'subject': subject,
                        'msg': msg
                    })
            
            if not email_details:
                logger.info("No emails found to process")
                return
            
            # Group emails by subject/title and find the most recent for each title
            title_groups = {}
            for email_detail in email_details:
                subject = email_detail['subject']
                if subject not in title_groups:
                    title_groups[subject] = []
                title_groups[subject].append(email_detail)
            
            # Process the most recent email for each unique title
            processed_any = False
            for subject, email_list in title_groups.items():
                # Sort by date (newest first) for this title
                email_list.sort(key=lambda x: x['date'], reverse=True)
                latest_email_for_title = email_list[0]
                
                # Check if we've already processed this exact email
                if latest_email_for_title['id_str'] in self.processed_emails:
                    logger.info(f"Email already processed: {subject}")
                    continue
                
                logger.info(f"Processing most recent email for title '{subject}': ID {latest_email_for_title['id_str']} from {latest_email_for_title['date']}")
                
                # Fetch full email content
                status, msg_data = mail.fetch(latest_email_for_title['id'], '(RFC822)')
                if status != 'OK':
                    logger.error(f"Failed to fetch email {latest_email_for_title['id_str']}")
                    continue
                
                # Parse email
                msg = email.message_from_bytes(msg_data[0][1])
                email_content = self.extract_email_content(msg)
                
                # Check if this email should create a page
                if self.is_page_creation_email(email_content['subject'], email_content['body']):
                    # Process full email message (preserves attachments)
                    result = self.create_page_from_email(msg)
                    
                    if result['success']:
                        logger.info(f"Successfully created/updated page: {email_content['subject']}")
                        processed_any = True
                        
                        # Mark this email as processed
                        self.processed_emails.add(latest_email_for_title['id_str'])
                        
                        # Mark ALL older emails with the same title as processed (to prevent reprocessing)
                        for older_email in email_list[1:]:  # Skip the first (most recent) one
                            self.processed_emails.add(older_email['id_str'])
                            logger.info(f"Marked older email with same title as processed: ID {older_email['id_str']}")
                        
                        # Optionally mark email as read
                        try:
                            mail.store(latest_email_for_title['id'], '+FLAGS', '\\Seen')
                        except:
                            pass  # Email might already be marked as read
                    else:
                        logger.error(f"Failed to create page: {result.get('error', 'Unknown error')}")
                else:
                    logger.info(f"Email not marked for page creation: {email_content['subject']}")
                    # Mark as processed but don't create page
                    self.processed_emails.add(latest_email_for_title['id_str'])
            
            if not processed_any:
                logger.info("No new emails to process (all titles already processed)")
            
            # Save processed emails list
            self.save_processed_emails()
            
        except Exception as e:
            logger.error(f"Error processing emails: {e}")
        finally:
            mail.close()
            mail.logout()
    
    def run_continuous_monitoring(self, check_interval: int = 300):
        """Run continuous email monitoring"""
        logger.info(f"Starting continuous email monitoring for {self.authorized_sender}")
        logger.info(f"Checking every {check_interval} seconds")
        
        while True:
            try:
                self.process_new_emails()
                logger.info(f"Sleeping for {check_interval} seconds...")
                time.sleep(check_interval)
            except KeyboardInterrupt:
                logger.info("Monitoring stopped by user")
                break
            except Exception as e:
                logger.error(f"Error in monitoring loop: {e}")
                time.sleep(60)  # Wait a minute before retrying

def load_config() -> Dict[str, any]:
    """Load configuration from JSON file"""
    try:
        with open('email_config.json', 'r') as f:
            config = json.load(f)
        return config
    except FileNotFoundError:
        logger.error("Configuration file 'email_config.json' not found")
        logger.info("Please create email_config.json with your email settings")
        sys.exit(1)
    except json.JSONDecodeError as e:
        logger.error(f"Invalid JSON in configuration file: {e}")
        sys.exit(1)

def main():
    """Main function"""
    if len(sys.argv) > 1 and sys.argv[1] == 'config':
        print("📧 Email Automation Configuration")
        print("=" * 40)
        print("1. Edit 'email_config.json' file")
        print("2. Set your receiving email username")
        print("3. Set your app-specific password")
        print("4. Update IMAP server if needed")
        print("\nExample configuration:")
        print(json.dumps({
            "email_settings": {
                "server": "imap.gmail.com",
                "port": 993,
                "username": "your_email@gmail.com",
                "password": "your_app_password",
                "authorized_sender": "cyohn55@yahoo.com"
            }
        }, indent=2))
        return
    
    # Load configuration
    config = load_config()
    email_config = config['email_settings']
    
    # Create monitor instance
    monitor = EmailMonitor(email_config)
    
    if len(sys.argv) > 1 and sys.argv[1] == 'test':
        # Test mode - check once
        logger.info("Running in test mode - checking emails once")
        monitor.process_new_emails()
    else:
        # Continuous monitoring mode
        monitor.run_continuous_monitoring(check_interval=300)  # Check every 5 minutes

if __name__ == "__main__":
    main() 