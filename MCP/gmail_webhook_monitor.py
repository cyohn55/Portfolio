#!/usr/bin/env python3
"""
Gmail API Push Notification Monitor
Uses Gmail API + Google Cloud Pub/Sub for instant email notifications
Requires Google Cloud setup but provides the most reliable instant notifications
"""

import os
import json
import logging
import base64
from flask import Flask, request, jsonify
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
import subprocess
import sys
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('gmail_webhook.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Gmail API scopes
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

class GmailWebhookMonitor:
    def __init__(self):
        self.service = None
        self.authorized_sender = "cyohn55@yahoo.com"  # Configure this
        self.processed_emails = self.load_processed_emails()
        
    def load_processed_emails(self) -> set:
        """Load processed email IDs"""
        try:
            if os.path.exists('processed_emails.json'):
                with open('processed_emails.json', 'r') as f:
                    return set(json.load(f))
        except:
            pass
        return set()
    
    def save_processed_emails(self):
        """Save processed email IDs"""
        try:
            with open('processed_emails.json', 'w') as f:
                json.dump(list(self.processed_emails), f)
        except Exception as e:
            logger.error(f"Could not save processed emails: {e}")
    
    def authenticate_gmail(self):
        """Authenticate with Gmail API"""
        creds = None
        # Token file stores the user's access and refresh tokens
        if os.path.exists('token.json'):
            creds = Credentials.from_authorized_user_file('token.json', SCOPES)
        
        # If there are no valid credentials, request authorization
        if not creds or not creds.valid:
            if creds and creds.expired and creds.refresh_token:
                creds.refresh(Request())
            else:
                flow = InstalledAppFlow.from_client_secrets_file(
                    'credentials.json', SCOPES)
                creds = flow.run_local_server(port=0)
            
            # Save credentials for next run
            with open('token.json', 'w') as token:
                token.write(creds.to_json())
        
        self.service = build('gmail', 'v1', credentials=creds)
        logger.info("Successfully authenticated with Gmail API")
    
    def setup_push_notifications(self, webhook_url: str):
        """Set up Gmail push notifications via Pub/Sub"""
        try:
            # This requires Google Cloud Pub/Sub setup
            request_body = {
                'labelIds': ['INBOX'],
                'topicName': 'projects/YOUR_PROJECT_ID/topics/gmail-notifications'
            }
            
            result = self.service.users().watch(
                userId='me',
                body=request_body
            ).execute()
            
            logger.info(f"Push notifications set up: {result}")
            return result
            
        except Exception as e:
            logger.error(f"Failed to set up push notifications: {e}")
            logger.info("Falling back to polling mode...")
            return None
    
    def process_email_instantly(self, message_id: str):
        """Process a single email instantly"""
        try:
            if message_id in self.processed_emails:
                return
            
            # Get email details
            message = self.service.users().messages().get(
                userId='me', 
                id=message_id,
                format='full'
            ).execute()
            
            # Extract email information
            payload = message['payload']
            headers = payload.get('headers', [])
            
            subject = next((h['value'] for h in headers if h['name'] == 'Subject'), 'No Subject')
            sender = next((h['value'] for h in headers if h['name'] == 'From'), '')
            
            # Check if from authorized sender
            if self.authorized_sender.lower() not in sender.lower():
                logger.info(f"Email from unauthorized sender: {sender}")
                return
            
            logger.info(f"⚡ INSTANT WEBHOOK PROCESSING: {subject} from {sender}")
            
            # Get email body
            body = self.extract_email_body(payload)
            
            # Check if should create page
            if self.should_create_page(subject, body):
                # Create temporary email file for processing
                email_content = f"Subject: {subject}\n\n{body}"
                temp_file = 'temp_webhook_email.txt'
                
                with open(temp_file, 'w', encoding='utf-8') as f:
                    f.write(email_content)
                
                # Process with existing email processor
                result = subprocess.run([
                    sys.executable, 'simple_email_processor.py', temp_file
                ], capture_output=True, text=True)
                
                if os.path.exists(temp_file):
                    os.remove(temp_file)
                
                if result.returncode == 0:
                    logger.info(f"🚀 WEBHOOK SUCCESS: Created page '{subject}' instantly!")
                    self.processed_emails.add(message_id)
                    self.save_processed_emails()
                else:
                    logger.error(f"Failed to create page: {result.stderr}")
            
        except Exception as e:
            logger.error(f"Error processing email via webhook: {e}")
    
    def extract_email_body(self, payload):
        """Extract email body from Gmail API payload"""
        def get_body_from_part(part):
            if part.get('body') and part['body'].get('data'):
                return base64.urlsafe_b64decode(part['body']['data']).decode('utf-8')
            elif part.get('parts'):
                for subpart in part['parts']:
                    if subpart.get('mimeType') == 'text/plain':
                        if subpart.get('body') and subpart['body'].get('data'):
                            return base64.urlsafe_b64decode(subpart['body']['data']).decode('utf-8')
            return ""
        
        return get_body_from_part(payload)
    
    def should_create_page(self, subject: str, body: str) -> bool:
        """Check if email should create a page"""
        # Same logic as other monitors
        page_keywords = ['create page', 'new page', 'portfolio page', 'add page', 'website update']
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

# Flask app for webhook endpoint
app = Flask(__name__)
monitor = GmailWebhookMonitor()

@app.route('/gmail-webhook', methods=['POST'])
def gmail_webhook():
    """Handle Gmail push notifications"""
    try:
        # Verify the request (you should implement proper verification)
        data = request.get_json()
        
        if data and 'message' in data:
            # Decode the Pub/Sub message
            message_data = base64.b64decode(data['message']['data']).decode('utf-8')
            notification = json.loads(message_data)
            
            logger.info(f"📧 Webhook notification received: {notification}")
            
            # Get the message ID and process it
            if 'historyId' in notification:
                # Process new messages since this history ID
                monitor.process_new_messages_since_history(notification['historyId'])
        
        return jsonify({'status': 'success'}), 200
        
    except Exception as e:
        logger.error(f"Webhook error: {e}")
        return jsonify({'error': str(e)}), 500

def setup_instructions():
    """Print setup instructions for Gmail API + Pub/Sub"""
    print("""
🚀 Gmail API Push Notification Setup Instructions

1. GOOGLE CLOUD SETUP:
   - Create a Google Cloud Project
   - Enable Gmail API
   - Enable Pub/Sub API
   - Create a Pub/Sub topic (e.g., 'gmail-notifications')

2. CREDENTIALS:
   - Create OAuth 2.0 credentials
   - Download as 'credentials.json'
   - Place in MCP directory

3. WEBHOOK ENDPOINT:
   - Deploy this Flask app to a public server (Heroku, Railway, etc.)
   - Or use ngrok for local testing: ngrok http 5000
   - Update webhook URL in setup_push_notifications()

4. RUN:
   python gmail_webhook_monitor.py

🔗 Full tutorial: https://developers.google.com/gmail/api/guides/push
    """)

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == 'setup':
        setup_instructions()
    else:
        # Initialize Gmail API
        monitor.authenticate_gmail()
        
        # Start Flask webhook server
        logger.info("🚀 Starting Gmail webhook server for INSTANT notifications")
        logger.info("📧 Webhook endpoint: /gmail-webhook")
        app.run(host='0.0.0.0', port=5000, debug=False) 