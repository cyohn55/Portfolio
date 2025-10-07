#!/usr/bin/env python3
"""
GitHub Secrets Configuration Test
This script helps verify that the required secrets are properly configured
"""

import os
import sys

def test_github_secrets():
    """Test if GitHub secrets are available in the environment"""
    
    required_secrets = {
        'GMAIL_USERNAME': 'email.to.portfolio.site@gmail.com',
        'GMAIL_PASSWORD': 'Gmail App Password (should be dylvisrabxmfkzrx)',
        'AUTHORIZED_SENDER': 'cyohn55@yahoo.com'
    }
    
    print("🔍 GitHub Secrets Configuration Test")
    print("=" * 50)
    
    all_configured = True
    
    for secret_name, description in required_secrets.items():
        value = os.getenv(secret_name)
        
        if value:
            # Don't print the actual password for security
            if 'PASSWORD' in secret_name:
                print(f"✅ {secret_name}: CONFIGURED (length: {len(value)})")
            else:
                print(f"✅ {secret_name}: {value}")
        else:
            print(f"❌ {secret_name}: NOT CONFIGURED")
            print(f"   Expected: {description}")
            all_configured = False
    
    print("\n" + "=" * 50)
    
    if all_configured:
        print("🎉 SUCCESS: All secrets are configured!")
        print("🚀 Your email-to-portfolio system should be working in GitHub Actions.")
        return True
    else:
        print("⚠️  MISSING SECRETS: Some required secrets are not configured.")
        print("\n📋 TO FIX THIS:")
        print("1. Go to: https://github.com/cyohn55/Portfolio/settings/secrets/actions")
        print("2. Click 'New repository secret' for each missing secret")
        print("3. Add the exact secret names and values shown above")
        print("\n🔄 After adding secrets, the system will automatically start working!")
        return False

def test_email_connection():
    """Test if we can connect to Gmail with current environment"""
    try:
        from github_actions_email_processor import GitHubActionsEmailProcessor
        
        print("\n🧪 Testing Email Connection...")
        processor = GitHubActionsEmailProcessor()
        
        # This will fail if secrets aren't configured, which is expected locally
        mail = processor.connect_to_email()
        
        if mail:
            print("✅ Email connection successful!")
            mail.logout()
            return True
        else:
            print("❌ Email connection failed (expected if running locally)")
            return False
            
    except ValueError as e:
        if "GMAIL_PASSWORD" in str(e):
            print("❌ Gmail password not configured (expected if running locally)")
            return False
        else:
            print(f"❌ Error: {e}")
            return False
    except Exception as e:
        print(f"❌ Unexpected error: {e}")
        return False

if __name__ == "__main__":
    print("🔧 Email-to-Portfolio GitHub Secrets Test")
    print("This script helps verify your GitHub secrets configuration.\n")
    
    # Test 1: Check if secrets are available
    secrets_ok = test_github_secrets()
    
    # Test 2: Try email connection (will fail locally, but good for GitHub Actions)
    email_ok = test_email_connection()
    
    print("\n" + "=" * 60)
    print("📊 TEST SUMMARY:")
    print(f"   Secrets Configuration: {'✅ PASS' if secrets_ok else '❌ FAIL'}")
    print(f"   Email Connection: {'✅ PASS' if email_ok else '❌ FAIL (expected locally)'}")
    
    if not secrets_ok:
        print("\n🎯 NEXT STEPS:")
        print("1. Configure the missing GitHub secrets")
        print("2. Test by sending an email to email.to.portfolio.site@gmail.com")
        print("3. Check GitHub Actions for processing logs")
        sys.exit(1)
    else:
        print("\n🎉 Configuration looks good! Send a test email to verify!")
        sys.exit(0) 