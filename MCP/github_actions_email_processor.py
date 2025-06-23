#!/usr/bin/env python3
"""
GitHub Actions Email Processor for Portfolio Website
Cloud-based email monitoring and page generation
"""

import imaplib
import email
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
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class GitHubActionsEmailProcessor:
    def __init__(self):
        """Initialize with environment variables"""
        self.server = "imap.gmail.com"
        self.port = 993
        self.username = os.getenv('GMAIL_USERNAME', 'email.to.portfolio.site@gmail.com')
        self.password = os.getenv('GMAIL_PASSWORD')
        self.authorized_sender = os.getenv('AUTHORIZED_SENDER', 'cyohn55@yahoo.com')
        
        if not self.password:
            raise ValueError("GMAIL_PASSWORD environment variable is required")
            
        self.processed_emails_file = 'processed_emails_cloud.json'
        self.processed_emails = self.load_processed_emails()
        
    def load_processed_emails(self) -> set:
        """Load list of already processed email IDs"""
        try:
            if os.path.exists(self.processed_emails_file):
                with open(self.processed_emails_file, 'r') as f:
                    return set(json.load(f))
        except Exception as e:
            logger.warning(f"Could not load processed emails: {e}")
        return set()
    
    def save_processed_emails(self):
        """Save list of processed email IDs"""
        try:
            with open(self.processed_emails_file, 'w') as f:
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
    
    def create_page_from_email(self, raw_email_msg) -> Dict[str, any]:
        """Create web page from full email message using enhanced processor"""
        try:
            # Save full email message to temporary file
            temp_file = 'temp_email.eml'
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(raw_email_msg.as_string())
            
            # Call enhanced email processor
            result = subprocess.run([
                sys.executable, 'enhanced_email_processor.py', temp_file
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
    
    def group_emails_by_title(self, emails: List[tuple]) -> Dict[str, tuple]:
        """Group emails by title and return the most recent email for each title"""
        title_groups = {}
        
        for email_id, raw_msg, email_data in emails:
            title = email_data['subject'].strip()
            email_date = datetime.strptime(email_data['date'], '%a, %d %b %Y %H:%M:%S %z') if email_data['date'] else datetime.now()
            
            # If this title doesn't exist or this email is newer, use this email
            if title not in title_groups or email_date > title_groups[title][3]:
                title_groups[title] = (email_id, raw_msg, email_data, email_date)
        
        # Return without the date (just the first 3 elements)
        return {title: data[:3] for title, data in title_groups.items()}
    
    def process_new_emails(self):
        """Check for and process new emails"""
        mail = self.connect_to_email()
        if not mail:
            return
        
        try:
            # Select inbox
            mail.select('inbox')
            
            # Search for emails from authorized sender (last 7 days)
            since_date = (datetime.now() - timedelta(days=7)).strftime('%d-%b-%Y')
            search_criteria = f'(FROM "{self.authorized_sender}" SINCE {since_date})'
            
            status, messages = mail.search(None, search_criteria)
            
            if status != 'OK':
                logger.error("Could not search emails")
                return
            
            email_ids = messages[0].split()
            
            if not email_ids:
                logger.info("No emails found from authorized sender")
                return
            
            logger.info(f"Found {len(email_ids)} emails from authorized sender")
            
            # Collect all new emails
            new_emails = []
            
            for email_id in email_ids:
                email_id_str = email_id.decode()
                
                if email_id_str in self.processed_emails:
                    continue
                
                # Fetch email
                status, msg_data = mail.fetch(email_id, '(RFC822)')
                
                if status != 'OK':
                    continue
                
                # Parse email
                raw_msg = email.message_from_bytes(msg_data[0][1])
                
                # Extract email content
                subject = self.decode_email_header(raw_msg['Subject'] or 'No Subject')
                sender = self.decode_email_header(raw_msg['From'] or '')
                date = raw_msg['Date']
                
                email_data = {
                    'subject': subject,
                    'sender': sender,
                    'date': date
                }
                
                # Check if it's a page creation email
                body = ""
                if raw_msg.is_multipart():
                    for part in raw_msg.walk():
                        if part.get_content_type() == "text/plain":
                            try:
                                body = part.get_payload(decode=True).decode('utf-8')
                                break
                            except:
                                continue
                else:
                    try:
                        body = raw_msg.get_payload(decode=True).decode('utf-8')
                    except:
                        body = str(raw_msg.get_payload())
                
                if self.is_page_creation_email(subject, body):
                    new_emails.append((email_id_str, raw_msg, email_data))
                    logger.info(f"Found page creation email: {subject}")
                else:
                    # Mark as processed even if not a page creation email
                    self.processed_emails.add(email_id_str)
            
            if not new_emails:
                logger.info("No new page creation emails found")
                return
            
            # Group emails by title and process most recent per title
            title_groups = self.group_emails_by_title(new_emails)
            
            logger.info(f"Processing {len(title_groups)} unique titles from {len(new_emails)} emails")
            
            processed_count = 0
            for title, (email_id_str, raw_msg, email_data) in title_groups.items():
                logger.info(f"Processing email: {title}")
                
                result = self.create_page_from_email(raw_msg)
                
                if result['success']:
                    logger.info(f"Successfully processed: {title}")
                    processed_count += 1
                else:
                    logger.error(f"Failed to process {title}: {result.get('error', 'Unknown error')}")
                
                # Mark as processed
                self.processed_emails.add(email_id_str)
            
            # Save processed emails list
            self.save_processed_emails()
            
            if processed_count > 0:
                logger.info(f"Successfully processed {processed_count} emails")
            else:
                logger.info("No emails were successfully processed")
            
        except Exception as e:
            logger.error(f"Error processing emails: {e}")
        
        finally:
            mail.close()
            mail.logout()

def main():
    """Main function for GitHub Actions"""
    try:
        processor = GitHubActionsEmailProcessor()
        processor.process_new_emails()
        logger.info("Email processing completed")
    except Exception as e:
        logger.error(f"Error in main: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 