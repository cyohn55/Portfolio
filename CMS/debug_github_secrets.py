#!/usr/bin/env python3
"""
GitHub Secrets Diagnostic Tool
Tests if GitHub Secrets are properly configured and accessible
"""

import os
import sys
import imaplib
import logging
import json
from datetime import datetime

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def test_github_secrets():
    """Test if GitHub Secrets are properly configured"""
    print("🔍 GITHUB SECRETS DIAGNOSTIC TEST")
    print("=" * 50)
    print(f"⏰ Test Time: {datetime.now().isoformat()}")
    print()
    
    # Check environment variables
    secrets = {
        'GMAIL_USERNAME': os.getenv('GMAIL_USERNAME'),
        'GMAIL_PASSWORD': os.getenv('GMAIL_PASSWORD'),
        'AUTHORIZED_SENDER': os.getenv('AUTHORIZED_SENDER')
    }
    
    print("📋 ENVIRONMENT VARIABLES CHECK:")
    print("-" * 30)
    
    all_configured = True
    for name, value in secrets.items():
        if value:
            # Don't print the actual values for security
            masked_value = value[:4] + "***" if len(value) > 4 else "***"
            print(f"✅ {name}: {masked_value}")
        else:
            print(f"❌ {name}: NOT SET")
            all_configured = False
    
    print()
    
    if not all_configured:
        print("❌ RESULT: GitHub Secrets NOT properly configured")
        print()
        print("🎯 SOLUTION REQUIRED:")
        print("1. Go to: https://github.com/cyohn55/Portfolio/settings/secrets/actions")
        print("2. Verify all 3 secrets are added with correct names:")
        print("   - GMAIL_USERNAME")
        print("   - GMAIL_PASSWORD") 
        print("   - AUTHORIZED_SENDER")
        print("3. Check for typos in secret names (case-sensitive)")
        print("4. Re-run this test after fixing")
        return False
    
    print("✅ RESULT: All GitHub Secrets are configured")
    print()
    
    # Test Gmail connection
    print("📧 GMAIL CONNECTION TEST:")
    print("-" * 30)
    
    try:
        username = secrets['GMAIL_USERNAME']
        password = secrets['GMAIL_PASSWORD']
        
        print(f"🔗 Connecting to Gmail IMAP server...")
        print(f"📧 Username: {username}")
        
        mail = imaplib.IMAP4_SSL('imap.gmail.com', 993)
        mail.login(username, password)
        
        print("✅ Gmail login successful!")
        
        # Check inbox
        mail.select('inbox')
        status, messages = mail.search(None, 'ALL')
        
        if status == 'OK':
            email_count = len(messages[0].split()) if messages[0] else 0
            print(f"📬 Inbox contains {email_count} emails")
            
            # Check for recent emails from authorized sender
            auth_sender = secrets['AUTHORIZED_SENDER']
            status, recent = mail.search(None, f'FROM "{auth_sender}"')
            
            if status == 'OK':
                recent_count = len(recent[0].split()) if recent[0] else 0
                print(f"📨 Found {recent_count} emails from authorized sender: {auth_sender}")
                
                if recent_count > 0:
                    print("✅ Gmail connection and email detection working properly!")
                else:
                    print("⚠️  No emails found from authorized sender")
                    print(f"💡 Send a test email from {auth_sender} to {username}")
            
        mail.logout()
        
        return True
        
    except imaplib.IMAP4.error as e:
        print(f"❌ Gmail authentication failed: {e}")
        print("🔍 Possible issues:")
        print("  - Gmail password is incorrect")
        print("  - App password not enabled")
        print("  - Gmail account locked")
        return False
        
    except Exception as e:
        print(f"❌ Gmail connection error: {e}")
        print("🔍 Possible issues:")
        print("  - Network connectivity problems")
        print("  - Gmail server issues")
        print("  - Firewall blocking IMAP")
        return False

def test_workflow_environment():
    """Test if we're running in GitHub Actions environment"""
    print("🚀 GITHUB ACTIONS ENVIRONMENT CHECK:")
    print("-" * 30)
    
    github_env_vars = [
        'GITHUB_ACTIONS',
        'GITHUB_WORKFLOW',
        'GITHUB_RUN_ID',
        'GITHUB_ACTOR',
        'GITHUB_REPOSITORY'
    ]
    
    in_github_actions = False
    for var in github_env_vars:
        value = os.getenv(var)
        if value:
            print(f"✅ {var}: {value}")
            in_github_actions = True
        else:
            print(f"❌ {var}: Not set")
    
    print()
    
    if in_github_actions:
        print("✅ Running in GitHub Actions environment")
    else:
        print("ℹ️  Running locally (GitHub Secrets only available in Actions)")
        print("💡 This test should be run via GitHub Actions for full validation")
    
    return in_github_actions

def main():
    """Run all diagnostic tests"""
    print("🔧 EMAIL-TO-PORTFOLIO SYSTEM DIAGNOSTIC")
    print("=" * 60)
    print()
    
    # Test 1: Environment check
    in_actions = test_workflow_environment()
    print()
    
    # Test 2: Secrets check
    secrets_ok = test_github_secrets()
    print()
    
    # Final summary
    print("📊 DIAGNOSTIC SUMMARY:")
    print("=" * 30)
    
    if in_actions and secrets_ok:
        print("✅ SYSTEM STATUS: FULLY OPERATIONAL")
        print("🎉 Email-to-portfolio system should be working correctly!")
        print("📧 Send a test email to verify end-to-end functionality")
    elif secrets_ok and not in_actions:
        print("⚠️  SYSTEM STATUS: READY (Local test - secrets configured)")
        print("🚀 System should work in GitHub Actions environment")
        print("🧪 Trigger a manual workflow run to test in cloud")
    else:
        print("❌ SYSTEM STATUS: NOT OPERATIONAL")
        print("🎯 Fix GitHub Secrets configuration to resolve issues")
    
    print()
    print("🔗 Monitor system: https://github.com/cyohn55/Portfolio/actions")
    print("⚙️  Configure secrets: https://github.com/cyohn55/Portfolio/settings/secrets/actions")

if __name__ == "__main__":
    main() 