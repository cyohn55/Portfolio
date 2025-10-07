#!/usr/bin/env python3
"""
Test Email Processor
Quick test to verify the email-to-portfolio system works locally
"""

import os
import sys
from enhanced_email_processor import process_enhanced_email_to_page

def create_test_email():
    """Create a test email file"""
    test_email_content = """From: cyohn55@yahoo.com
To: email.to.portfolio.site@gmail.com
Subject: Test Email Processing

[center] ## *…Test Email Processing…*

This is a test email to verify that the email-to-portfolio system is working correctly.

**How it works:** This test email should create a new web page and add a tile to the Research section of the homepage.

[Description]This is a test email to verify the email-to-portfolio system functionality.[/Description]

The system should:
1. Parse this email content
2. Generate a new HTML page in the Pages/ directory  
3. Add a research tile to the homepage
4. Commit and push the changes to GitHub

If you can see this as a webpage with a corresponding tile, the system is working!
"""
    
    with open('test_email.eml', 'w', encoding='utf-8') as f:
        f.write(test_email_content)
    
    return 'test_email.eml'

def main():
    """Run the test"""
    print("🧪 Starting Email Processor Test...")
    
    # Create test email
    test_file = create_test_email()
    print(f"📧 Created test email: {test_file}")
    
    # Read the test email content
    with open(test_file, 'r', encoding='utf-8') as f:
        email_content = f.read()
    
    print(f"📧 Processing test email...")
    
    # Process the email
    try:
        success = process_enhanced_email_to_page(email_content)
        
        if success:
            print("✅ Test PASSED! Email processing completed successfully.")
            print("🎉 Check the Pages/ directory for the new page and the homepage for the new tile.")
        else:
            print("❌ Test FAILED! Email processing encountered errors.")
            
    except Exception as e:
        print(f"❌ Test FAILED with exception: {e}")
        import traceback
        traceback.print_exc()
    
    finally:
        # Clean up test file
        if os.path.exists(test_file):
            os.remove(test_file)
            print(f"🧹 Cleaned up test file: {test_file}")

if __name__ == "__main__":
    main() 