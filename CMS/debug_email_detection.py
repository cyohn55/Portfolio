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

def test_email_detection():
    """Test various email scenarios"""
    test_cases = [
        # (subject, body, expected_result, description)
        ("Test Email Processing", "This is a test email with content", True, "Simple meaningful subject"),
        ("My New Project", "Here's my new project with **bold** text", True, "Meaningful subject with markdown"),
        ("Re: Previous Email", "This is a reply", False, "Reply email"),
        ("Fwd: Something", "Forwarded email", False, "Forwarded email"),
        ("", "Empty subject", False, "Empty subject"),
        ("A", "Short subject", False, "Too short subject"),
        ("Portfolio Update", "# New Section\n\nThis has markdown headers", True, "Markdown content"),
        ("Create new page", "Content here", True, "Page creation keyword"),
        ("Unsubscribe", "Remove me", False, "Unsubscribe pattern"),
    ]
    
    print("🧪 Testing Email Detection Logic:")
    print("=" * 60)
    
    for subject, body, expected, description in test_cases:
        result = is_page_creation_email(subject, body)
        status = "✅ PASS" if result == expected else "❌ FAIL"
        print(f"{status} | {description}")
        print(f"      Subject: '{subject}'")
        print(f"      Expected: {expected}, Got: {result}")
        print("-" * 60)

print("🔍 Running Email Detection Debug Script...")
test_email_detection()
print("✅ Debug script completed!") 