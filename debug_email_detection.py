#!/usr/bin/env python3
"""
Debug Email Detection
Test the email detection logic
"""

def is_page_creation_email(subject: str, body: str) -> bool:
    """Determine if email should create a page (from github_actions_email_processor.py)"""
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

def sanitize_filename(title: str) -> str:
    """Convert page title to a safe filename"""
    import re
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename + '.html'

def main():
    print("🔍 Running Email Detection Debug Script...")
    print("🧪 Testing Email Detection Logic:")
    print("=" * 60)
    
    # Test cases
    test_cases = [
        ("Test Email Processing", "", True),
        ("My New Project", "Some content here", True),
        ("Re: Previous Email", "", False),
        ("Fwd: Something", "", False),
        ("", "", False),
        ("A", "", False),
        ("Portfolio Update", "# Header\nSome markdown content", True),
        ("Create new page", "", True),
        ("Unsubscribe", "", False),
        ("Let's see what we can do...", "This is a test email to see if the system works.", True),  # Your specific email
    ]
    
    all_passed = True
    
    for subject, body, expected in test_cases:
        result = is_page_creation_email(subject, body)
        status = "✅ PASS" if result == expected else "❌ FAIL"
        if result != expected:
            all_passed = False
        
        print(f"{status} | {subject or 'Empty subject'}")
        print(f"      Subject: '{subject}'")
        print(f"      Expected: {expected}, Got: {result}")
        
        # Show filename for valid emails
        if result and subject:
            filename = sanitize_filename(subject)
            print(f"      Filename: {filename}")
        
        print("-" * 60)
    
    if all_passed:
        print("✅ Debug script completed!")
    else:
        print("❌ Some tests failed!")
    
    # Special test for your email
    print("\n🎯 SPECIFIC TEST FOR YOUR EMAIL:")
    print("=" * 60)
    your_subject = "Let's see what we can do..."
    your_body = "This is a test email to see if the system works."
    result = is_page_creation_email(your_subject, your_body)
    filename = sanitize_filename(your_subject)
    
    print(f"Subject: '{your_subject}'")
    print(f"Body: '{your_body}'")
    print(f"Would be processed: {result}")
    print(f"Generated filename: {filename}")
    print(f"Full path: Pages/{filename}")

if __name__ == "__main__":
    main() 