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
    is_delete_command, delete_page_and_tile, commit_delete_changes,
    DESCRIPTION_PATTERN  # Import the updated description pattern
)

def create_enhanced_html_page(title: str, content: str, filename: str, attachments: List[Dict] = None, description_override: str = "") -> tuple:
    """Enhanced HTML page creation with better error handling and cloud optimization"""
    try:
        # Process attachments and embed them inline in content
        processed_content, saved_files = process_inline_media(content, attachments or [], title)
        
        print(f"DEBUG: Processed {len(attachments or [])} attachments, saved {len(saved_files)} files")
        
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
                    print(f"DEBUG: Setting page image to: {page_image}")
                    break
        
        # Determine description (prefer override from original email)
        if description_override:
            description = description_override.strip()
        else:
            # Extract from content or generate fallback
            description = extract_description(content)
            if not description:
                description = generate_description_from_content(content, title)
                if not description:
                    description = f"Learn about {title} in Cody's portfolio"
            else:
                description = re.sub(r'(?:__)?MEDIA_?PLACEHOLDER_?\d+__?', '', description, flags=re.IGNORECASE).strip()
        
        print(f"DEBUG: Description: '{description}'")
        
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
        
        print(f"SUCCESS: Successfully created: {filepath}")
        if saved_files:
            print(f"INFO: Saved {len(saved_files)} media files: {', '.join(os.path.basename(f) for f in saved_files)}")
        
        return True, saved_files, description
        
    except Exception as e:
        print(f"ERROR: Error creating HTML page: {e}")
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
    """Enhanced tile creation that adds tiles to the top (newest first)"""
    try:
        index_path = "../index.html"
        
        # Check if we're in the right directory context
        current_dir = os.getcwd()
        print(f"DEBUG: Current working directory: {current_dir}")
        print(f"DEBUG: Looking for index.html at: {os.path.abspath(index_path)}")
        
        if not os.path.exists(index_path):
            print(f"WARNING: Index file not found at {index_path}")
            print(f"WARNING: Absolute path checked: {os.path.abspath(index_path)}")
            print(f"WARNING: Current directory contents: {os.listdir('.')}")
            if os.path.exists("../"):
                print(f"WARNING: Parent directory contents: {os.listdir('../')}")
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if tile already exists - if so, remove it first (for overwrite behavior)
        if f'href="Pages/{filename}"' in content:
            print(f"INFO: Updating existing tile for '{title}'")
            # Remove the existing tile first
            from simple_email_processor import remove_research_tile
            remove_research_tile(filename, title)
            # Re-read content after removal
            with open(index_path, 'r', encoding='utf-8') as f:
                content = f.read()
        
        # Clean description - remove any media placeholders
        if description:
            description = re.sub(r'(?:__)?MEDIA_?PLACEHOLDER_?\d+__?', '', description, flags=re.IGNORECASE).strip()
        else:
            description = f"Learn about {title} in Cody's portfolio"
            
        # Default image if none provided
        if not tile_image:
            tile_image = "images/python.jpg"  # Default fallback image
        
        print(f"DEBUG: Creating tile with image: {tile_image}")
        
        # Prepare new tile HTML with proper indentation
        tile_html = f'''            <div class="project">
                <img src="{tile_image}" alt="{html.escape(title)}">
                <h3>{html.escape(title)}</h3>
                <p>{html.escape(description)}</p>
                <a href="Pages/{filename}">Read On...</a>
            </div>'''
        
        # More flexible approach - find the project container without requiring specific comment format
        if '<div id="project-container" class="project-container">' in content:
            print(f"DEBUG: Found project container div")
            
            # Get index of container div
            container_index = content.find('<div id="project-container" class="project-container">')
            
            # Find the end of the opening div tag
            end_of_div_tag = content.find('>', container_index) + 1
            
            # Insert new tile right after the div tag
            before_insertion = content[:end_of_div_tag]
            after_insertion = content[end_of_div_tag:]
            updated_content = before_insertion + '\n              <!-- Project items -->\n' + tile_html + after_insertion
            
            print(f"DEBUG: Inserting tile at position {end_of_div_tag}")
            
            # Write updated content
            with open(index_path, 'w', encoding='utf-8') as f:
                f.write(updated_content)
                
            print(f"SUCCESS: Successfully added research tile for: {title}")
            return True
        else:
            print("DEBUG: Could not find project container div")
            print("ERROR: Could not find insertion point for tile")
            print(f"DEBUG: Content preview (first 500 chars): {content[:500]}")
            return False
                
    except Exception as e:
        print(f"ERROR: Error adding research tile: {e}")
        import traceback
        traceback.print_exc()
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
        
        print(f"INFO: Removed tile: {title or filename}")
        return True
        
    except Exception as e:
        print(f"ERROR: Error removing tile: {e}")
        return False

def process_enhanced_email_to_page(email_content: str) -> bool:
    """Process email content into a web page with enhanced error handling"""
    try:
        # Parse email
        sys.path.append(os.path.dirname(os.path.abspath(__file__)))
        from simple_email_processor import parse_email_content, is_delete_command, delete_page_and_tile, commit_delete_changes
        
        parsed = parse_email_content(email_content)
        
        # Check if this is a delete command
        is_delete, page_identifier = is_delete_command(parsed["title"], parsed["content"])
        
        if is_delete:
            print(f"DELETE: Delete command detected for: {page_identifier}")
            
            # Delete the page and tile
            if delete_page_and_tile(page_identifier):
                # Get the actual filename that was used
                if page_identifier.endswith('.html'):
                    actual_filename = page_identifier
                else:
                    actual_filename = sanitize_filename(page_identifier) + '.html'
                
                # Check if we're running in GitHub Actions
                is_github_actions = os.getenv('GITHUB_ACTIONS') == 'true'
                
                if is_github_actions:
                    # In GitHub Actions, let the workflow handle git operations
                    print(f"SUCCESS: Successfully deleted '{page_identifier}' (GitHub Actions will handle git operations)")
                    return True
                else:
                    # Local execution - handle git operations ourselves
                    if commit_delete_changes(actual_filename, page_identifier):
                        print(f"SUCCESS: Successfully deleted '{page_identifier}' and pushed to GitHub!")
                        return True
                    else:
                        print(f"WARNING: Page deleted locally but failed to push to GitHub: {page_identifier}")
                        return False
            else:
                print(f"ERROR: Failed to delete page: {page_identifier}")
                return False
        
        # Regular page creation logic
        # Generate filename
        filename = sanitize_filename(parsed["title"])
        
        # Create HTML page with attachments
        success, saved_files, description = create_enhanced_html_page(
            parsed["title"],
            parsed["content"],
            filename,
            parsed.get("attachments"),
            parsed.get("description", "")
        )
        
        if success:
            # Update navigation
            update_main_index_navigation()
            
            # Find the first image to use for the tile
            tile_image = None
            ordered_content = parsed.get("ordered_content", [])
            attachments = parsed.get("attachments", [])
            
            print(f"DEBUG: Found {len(ordered_content)} ordered content items")
            print(f"DEBUG: Found {len(attachments)} attachments")
            
            # Look through ordered content to find the first image
            for item in ordered_content:
                if item.get('type') == 'media':
                    attachment_index = item.get('attachment_index')
                    if attachment_index is not None and attachment_index < len(attachments):
                        attachment = attachments[attachment_index]
                        print(f"DEBUG: Checking attachment {attachment_index}: {attachment.get('filename')} - {attachment.get('content_type')}")
                        
                        if attachment.get('content_type', '').startswith('image/'):
                            # Found the first image in body order - get its saved path
                            page_prefix = re.sub(r'[^a-zA-Z0-9]', '_', parsed["title"].lower())[:20]
                            # Sanitize attachment filename the same way save_attachment does
                            sanitized_attachment_filename = re.sub(r'[^a-zA-Z0-9._-]', '_', attachment['filename'])
                            expected_filename = f"{page_prefix}_{sanitized_attachment_filename}"
                            
                            print(f"DEBUG: Found first image: {expected_filename}")
                            
                            # Check if file exists directly in the saved files
                            for saved_file in saved_files:
                                base_saved_file = os.path.basename(saved_file)
                                print(f"DEBUG: Checking saved file: {base_saved_file}")
                                
                                if base_saved_file == expected_filename:
                                    tile_image = saved_file.replace('../', '')
                                    print(f"DEBUG: MATCH! Setting tile image to: {tile_image}")
                                    break
                            
                            # If we didn't find an exact match, check for partial filename matches
                            if not tile_image:
                                for saved_file in saved_files:
                                    base_saved_file = os.path.basename(saved_file)
                                    # Check if sanitized filename is part of saved file
                                    if sanitized_attachment_filename in base_saved_file:
                                        tile_image = saved_file.replace('../', '')
                                        print(f"DEBUG: Partial Match! Setting tile image to: {tile_image}")
                                        break
                            
                            # If we still didn't find a match, use the expected path
                            if not tile_image:
                                tile_image = f"images/{expected_filename}"
                                print(f"DEBUG: No match found, defaulting to expected path: {tile_image}")
                                
                            # Once we find the first image, we're done
                            break
                            
            # If no image was found in the content order, look directly at saved media files for images
            if not tile_image and saved_files:
                for saved_file in saved_files:
                    if any(saved_file.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
                        tile_image = saved_file.replace('../', '')
                        print(f"DEBUG: Using first saved image file: {tile_image}")
                        break
            
            # Add research tile to home page
            add_enhanced_research_tile(parsed["title"], description, filename, tile_image)
            
            # Check if we're running in GitHub Actions
            is_github_actions = os.getenv('GITHUB_ACTIONS') == 'true'
            
            if is_github_actions:
                # In GitHub Actions, let the workflow handle git operations
                print(f"SUCCESS: Successfully created page '{parsed['title']}' (GitHub Actions will handle git operations)")
                return True
            else:
                # Local execution - handle git operations ourselves
                from simple_email_processor import commit_and_push_changes
                if commit_and_push_changes(filename, parsed["title"], saved_files):
                    print(f"SUCCESS: Successfully created page '{parsed['title']}' and pushed to GitHub!")
                    return True
                else:
                    print(f"WARNING: Page created but failed to push to GitHub: {parsed['title']}")
                    return False
        else:
            return False
    
    except Exception as e:
        print(f"ERROR: Error processing email: {e}")
        import traceback
        traceback.print_exc()
        return False

def main():
    """Main function for enhanced email processor"""
    if len(sys.argv) != 2:
        print("ERROR: Usage: python enhanced_email_processor.py <email_file>")
        print("Example: python enhanced_email_processor.py example_email.txt")
        sys.exit(1)
    
    email_file = sys.argv[1]
    
    if not os.path.exists(email_file):
        print(f"ERROR: Email file not found: {email_file}")
        sys.exit(1)
    
    try:
        with open(email_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        print(f"Processing email from file: {email_file}")
        
        if process_enhanced_email_to_page(email_content):
            print("SUCCESS: Email processed successfully!")
            sys.exit(0)
        else:
            print("ERROR: Failed to process email")
            sys.exit(1)
            
    except Exception as e:
        print(f"ERROR: Error reading email file: {e}")
        sys.exit(1)

def enhanced_safe_delete_check(subject: str, content: str) -> tuple[bool, str]:
    """
    Enhanced safe delete check - uses the same logic as simple_email_processor
    This ensures consistency across all processors
    """
    return is_delete_command(subject, content)

if __name__ == "__main__":
    main() 