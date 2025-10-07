import re

def sanitize_filename(title):
    """Convert page title to a safe filename"""
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename + '.html'

def is_page_creation_email(subject, body=""):
    """Test if email would be processed"""
    if not subject:
        return False
    
    subject_lower = subject.lower().strip()
    
    # Skip patterns
    skip_patterns = ['unsubscribe', 'delivery failure', 'out of office', 'automatic reply', 'bounce', 'mailer-daemon', 'no-reply', 'noreply']
    if any(pattern in subject_lower for pattern in skip_patterns):
        return False
    
    # Skip replies/forwards
    if subject_lower.startswith(('re:', 'fwd:', 'fw:')):
        return False
    
    # Must have meaningful subject (> 3 chars)
    return len(subject.strip()) > 3

# Test your email
your_subject = "Let's see what we can do..."
filename = sanitize_filename(your_subject)
would_process = is_page_creation_email(your_subject)

print(f"Your email subject: '{your_subject}'")
print(f"Would be processed: {would_process}")
print(f"Generated filename: {filename}")
print(f"Expected page path: ../Pages/{filename}")

# Check if file exists
import os
page_path = f"../Pages/{filename}"
exists = os.path.exists(page_path)
print(f"Page exists: {exists}")

if exists:
    print("✅ Your page was created!")
else:
    print("❌ Your page was not created yet")
    print("\nPossible reasons:")
    print("1. Email might be in spam folder")
    print("2. GitHub Actions hasn't run yet (runs every 5 minutes)")
    print("3. Email processing might have failed")
    print("4. Email might not have been sent from cyohn55@yahoo.com") 