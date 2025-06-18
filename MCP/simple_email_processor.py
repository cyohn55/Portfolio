#!/usr/bin/env python3
"""
Simplified Email Processor for Portfolio Website
Directly creates HTML pages from email content without MCP server dependency
"""

import re
import os
import sys
import html
import subprocess
import email
import mimetypes
import base64
from datetime import datetime
from typing import Dict, Any, List

def extract_attachments(msg) -> List[Dict[str, Any]]:
    """Extract attachments from email message"""
    attachments = []
    
    for part in msg.walk():
        if part.get_content_disposition() == 'attachment':
            filename = part.get_filename()
            if filename:
                # Get file content
                content = part.get_payload(decode=True)
                
                # Determine MIME type
                content_type = part.get_content_type()
                
                # Check if it's a supported media type
                if content_type.startswith(('image/', 'video/')):
                    attachments.append({
                        'filename': filename,
                        'content': content,
                        'content_type': content_type
                    })
    
    return attachments

def save_attachment(attachment: Dict[str, Any], page_title: str) -> str:
    """Save attachment to images directory and return relative path"""
    try:
        # Create images directory if it doesn't exist
        images_dir = "../images"
        if not os.path.exists(images_dir):
            os.makedirs(images_dir)
        
        # Sanitize filename
        filename = attachment['filename']
        # Remove any path components and sanitize
        filename = os.path.basename(filename)
        filename = re.sub(r'[^a-zA-Z0-9._-]', '_', filename)
        
        # Add page prefix to avoid conflicts
        page_prefix = re.sub(r'[^a-zA-Z0-9]', '_', page_title.lower())[:20]
        filename = f"{page_prefix}_{filename}"
        
        # Save file
        filepath = os.path.join(images_dir, filename)
        with open(filepath, 'wb') as f:
            f.write(attachment['content'])
        
        print(f"Saved attachment: {filename}")
        return f"../images/{filename}"
        
    except Exception as e:
        print(f"Error saving attachment {attachment['filename']}: {e}")
        return None

def parse_email_content(email_text: str) -> Dict[str, Any]:
    """Parse email content to extract title, content, and attachments"""
    try:
        # Try to parse as full email message first
        msg = email.message_from_string(email_text)
        
        # Extract basic info
        subject = msg.get('Subject', 'New Page')
        
        # Extract text content
        content_lines = []
        attachments = []
        
        if msg.is_multipart():
            # Extract attachments
            attachments = extract_attachments(msg)
            
            # Extract text content
            for part in msg.walk():
                if part.get_content_type() == "text/plain":
                    try:
                        text_content = part.get_payload(decode=True).decode('utf-8')
                        content_lines.extend(text_content.split('\n'))
                    except:
                        continue
        else:
            # Single part message
            try:
                text_content = msg.get_payload(decode=True).decode('utf-8')
                content_lines.extend(text_content.split('\n'))
            except:
                text_content = str(msg.get_payload())
                content_lines.extend(text_content.split('\n'))
        
        content = '\n'.join(content_lines).strip()
        
        return {
            "title": subject,
            "content": content,
            "attachments": attachments
        }
        
    except Exception as e:
        # Fallback to simple parsing
        print(f"Email parsing failed, using simple mode: {e}")
        lines = email_text.strip().split('\n')
        
        title = ""
        content_lines = []
        
        for line in lines:
            line = line.strip()
            if not line:
                continue
                
            # Look for subject patterns
            if line.lower().startswith('subject:'):
                title = line.split(':', 1)[1].strip()
            elif not title and line and not line.startswith('#'):
                title = line
            else:
                content_lines.append(line)
        
        if not title:
            title = "New Page"
        
        content = '\n'.join(content_lines).strip()
        
        return {
            "title": title,
            "content": content,
            "attachments": []
        }

def sanitize_filename(title: str) -> str:
    """Convert page title to a safe filename"""
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename + '.html'

def markdown_to_html(content: str) -> str:
    """Convert basic markdown to HTML with media support"""
    # Escape HTML first
    content = html.escape(content)
    
    # Convert markdown headers
    content = re.sub(r'^### (.*?)$', r'<h3>\1</h3>', content, flags=re.MULTILINE)
    content = re.sub(r'^## (.*?)$', r'<h2>\1</h2>', content, flags=re.MULTILINE)
    content = re.sub(r'^# (.*?)$', r'<h1>\1</h1>', content, flags=re.MULTILINE)
    
    # Convert bold and italic
    content = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', content)
    content = re.sub(r'\*(.*?)\*', r'<em>\1</em>', content)
    
    # Convert markdown images: ![alt text](url)
    content = re.sub(r'!\[(.*?)\]\((.*?)\)', r'<img src="\2" alt="\1" style="max-width: 100%; height: auto; margin: 10px 0;">', content)
    
    # Convert markdown links: [text](url)
    content = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'<a href="\2" target="_blank">\1</a>', content)
    
    # Convert video tags: [VIDEO](url)
    content = re.sub(r'\[VIDEO\]\((.*?)\)', r'<video controls style="max-width: 100%; height: auto; margin: 10px 0;"><source src="\1" type="video/mp4">Your browser does not support the video tag.</video>', content)
    
    # Convert YouTube links: [YOUTUBE](video_id or full_url)
    def youtube_replacer(match):
        url = match.group(1)
        # Extract video ID from various YouTube URL formats
        if 'youtube.com/watch?v=' in url:
            video_id = url.split('v=')[1].split('&')[0]
        elif 'youtu.be/' in url:
            video_id = url.split('youtu.be/')[1].split('?')[0]
        elif len(url) == 11:  # Direct video ID
            video_id = url
        else:
            video_id = url
        
        return f'<div class="video-container" style="position: relative; padding-bottom: 56.25%; height: 0; overflow: hidden; margin: 10px 0;"><iframe src="https://www.youtube.com/embed/{video_id}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen style="position: absolute; top: 0; left: 0; width: 100%; height: 100%;"></iframe></div>'
    
    content = re.sub(r'\[YOUTUBE\]\((.*?)\)', youtube_replacer, content)
    
    # Convert lists
    content = re.sub(r'^- (.*?)$', r'<li>\1</li>', content, flags=re.MULTILINE)
    content = re.sub(r'(<li>.*?</li>)', r'<ul>\1</ul>', content, flags=re.DOTALL)
    
    # Convert paragraphs
    paragraphs = content.split('\n\n')
    html_paragraphs = []
    
    for para in paragraphs:
        para = para.strip()
        if para and not para.startswith('<'):
            html_paragraphs.append(f'<p>{para}</p>')
        else:
            html_paragraphs.append(para)
    
    return '\n'.join(html_paragraphs)

def get_existing_nav_links() -> str:
    """Get navigation links - only Home link as requested"""
    # Only include Home link
    nav_links = ['                <li><a href="../index.html">Home</a></li>']
    return '\n'.join(nav_links)

def create_html_page(title: str, content: str, filename: str, attachments: List[Dict] = None) -> bool:
    """Create HTML page with proper structure and embedded attachments"""
    try:
        # Process attachments and save them
        attachment_html = ""
        saved_files = []
        
        if attachments:
            print(f"Processing {len(attachments)} attachments...")
            attachment_html = "\n<h2>Attachments</h2>\n"
            
            for attachment in attachments:
                saved_path = save_attachment(attachment, title)
                if saved_path:
                    saved_files.append(saved_path)
                    
                    if attachment['content_type'].startswith('image/'):
                        # Add image
                        alt_text = os.path.basename(attachment['filename'])
                        attachment_html += f'<img src="{saved_path}" alt="{alt_text}" style="max-width: 100%; height: auto; margin: 10px 0; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">\n'
                    
                    elif attachment['content_type'].startswith('video/'):
                        # Add video
                        attachment_html += f'<video controls style="max-width: 100%; height: auto; margin: 10px 0; border-radius: 8px;"><source src="{saved_path}" type="{attachment["content_type"]}">Your browser does not support the video tag.</video>\n'
        
        # Convert content to HTML
        content_html = markdown_to_html(content)
        
        # Get navigation links
        nav_links = get_existing_nav_links()
        
        # Generate HTML
        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{html.escape(title)}</title>
    <meta name="description" content="{html.escape(title)} - Cody's Portfolio">
    <!-- Link to CSS -->
    <link rel="stylesheet" href="../style.css">
</head>
<body>
    <header>
        <h2>Code(Yohn's) Portfolio</h2>
        <nav>
            <ul>
{nav_links}
            </ul>
        </nav>
    </header>

    <div class="content">
        <!-- Written Section -->
        <div class="wrap-text-container">
            <h1>{html.escape(title)}</h1>
            {content_html}
            {attachment_html}
            <p><em>Created: {datetime.now().strftime('%B %d, %Y')}</em></p>
        </div>
    </div>

    <footer>
        <p>&copy; 2025 Cody Yohn. All rights reserved.</p>
    </footer>
    <script src="../script.js"></script>
</body>
</html>"""
        
        # Write to Pages directory
        pages_dir = "../Pages"
        if not os.path.exists(pages_dir):
            os.makedirs(pages_dir)
        
        filepath = os.path.join(pages_dir, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html_template)
        
        print(f"Successfully created: {filepath}")
        if saved_files:
            print(f"Saved {len(saved_files)} media files: {', '.join(os.path.basename(f) for f in saved_files)}")
        
        return True
        
    except Exception as e:
        print(f"Error creating HTML page: {e}")
        return False

def update_main_index_navigation():
    """Update navigation in main index.html - keep only Home link"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Only Home link for main navigation
        home_nav_links = '                <li><a href="index.html">Home</a></li>'
        
        # Replace navigation section
        nav_pattern = r'<nav>\s*<ul>.*?</ul>\s*</nav>'
        new_nav = f'<nav>\n            <ul>\n{home_nav_links}\n            </ul>\n        </nav>'
        
        updated_content = re.sub(nav_pattern, new_nav, content, flags=re.DOTALL)
        
        # Write back
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(updated_content)
        
        print("Updated navigation in main index.html")
        return True
        
    except Exception as e:
        print(f"Error updating main navigation: {e}")
        return False

def commit_and_push_changes(filename: str, title: str, media_files: List[str] = None) -> bool:
    """Commit and push the new page and media files to GitHub"""
    try:
        # Change to the main directory (parent of MCP)
        main_dir = ".."
        
        # Add the new page file
        result = subprocess.run([
            'git', 'add', f'Pages/{filename}'
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git add page failed: {result.stderr}")
            return False
        
        # Add media files if any
        if media_files:
            for media_file in media_files:
                # Convert relative path to git path
                git_path = media_file.replace('../', '')
                result = subprocess.run([
                    'git', 'add', git_path
                ], cwd=main_dir, capture_output=True, text=True)
                
                if result.returncode != 0:
                    print(f"Git add media failed for {git_path}: {result.stderr}")
                    # Continue with other files
        
        # Commit the changes
        if media_files:
            commit_message = f"Add new page with media: {title}\n\nAutomatically generated from email\nIncludes {len(media_files)} media file(s)"
        else:
            commit_message = f"Add new page: {title}\n\nAutomatically generated from email"
            
        result = subprocess.run([
            'git', 'commit', '-m', commit_message
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git commit failed: {result.stderr}")
            return False
        
        # Push to GitHub
        result = subprocess.run([
            'git', 'push'
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git push failed: {result.stderr}")
            return False
        
        print(f"Successfully pushed '{title}' to GitHub!")
        if media_files:
            print(f"Pushed {len(media_files)} media files along with the page")
        return True
        
    except Exception as e:
        print(f"Error with git operations: {e}")
        return False

def process_email_to_page(email_content: str) -> bool:
    """Process email content and create web page with attachments"""
    try:
        # Parse email
        parsed = parse_email_content(email_content)
        
        # Generate filename
        filename = sanitize_filename(parsed["title"])
        
        # Track saved media files for git operations
        saved_media_files = []
        
        # Create HTML page with attachments
        if create_html_page(parsed["title"], parsed["content"], filename, parsed.get("attachments")):
            # Collect paths of saved media files
            if parsed.get("attachments"):
                for attachment in parsed["attachments"]:
                    saved_path = save_attachment(attachment, parsed["title"])
                    if saved_path:
                        saved_media_files.append(saved_path)
            
            # Update navigation
            update_main_index_navigation()
            
            # Commit and push to GitHub (including media files)
            if commit_and_push_changes(filename, parsed["title"], saved_media_files):
                print(f"Page '{parsed['title']}' created and pushed to GitHub successfully!")
                print(f"File: Pages/{filename}")
                if saved_media_files:
                    print(f"Media files: {', '.join(os.path.basename(f) for f in saved_media_files)}")
                print(f"Live at: https://cyohn55.github.io/Portfolio/Pages/{filename}")
                return True
            else:
                print(f"Page created but failed to push to GitHub: {parsed['title']}")
                return False
        else:
            return False
            
    except Exception as e:
        print(f"Error processing email: {e}")
        return False

def main():
    """Main function for command line usage"""
    if len(sys.argv) < 2:
        print("Usage: python simple_email_processor.py <email_file>")
        print("Example: python simple_email_processor.py example_email.txt")
        sys.exit(1)
    
    email_file = sys.argv[1]
    
    try:
        with open(email_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        if process_email_to_page(email_content):
            print("Success! Email converted to web page.")
        else:
            print("Failed to process email.")
            sys.exit(1)
            
    except FileNotFoundError:
        print(f"Error: Email file '{email_file}' not found")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 