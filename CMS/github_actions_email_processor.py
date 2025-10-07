#!/usr/bin/env python3
"""
GitHub Actions Email Processor for Portfolio Website
Cloud-based email monitoring and page generation
Optimized for GitHub Actions cloud execution
"""

import imaplib
import email
import email.utils
import os
import sys
import json
import logging
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple, Any
from email.header import decode_header
import subprocess
import re

# Configure logging for GitHub Actions
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class GitHubActionsEmailProcessor:
    def __init__(self):
        """Initialize with environment variables for GitHub Actions"""
        self.server = "imap.gmail.com"
        self.port = 993
        self.username = os.getenv('GMAIL_USERNAME', 'email.to.portfolio.site@gmail.com')
        self.password = os.getenv('GMAIL_PASSWORD')
        self.authorized_sender = os.getenv('AUTHORIZED_SENDER', 'cyohn55@yahoo.com')
        
        if not self.password:
            raise ValueError("GMAIL_PASSWORD environment variable is required")
            
        script_dir = os.path.dirname(os.path.abspath(__file__))
        self.processed_emails_file = os.path.join(script_dir, 'processed_emails_cloud.json')
        self.processed_emails = self.load_processed_emails()
        
    def load_processed_emails(self) -> set:
        """Load list of already processed email IDs"""
        try:
            if os.path.exists(self.processed_emails_file):
                with open(self.processed_emails_file, 'r') as f:
                    data = json.load(f)
                    return set(data) if isinstance(data, list) else set()
        except Exception as e:
            logger.warning(f"Could not load processed emails: {e}")
        return set()
    
    def save_processed_emails(self):
        """Save list of processed email IDs"""
        try:
            logger.info(f"Attempting to save {len(self.processed_emails)} email IDs to: '{self.processed_emails_file}'")
            
            # Ensure directory exists
            os.makedirs(os.path.dirname(self.processed_emails_file), exist_ok=True)
            with open(self.processed_emails_file, 'w') as f:
                json.dump(list(self.processed_emails), f)
            logger.info(f"Saved {len(self.processed_emails)} processed email IDs")
        except Exception as e:
            logger.error(f"Could not save processed emails: {e}")
    
    def connect_to_email(self) -> Optional[imaplib.IMAP4_SSL]:
        """Connect to email server with retry logic"""
        if not self.password:
            logger.error("Gmail password not provided")
            return None
            
        for attempt in range(3):  # 3 retry attempts
            try:
                mail = imaplib.IMAP4_SSL(self.server, self.port)
                mail.login(self.username, self.password)
                logger.info("Successfully connected to email server")
                return mail
            except Exception as e:
                logger.warning(f"Connection attempt {attempt + 1} failed: {e}")
                if attempt == 2:  # Last attempt
                    logger.error(f"Failed to connect to email server after 3 attempts: {e}")
                    return None
        return None
    
    def decode_email_header(self, header: str) -> str:
        """Decode email header safely"""
        if not header:
            return ""
        try:
            decoded = decode_header(header)[0]
            if isinstance(decoded[0], bytes):
                return decoded[0].decode(decoded[1] or 'utf-8')
            return str(decoded[0])
        except Exception as e:
            logger.warning(f"Could not decode header: {e}")
            return str(header)
    
    def is_authorized_sender(self, sender: str) -> bool:
        """Check if sender is authorized to create pages"""
        if not sender or not self.authorized_sender:
            return False
        return self.authorized_sender.lower() in sender.lower()
    
    def is_page_creation_email(self, subject: str, body: str) -> bool:
        """Determine if email should create a page"""
        if not subject:
            return False
            
        subject_lower = subject.lower().strip()
        body_lower = body.lower() if body else ""
        
        # Skip common non-page email patterns
        skip_patterns = [
            'unsubscribe', 'delivery failure', 'out of office', 
            'automatic reply', 'bounce', 'mailer-daemon',
            'no-reply', 'noreply'
        ]
        
        if any(pattern in subject_lower for pattern in skip_patterns):
            return False
        
        # Skip reply and forward patterns
        if subject_lower.startswith(('re:', 'fwd:', 'fw:')):
            return False
        
        # Check for markdown content (strong indicator)
        if '#' in body and any(line.strip().startswith('#') for line in body.split('\n')):
            return True
        
        # Check for page creation keywords
        page_keywords = [
            'create page', 'new page', 'portfolio page', 'add page', 
            'website update', 'blog post', 'project update'
        ]
        
        if any(keyword in subject_lower or keyword in body_lower for keyword in page_keywords):
            return True
        
        # For authorized senders, assume most emails are page creation unless clearly not
        # This is more permissive for the portfolio use case
        return len(subject.strip()) > 3  # Must have meaningful subject
    
    def is_delete_command(self, subject: str, body: str) -> Optional[str]:
        """
        ENHANCED SAFE Delete Command Detection for GitHub Actions
        
        Requirements for deletion to prevent accidents:
        1. Must be EXACTLY in subject line (not body) - reduces false positives
        2. Must start with [DELETE] (case insensitive) - stronger pattern  
        3. Must include "CONFIRM" keyword - explicit confirmation required
        4. Subject must match pattern: [DELETE CONFIRM] <page_identifier>
        """
        if not subject or not subject.strip():
            return None
            
        subject_clean = subject.strip()
        
        # STRICT PATTERN: Must be exact format with CONFIRM keyword
        # Pattern: [DELETE CONFIRM] page_identifier
        delete_pattern = re.compile(r'^\[DELETE\s+CONFIRM\]\s*(.+)$', re.IGNORECASE)
        
        match = delete_pattern.match(subject_clean)
        if match:
            page_identifier = match.group(1).strip()
            if page_identifier:  # Ensure we have something to delete
                logger.info(f"🚨 SAFE DELETE COMMAND CONFIRMED: '{page_identifier}'")
                logger.info(f"📧 Subject: {subject}")
                return page_identifier
        
        # Log potential unsafe delete attempts for monitoring
        unsafe_patterns = [
            r'\[del\]', r'del:', r'delete:', r'\[delete\]', 
            r'remove:', r'\[remove\]', r'rm '
        ]
        
        subject_lower = subject.lower()
        for pattern in unsafe_patterns:
            if re.search(pattern, subject_lower):
                logger.warning(f"⚠️  UNSAFE DELETE PATTERN DETECTED (IGNORED): '{subject}'")
                logger.warning("ℹ️  To delete pages, use format: [DELETE CONFIRM] page_name")
                break
        
        return None
    
    def create_page_from_email(self, raw_email_msg) -> Dict[str, Any]:
        """Create web page from email using enhanced processor"""
        try:
            # Save email to temporary file
            temp_file = 'temp_email.eml'
            with open(temp_file, 'w', encoding='utf-8') as f:
                f.write(raw_email_msg.as_string())
            
            # Call enhanced email processor - ensure we're in the CMS directory
            # This is critical for relative path resolution (../index.html, ../Pages/, etc.)
            result = subprocess.run([
                sys.executable, 'enhanced_email_processor.py', temp_file
            ], capture_output=True, text=True, cwd=os.path.dirname(os.path.abspath(__file__)))
            
            # Clean up temp file
            if os.path.exists(temp_file):
                os.remove(temp_file)
            
            if result.returncode == 0:
                logger.info("Successfully created page from email")
                logger.info(f"Subprocess output:\n{result.stdout}")
                return {"success": True, "output": result.stdout}
            else:
                error_output = f"Return Code: {result.returncode}\n"
                error_output += f"--- STDOUT ---\n{result.stdout}\n"
                error_output += f"--- STDERR ---\n{result.stderr}\n"
                logger.error(f"Failed to create page. Full output:\n{error_output}")
                return {"success": False, "error": error_output}
                
        except Exception as e:
            logger.error(f"Error creating page from email: {e}")
            return {"success": False, "error": str(e)}
    
    def extract_email_data(self, raw_msg) -> Dict[str, str]:
        """Extract key data from email message"""
        subject = self.decode_email_header(raw_msg.get('Subject', ''))
        sender = self.decode_email_header(raw_msg.get('From', ''))
        date = raw_msg.get('Date', '')
        
        # Extract body text
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
        
        return {
            'subject': subject,
            'sender': sender,
            'date': date,
            'body': body
        }
    
    def group_emails_by_title(self, emails: List[Tuple[str, Any, Dict]]) -> Dict[str, Tuple[str, Any, Dict]]:
        """Group emails by title and return most recent for each title"""
        title_groups = {}
        
        for email_id, raw_msg, email_data in emails:
            title = email_data['subject'].strip()
            
            # Parse email date
            try:
                email_date = email.utils.parsedate_to_datetime(email_data['date'])
            except:
                email_date = datetime.now()
            
            # Keep the most recent email for each title
            if title not in title_groups or email_date > title_groups[title][3]:
                title_groups[title] = (email_id, raw_msg, email_data, email_date)
        
        # Return without the date
        return {title: data[:3] for title, data in title_groups.items()}
    
    def process_new_emails(self):
        """Main email processing function for GitHub Actions"""
        logger.info("Starting email processing for GitHub Actions")
        
        mail = self.connect_to_email()
        if not mail:
            logger.error("Could not connect to email server")
            return
        
        new_emails = []
        
        try:
            # Check both inbox and spam folders
            folders_to_check = ['inbox', '[Gmail]/Spam']
            
            for folder in folders_to_check:
                try:
                    # Select folder
                    status, messages = mail.select(folder)
                    
                    if status != 'OK':
                        logger.warning(f"Could not select folder: {folder}, skipping")
                        continue
                    
                    logger.info(f"Checking folder: {folder}")
                    
                    # Search for recent emails from authorized sender
                    since_date = (datetime.now() - timedelta(hours=24)).strftime('%d-%b-%Y')
                    search_criteria = f'(FROM "{self.authorized_sender}" SINCE {since_date})'
                    
                    status, messages = mail.search(None, search_criteria)
                    
                    if status != 'OK':
                        logger.error(f"Could not search emails in {folder}")
                        continue
                    
                    email_ids = messages[0].split()
                    
                    if not email_ids:
                        logger.info(f"No recent emails found from authorized sender in {folder}")
                        continue
                    
                    logger.info(f"Found {len(email_ids)} recent emails from {self.authorized_sender} in {folder}")
                    
                    # Process emails in this folder
                    for email_id in email_ids:
                        email_id_str = f"{folder}:{email_id.decode()}"  # Add folder prefix to differentiate IDs
                        
                        # Skip already processed emails
                        if email_id_str in self.processed_emails:
                            continue
                        
                        # Fetch email
                        try:
                            status, msg_data = mail.fetch(email_id, '(RFC822)')
                            if status != 'OK' or not msg_data or not msg_data[0]:
                                continue
                            
                            # Ensure we have the email data in the right format
                            email_data_bytes = msg_data[0][1]
                            if isinstance(email_data_bytes, bytes):
                                raw_msg = email.message_from_bytes(email_data_bytes)
                            else:
                                logger.warning(f"Unexpected email data type: {type(email_data_bytes)}")
                                continue
                            email_data = self.extract_email_data(raw_msg)
                            
                            # Check if authorized
                            if not self.is_authorized_sender(email_data['sender']):
                                logger.info(f"Skipping email from unauthorized sender: {email_data['sender']}")
                                self.processed_emails.add(email_id_str)
                                continue
                            
                            # Check for delete commands first
                            delete_target = self.is_delete_command(email_data['subject'], email_data['body'])
                            if delete_target:
                                logger.info(f"Delete command detected for: {delete_target}")
                                # TODO: Implement delete functionality in enhanced_email_processor
                                self.processed_emails.add(email_id_str)
                                continue
                            
                            # Check if it's a page creation email
                            if self.is_page_creation_email(email_data['subject'], email_data['body']):
                                new_emails.append((email_id_str, raw_msg, email_data))
                                logger.info(f"Found page creation email: {email_data['subject']} in {folder}")
                                
                                # If this is in spam folder, mark it as not spam
                                if folder.lower().endswith('spam'):
                                    try:
                                        logger.info(f"Moving email from spam to inbox: {email_data['subject']}")
                                        mail.copy(email_id, 'inbox')  # Copy to inbox
                                    except Exception as e:
                                        logger.warning(f"Failed to move email from spam: {e}")
                            else:
                                logger.info(f"Skipping non-page email: {email_data['subject']}")
                                self.processed_emails.add(email_id_str)
                                
                        except Exception as e:
                            logger.error(f"Error processing email {email_id_str}: {e}")
                            continue
                except Exception as e:
                    logger.error(f"Error checking folder {folder}: {e}")
            
            processed_count = 0
            
            if not new_emails:
                logger.info("No new page creation emails to process")
                self.save_processed_emails()
                return
            
            # Group by title and process most recent per title
            title_groups = self.group_emails_by_title(new_emails)
            logger.info(f"Processing {len(title_groups)} unique titles from {len(new_emails)} emails")
            
            for title, (email_id_str, raw_msg, email_data) in title_groups.items():
                logger.info(f"Processing: {title}")
                
                result = self.create_page_from_email(raw_msg)
                
                if result['success']:
                    logger.info(f"✅ Successfully created/updated page: {title}")
                    processed_count += 1
                    
                    # Mark this email as processed
                    self.processed_emails.add(email_id_str)
                    
                    # Mark all older emails with same title as processed
                    for other_email_id, _, other_data in new_emails:
                        if other_data['subject'].strip() == title and other_email_id != email_id_str:
                            self.processed_emails.add(other_email_id)
                            logger.info(f"Marked older email with same title as processed: {other_email_id}")
                            
                else:
                    logger.error(f"❌ Failed to create page for '{title}': {result.get('error', 'Unknown error')}")
            
            logger.info(f"Processing complete. Processed {processed_count} emails")
            self.save_processed_emails()
            
        except Exception as e:
            logger.error(f"Error in email processing: {e}")
        finally:
            try:
                mail.close()
                mail.logout()
            except:
                pass

def main():
    """Main function for GitHub Actions"""
    try:
        logger.info("GitHub Actions Email Processor starting...")
        processor = GitHubActionsEmailProcessor()
        processor.process_new_emails()
        logger.info("GitHub Actions Email Processor completed successfully")
    except Exception as e:
        logger.error(f"Fatal error in main: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 
