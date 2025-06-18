#!/usr/bin/env python3
"""
Test script for the email-to-webpage system
Simulates the complete email processing workflow
"""

import sys
import os
from email_monitor import EmailMonitor
from simple_email_processor import process_email_to_page

def test_email_processing():
    """Test the email processing functionality"""
    print("Testing Email-to-Webpage System")
    print("=" * 40)
    
    # Test with manual test email
    test_file = "manual_test.txt"
    
    if not os.path.exists(test_file):
        print(f"Error: Test file {test_file} not found")
        return False
    
    print(f"Reading test email from: {test_file}")
    
    try:
        with open(test_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        print("Email content preview:")
        print("-" * 20)
        print(email_content[:200] + "..." if len(email_content) > 200 else email_content)
        print("-" * 20)
        
        print("\nProcessing email...")
        success = process_email_to_page(email_content)
        
        if success:
            print("✓ Email processing successful!")
            return True
        else:
            print("✗ Email processing failed!")
            return False
            
    except Exception as e:
        print(f"Error during testing: {e}")
        return False

def test_email_monitor_config():
    """Test email monitor configuration"""
    print("\nTesting Email Monitor Configuration")
    print("=" * 40)
    
    try:
        # Load configuration
        import json
        with open('email_config.json', 'r') as f:
            config = json.load(f)
        
        email_config = config['email_settings']
        
        print(f"Email Server: {email_config['server']}")
        print(f"Port: {email_config['port']}")
        print(f"Username: {email_config['username']}")
        print(f"Authorized Sender: {email_config['authorized_sender']}")
        
        # Test connection (without actually connecting)
        print("✓ Configuration loaded successfully!")
        return True
        
    except Exception as e:
        print(f"✗ Configuration error: {e}")
        return False

def main():
    """Run all tests"""
    print("Email-to-Webpage System Test Suite")
    print("=" * 50)
    
    tests_passed = 0
    total_tests = 2
    
    # Test 1: Email processing
    if test_email_processing():
        tests_passed += 1
    
    # Test 2: Configuration
    if test_email_monitor_config():
        tests_passed += 1
    
    # Summary
    print("\n" + "=" * 50)
    print(f"Test Results: {tests_passed}/{total_tests} tests passed")
    
    if tests_passed == total_tests:
        print("✓ All tests passed! The email system is ready to use.")
        print("\nTo start monitoring emails, run:")
        print("python email_monitor.py")
    else:
        print("✗ Some tests failed. Please check the configuration.")
        sys.exit(1)

if __name__ == "__main__":
    main() 