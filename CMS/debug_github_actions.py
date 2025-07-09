#!/usr/bin/env python3
"""
Debug GitHub Actions Email Processing
Simulate exactly what GitHub Actions does to identify issues
"""

import os
import sys
import subprocess
import tempfile
import email
from datetime import datetime

def test_email_classification_logic():
    """Test the email classification logic without requiring Gmail credentials"""
    print("🧪 TESTING EMAIL CLASSIFICATION LOGIC")
    print("=" * 50)
    
    # Test email content
    test_email_content = """# Debug Test Page

This is a test email to debug the GitHub Actions processing issue.

## Features Tested
- Markdown headers ✅
- Bold and *italic* text
- Subject length: sufficient
- From authorized sender

[Description]A test page created to debug the email-to-portfolio system issues.[/Description]

This should definitely create a page and tile!
"""
    
    subject = "Debug Test Page January 9 2025"
    
    print(f"📧 Subject: '{subject}'")
    print(f"📝 Body preview: {test_email_content[:100]}...")
    
    # Test the classification logic directly
    def is_page_creation_email(subject: str, body: str) -> bool:
        """Copy of the exact logic from github_actions_email_processor.py"""
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
        return len(subject.strip()) > 3
    
    # Test the logic
    should_create = is_page_creation_email(subject, test_email_content)
    print(f"📄 Should create page: {should_create}")
    
    if not should_create:
        print("❌ PROBLEM: Email classification logic is rejecting valid emails!")
        return False
    else:
        print("✅ Email classification logic working correctly")
        return True

def simulate_email_processing():
    """Simulate the exact steps that GitHub Actions performs"""
    print("\n🔍 SIMULATING EMAIL PROCESSING STEPS")
    print("=" * 50)
    
    # Step 1: Set environment variables (simulate GitHub Actions)
    os.environ['GITHUB_ACTIONS'] = 'true'
    print("✅ Step 1: Set GITHUB_ACTIONS environment variable")
    
    # Step 2: Create a test email that should definitely work
    test_email_content = """Return-Path: <cyohn55@yahoo.com>
Delivered-To: email.to.portfolio.site@gmail.com
Received: by 2002:a05:6a00:1490:b0:6c8:4f3e:8c74 with SMTP id d16csp123456sor;
        Wed, 9 Jul 2025 11:30:00 -0700 (PDT)
From: Cody Yohn <cyohn55@yahoo.com>
To: email.to.portfolio.site@gmail.com
Subject: Debug Test Page January 9 2025
Date: Wed, 9 Jul 2025 11:30:00 -0700
Message-ID: <debug-test-12345@yahoo.com>
Content-Type: text/plain; charset=UTF-8

# Debug Test Page

This is a test email to debug the GitHub Actions processing issue.

## Features Tested
- Markdown headers ✅
- Bold and *italic* text
- Subject length: sufficient
- From authorized sender

[Description]A test page created to debug the email-to-portfolio system issues.[/Description]

This should definitely create a page and tile!
"""
    
    print("✅ Step 2: Created test email content")
    
    # Step 3: Write email to temporary file (exactly like GitHub Actions does)
    temp_file = 'temp_email.eml'
    try:
        with open(temp_file, 'w', encoding='utf-8') as f:
            f.write(test_email_content)
        print(f"✅ Step 3: Wrote email to {temp_file}")
        
        # Step 4: Call the enhanced email processor (exactly like GitHub Actions)
        print("\n🚀 Step 4: Calling enhanced email processor")
        
        # Change to CMS directory (critical for relative paths)
        original_dir = os.getcwd()
        cms_dir = os.path.dirname(os.path.abspath(__file__))
        os.chdir(cms_dir)
        
        try:
            result = subprocess.run([
                sys.executable, 'enhanced_email_processor.py', temp_file
            ], capture_output=True, text=True, cwd=cms_dir)
            
            print(f"📊 Return code: {result.returncode}")
            print(f"📤 STDOUT:\n{result.stdout}")
            if result.stderr:
                print(f"📤 STDERR:\n{result.stderr}")
            
            if result.returncode == 0:
                print("✅ Enhanced email processor succeeded!")
                
                # Check if files were actually created
                pages_dir = '../Pages'
                if os.path.exists(pages_dir):
                    pages = [f for f in os.listdir(pages_dir) if f.endswith('.html')]
                    print(f"📁 Pages directory contains {len(pages)} HTML files")
                    
                    # Check for the most recent file
                    if pages:
                        page_times = []
                        for page in pages:
                            try:
                                page_path = os.path.join(pages_dir, page)
                                mtime = os.path.getmtime(page_path)
                                page_times.append((page, datetime.fromtimestamp(mtime)))
                            except:
                                continue
                        
                        page_times.sort(key=lambda x: x[1], reverse=True)
                        print(f"📄 Most recent page: {page_times[0][0]} at {page_times[0][1]}")
                        
                        # Check if any pages were created in last 5 minutes
                        from datetime import timedelta
                        recent_threshold = datetime.now() - timedelta(minutes=5)
                        recent_pages = [p for p, dt in page_times if dt > recent_threshold]
                        
                        if recent_pages:
                            print(f"🎉 SUCCESS! Recent pages created: {recent_pages}")
                            return True
                        else:
                            print("❌ PROBLEM: No pages created in last 5 minutes")
                            return False
                else:
                    print("❌ PROBLEM: Pages directory doesn't exist")
                    return False
                
            else:
                print("❌ Enhanced email processor failed!")
                print("   This explains why pages aren't being created.")
                return False
                
        finally:
            os.chdir(original_dir)
         
    except Exception as e:
        print(f"❌ Error during simulation: {e}")
        import traceback
        traceback.print_exc()
        return False
        
    finally:
        # Clean up
        if os.path.exists(temp_file):
            os.remove(temp_file)

def check_system_state():
    """Check current system state"""
    print("🔍 CHECKING SYSTEM STATE")
    print("=" * 40)
    
    # Check current directory
    print(f"📁 Current directory: {os.getcwd()}")
    
    # Check if we're in the right place
    expected_files = ['enhanced_email_processor.py', 'github_actions_email_processor.py', 'processed_emails_cloud.json']
    missing_files = []
    
    for file in expected_files:
        if os.path.exists(file):
            print(f"✅ Found: {file}")
        else:
            print(f"❌ Missing: {file}")
            missing_files.append(file)
    
    if missing_files:
        print(f"⚠️  Missing files: {missing_files}")
        return False
    
    # Check relative paths
    pages_dir = '../Pages'
    index_file = '../index.html'
    
    if os.path.exists(pages_dir):
        print(f"✅ Found Pages directory")
    else:
        print(f"❌ Missing Pages directory at {pages_dir}")
        
    if os.path.exists(index_file):
        print(f"✅ Found index.html")
    else:
        print(f"❌ Missing index.html at {index_file}")
    
    # Check current pages
    if os.path.exists(pages_dir):
        pages = [f for f in os.listdir(pages_dir) if f.endswith('.html')]
        print(f"📄 Current pages: {len(pages)}")
        if pages:
            # Show most recent pages
            page_times = []
            for page in pages:
                try:
                    page_path = os.path.join(pages_dir, page)
                    mtime = os.path.getmtime(page_path)
                    page_times.append((page, datetime.fromtimestamp(mtime)))
                except:
                    continue
            
            page_times.sort(key=lambda x: x[1], reverse=True)
            print(f"📄 Most recent: {page_times[0][0]} - {page_times[0][1]}")
    
    return True

def main():
    """Main debug function"""
    print("🚀 GITHUB ACTIONS DEBUG SIMULATION")
    print("=" * 60)
    
    if not check_system_state():
        print("❌ System state check failed")
        return
    
    # Test email classification first
    if not test_email_classification_logic():
        print("\n❌ DEBUG COMPLETE: Email classification logic issues found!")
        return
    
    # Test the full processing pipeline
    if simulate_email_processing():
        print("\n🎉 DEBUG COMPLETE: System working correctly!")
    else:
        print("\n❌ DEBUG COMPLETE: Processing pipeline issues found!")

if __name__ == "__main__":
    main() 