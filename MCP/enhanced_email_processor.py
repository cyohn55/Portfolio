#!/usr/bin/env python3
"""
Enhanced Email Processor for Portfolio Website
Optimized for GitHub Actions cloud execution
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

# Import functions from the simple email processor
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from simple_email_processor import (
    extract_attachments, save_attachment, parse_email_content,
    extract_description, sanitize_filename, process_responsive_tags,
    process_alignment_tags, markdown_to_html, get_existing_nav_links,
    process_inline_media, update_main_index_navigation, commit_and_push_changes,
    is_delete_command, delete_page_and_tile, commit_delete_changes
)

def create_enhanced_html_page(title: str, content: str, filename: str, attachments: List[Dict] = None) -> tuple:
    """Enhanced HTML page creation with better error handling and cloud optimization"""
    try:
        # Process attachments and embed them inline in content
        processed_content, saved_files = process_inline_media(content, attachments or [], title)
        
        # Convert content to HTML (this will process the embedded media HTML)
        content_html = markdown_to_html(processed_content)
        
        # Get navigation links
        nav_links = get_existing_nav_links()
        
        # Determine the best image for social media (first image from saved files or default)
        page_image = "images/python.jpg"  # Default fallback
        if saved_files:
            # Use the first saved image file
            for file_path in saved_files:
                if any(file_path.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.webp', '.gif']):
                    page_image = file_path.replace('../', '')
                    break
        
        # Extract a meaningful description from the content
        description = extract_description(content)
        if not description:
            # Generate a description from the content if none provided
            description = generate_description_from_content(content, title)
            if not description:
                description = f"Learn about {title} in Cody's portfolio"
        
        # CSS for responsive device styling
        responsive_css = """
        /* Desktop-only content: visible on screens 769px and larger */
        @media (min-width: 769px) {
            .desktop-only {
                display: block !important;
            }
            .mobile-only {
                display: none !important;
            }
        }
        
        /* Mobile-only content: visible on screens 768px and smaller */
        @media (max-width: 768px) {
            .desktop-only {
                display: none !important;
            }
            .mobile-only {
                display: block !important;
            }
        }"""
        
        # Generate HTML with optimized structure
        html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{html.escape(title)}</title>
    <meta name="description" content="{html.escape(description)}">
    
    <!-- Favicon -->
    <link rel="icon" type="image/x-icon" href="../{page_image}">
    <link rel="icon" type="image/png" sizes="32x32" href="../{page_image}">
    <link rel="icon" type="image/png" sizes="16x16" href="../{page_image}">
    <link rel="apple-touch-icon" href="../{page_image}">
    
    <!-- Open Graph / Facebook -->
    <meta property="og:type" content="website">
    <meta property="og:url" content="https://cyohn55.github.io/Portfolio/Pages/{filename}">
    <meta property="og:title" content="{html.escape(title)}">
    <meta property="og:description" content="{html.escape(description)}">
    <meta property="og:image" content="https://cyohn55.github.io/Portfolio/{page_image}">
    <meta property="og:site_name" content="Cody's Portfolio">
    
    <!-- Twitter -->
    <meta property="twitter:card" content="summary_large_image">
    <meta property="twitter:url" content="https://cyohn55.github.io/Portfolio/Pages/{filename}">
    <meta property="twitter:title" content="{html.escape(title)}">
    <meta property="twitter:description" content="{html.escape(description)}">
    <meta property="twitter:image" content="https://cyohn55.github.io/Portfolio/{page_image}">
    
    <!-- Link to CSS -->
    <link rel="stylesheet" href="../style.css">
    
    <!-- Responsive Device Styling -->
    <style>{responsive_css}
    </style>
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
            <h1 class="article-title">{html.escape(title)}</h1>
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
        
        print(f"✅ Successfully created: {filepath}")
        if saved_files:
            print(f"📎 Saved {len(saved_files)} media files: {', '.join(os.path.basename(f) for f in saved_files)}")
        
        return True, saved_files, description
        
    except Exception as e:
        print(f"❌ Error creating HTML page: {e}")
        return False, [], ""

def generate_description_from_content(content: str, title: str) -> str:
    """Generate a description from content if no explicit description provided"""
    try:
        # Remove markdown formatting and HTML tags
        clean_content = re.sub(r'[#*`_]', '', content)
        clean_content = re.sub(r'<[^>]+>', '', clean_content)
        clean_content = re.sub(r'\[.*?\]\(.*?\)', '', clean_content)  # Remove links
        
        # Get first meaningful sentence
        sentences = re.split(r'[.!?]+', clean_content.strip())
        
        for sentence in sentences:
            sentence = sentence.strip()
            if len(sentence) > 20 and len(sentence) < 160:
                # Make sure it's not just markdown artifacts
                if not re.match(r'^[#\s]*$', sentence):
                    return sentence + "."
        
        # Fallback: use title-based description
        return f"Explore {title} - a project in Cody's portfolio showcasing programming skills and innovation."
        
    except Exception:
        return f"Learn about {title} in Cody's portfolio"

def add_enhanced_research_tile(title: str, description: str, filename: str, tile_image: str = None):
    """Enhanced tile creation that always creates tiles with cloud optimization"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            print(f"⚠️  Warning: Index file not found at {index_path}")
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if tile already exists - if so, remove it first (for overwrite behavior)
        if f'href="Pages/{filename}"' in content:
            print(f"🔄 Updating existing tile for '{title}'")
            # Remove the existing tile first
            remove_research_tile(filename, title)
            # Re-read the content after removal
            with open(index_path, 'r', encoding='utf-8') as f:
                content = f.read()
        
        # Use default image if no tile image specified
        if not tile_image:
            tile_image = "images/python.jpg"  # Default fallback image
        
        # Ensure description exists
        if not description or len(description.strip()) == 0:
            description = f"Explore {title} - a project showcasing programming skills and innovation."
        
        # Truncate description if too long
        if len(description) > 120:
            description = description[:117] + "..."
        
        # Create new tile HTML with clean formatting
        new_tile = f'''            <div class="project">
                <img src="{tile_image}" alt="{html.escape(title)}">
                <h3>{html.escape(title)}</h3>
                <p>{html.escape(description)}</p>
                <a href="Pages/{filename}">View Project</a>
            </div>'''
        
        # Find the beginning of the project container to insert new tiles first (newest first)
        # Look for the container opening and any content after it (including whitespace and comments)
        container_start = r'(<div id="project-container" class="project-container">[\s\S]*?<!-- Project items -->)'
        
        # Insert new tile right after the container opening and comment
        if re.search(container_start, content):
            updated_content = re.sub(container_start, f'\\1\n{new_tile}', content)
        else:
            # Fallback: look for just the container opening and insert after first non-whitespace content
            container_start_fallback = r'(<div id="project-container" class="project-container">[^\n]*\n)'
            if re.search(container_start_fallback, content):
                updated_content = re.sub(container_start_fallback, f'\\1{new_tile}\n', content)
            else:
                # Final fallback: insert before closing div of project-container
                container_end = r'(\s*</div>\s*</section>)'
                updated_content = re.sub(container_end, f'\n{new_tile}\n\\1', content)
        
        # Write back
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(updated_content)
        
        print(f"🏠 Added homepage tile: {title}")
        return True
        
    except Exception as e:
        print(f"❌ Error adding research tile: {e}")
        return False

def remove_research_tile(filename: str, title: str = None):
    """Remove a research tile from the homepage"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            return False
        
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Pattern to match the entire tile div
        tile_pattern = r'<div class="project">\s*<img[^>]*>\s*<h3>[^<]*</h3>\s*<p>[^<]*</p>\s*<a href="Pages/' + re.escape(filename) + r'"[^>]*>.*?</a>\s*</div>'
        
        # Remove the tile
        updated_content = re.sub(tile_pattern, '', content, flags=re.DOTALL)
        
        # Clean up any extra whitespace
        updated_content = re.sub(r'\n\s*\n\s*\n', '\n\n', updated_content)
        
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(updated_content)
        
        print(f"🗑️  Removed tile: {title or filename}")
        return True
        
    except Exception as e:
        print(f"❌ Error removing tile: {e}")
        return False

def process_enhanced_email_to_page(email_content: str) -> bool:
    """Enhanced email to page processing optimized for GitHub Actions"""
    try:
        print("🚀 Starting enhanced email processing...")
        
        # Parse email content
        parsed = parse_email_content(email_content)
        
        if not parsed:
            print("❌ Failed to parse email content")
            return False
        
        print(f"📧 Processing email: {parsed['title']}")
        
        # Check for delete command
        if is_delete_command(parsed.get('subject', ''), parsed.get('body', '')):
            delete_target = parsed.get('subject', '').replace('[Del]', '').replace('[DELETE]', '').strip()
            print(f"🗑️  Delete command detected for: {delete_target}")
            
            if delete_page_and_tile(delete_target):
                if commit_delete_changes(delete_target):
                    print(f"✅ Successfully deleted and committed: {delete_target}")
                    return True
                else:
                    print(f"⚠️  Page deleted but commit failed: {delete_target}")
                    return False
            else:
                print(f"❌ Failed to delete: {delete_target}")
                return False
        
        # Regular page creation/update
        # Extract attachments
        attachments = extract_attachments(email_content)
        print(f"📎 Found {len(attachments)} attachments")
        
        # Save attachments and get file paths
        saved_media_files = []
        for attachment in attachments:
            try:
                saved_path = save_attachment(attachment, parsed["title"])
                if saved_path:
                    saved_media_files.append(saved_path)
                    print(f"💾 Saved attachment: {os.path.basename(saved_path)}")
            except Exception as e:
                print(f"⚠️  Failed to save attachment: {e}")
        
        # Generate filename
        filename = sanitize_filename(parsed["title"]) + ".html"
        
        # Create HTML page
        success, saved_files, description = create_enhanced_html_page(
            parsed["title"], 
            parsed["content"], 
            filename, 
            attachments
        )
        
        if not success:
            print("❌ Failed to create HTML page")
            return False
        
        # Combine saved files
        all_saved_files = saved_media_files + saved_files
        
        # Always create/update homepage tile (this is the key enhancement)
        tile_success = add_enhanced_research_tile(
            parsed["title"], 
            description, 
            filename,
            all_saved_files[0] if all_saved_files else None
        )
        
        if not tile_success:
            print("⚠️  Warning: Failed to create homepage tile, but page was created")
        
        # Commit and push to GitHub (including media files)
        if commit_and_push_changes(filename, parsed["title"], all_saved_files):
            print(f"🎉 Page '{parsed['title']}' created and pushed to GitHub successfully!")
            print(f"📄 File: Pages/{filename}")
            if all_saved_files:
                print(f"📎 Media files: {', '.join(os.path.basename(f) for f in all_saved_files)}")
            print(f"🌐 Live at: https://cyohn55.github.io/Portfolio/Pages/{filename}")
            return True
        else:
            print(f"⚠️  Page created but failed to push to GitHub: {parsed['title']}")
            return False
            
    except Exception as e:
        print(f"❌ Error processing email: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Main function for enhanced email processor"""
    if len(sys.argv) != 2:
        print("❌ Usage: python enhanced_email_processor.py <email_file>")
        print("📖 Example: python enhanced_email_processor.py example_email.txt")
        sys.exit(1)
    
    email_file = sys.argv[1]
    
    if not os.path.exists(email_file):
        print(f"❌ Email file not found: {email_file}")
        sys.exit(1)
    
    try:
        with open(email_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        print(f"📧 Processing email from file: {email_file}")
        
        if process_enhanced_email_to_page(email_content):
            print("✅ Email processed successfully!")
            sys.exit(0)
        else:
            print("❌ Failed to process email")
            sys.exit(1)
            
    except Exception as e:
        print(f"❌ Error reading email file: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 