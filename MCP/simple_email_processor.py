#!/usr/bin/env python3
"""
Simplified Email Processor for Portfolio Website
Directly creates HTML pages from email content without MCP server dependency
"""

import re
import os
import sys
import html
from datetime import datetime
from typing import Dict, Any

def parse_email_content(email_text: str) -> Dict[str, Any]:
    """Parse email content to extract title and content"""
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
        "content": content
    }

def sanitize_filename(title: str) -> str:
    """Convert page title to a safe filename"""
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename + '.html'

def markdown_to_html(content: str) -> str:
    """Convert basic markdown to HTML"""
    # Escape HTML first
    content = html.escape(content)
    
    # Convert markdown headers
    content = re.sub(r'^### (.*?)$', r'<h3>\1</h3>', content, flags=re.MULTILINE)
    content = re.sub(r'^## (.*?)$', r'<h2>\1</h2>', content, flags=re.MULTILINE)
    content = re.sub(r'^# (.*?)$', r'<h1>\1</h1>', content, flags=re.MULTILINE)
    
    # Convert bold and italic
    content = re.sub(r'\*\*(.*?)\*\*', r'<strong>\1</strong>', content)
    content = re.sub(r'\*(.*?)\*', r'<em>\1</em>', content)
    
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

def create_html_page(title: str, content: str, filename: str) -> bool:
    """Create HTML page with proper structure"""
    try:
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

def process_email_to_page(email_content: str) -> bool:
    """Process email content and create web page"""
    try:
        # Parse email
        parsed = parse_email_content(email_content)
        
        # Generate filename
        filename = sanitize_filename(parsed["title"])
        
        # Create HTML page
        if create_html_page(parsed["title"], parsed["content"], filename):
            # Update navigation
            update_main_index_navigation()
            
            print(f"Page '{parsed['title']}' created successfully!")
            print(f"File: Pages/{filename}")
            return True
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