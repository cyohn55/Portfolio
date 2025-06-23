#!/usr/bin/env python3
"""
Enhanced Email Processor for Portfolio Website
Fixes tile generation issue and optimized for GitHub Actions
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

# Import functions from the original processor
sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from simple_email_processor import (
    extract_attachments, save_attachment, parse_email_content,
    extract_description, sanitize_filename, process_responsive_tags,
    process_alignment_tags, markdown_to_html, get_existing_nav_links,
    process_inline_media, update_main_index_navigation, commit_and_push_changes,
    is_delete_command, delete_page_and_tile, commit_delete_changes
)

def create_enhanced_html_page(title: str, content: str, filename: str, attachments: List[Dict] = None) -> tuple:
    """Enhanced HTML page creation with better error handling"""
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
        
        # Generate HTML
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
        
        print(f"Successfully created: {filepath}")
        if saved_files:
            print(f"Saved {len(saved_files)} media files: {', '.join(os.path.basename(f) for f in saved_files)}")
        
        return True, saved_files, description
        
    except Exception as e:
        print(f"Error creating HTML page: {e}")
        return False, [], ""

def generate_description_from_content(content: str, title: str) -> str:
    """Generate a description from content if no explicit description provided"""
    try:
        # Remove markdown formatting and HTML tags
        clean_content = re.sub(r'[#*`]', '', content)
        clean_content = re.sub(r'<[^>]+>', '', clean_content)
        
        # Get first paragraph or sentence
        sentences = re.split(r'[.!?]+', clean_content.strip())
        
        if sentences and len(sentences) > 0:
            first_sentence = sentences[0].strip()
            if len(first_sentence) > 20 and len(first_sentence) < 160:
                return first_sentence + "."
        
        # Fallback: use title-based description
        return f"Explore {title} - a project in Cody's portfolio showcasing programming skills and innovation."
        
    except Exception:
        return ""

def add_enhanced_research_tile(title: str, description: str, filename: str, tile_image: str = None):
    """Enhanced tile creation that always creates tiles, even without explicit descriptions"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            print(f"Warning: Index file not found at {index_path}")
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if tile already exists - if so, remove it first (for overwrite behavior)
        if f'href="Pages/{filename}"' in content:
            print(f"Tile for '{title}' already exists - removing old tile to replace with newest version")
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
        
        # Create new tile HTML
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
                # Final fallback: insert before closing div of project-container (old behavior)
                container_end = r'(\s*</div>\s*</section>)'
                updated_content = re.sub(container_end, f'\n{new_tile}\n\\1', content)
        
        # Write back
        with open(index_path, 'w', encoding='utf-8') as f:
            f.write(updated_content)
        
        print(f"Added research tile: {title}")
        return True
        
    except Exception as e:
        print(f"Error adding research tile: {e}")
        return False

def remove_research_tile(filename: str, title: str = None) -> bool:
    """Remove a research tile from the home page"""
    try:
        index_path = "../index.html"
        
        if not os.path.exists(index_path):
            print(f"Index file not found: {index_path}")
            return False
        
        # Read current content
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Find and remove the tile
        # Look for the tile with the specific filename
        tile_pattern = rf'<div class="project">\s*<img[^>]*>\s*<h3>[^<]*</h3>\s*<p>[^<]*</p>\s*<a href="Pages/{re.escape(filename)}"[^>]*>View Project</a>\s*</div>'
        
        # Try to find the tile
        match = re.search(tile_pattern, content, re.DOTALL | re.IGNORECASE)
        
        if match:
            # Remove the tile
            updated_content = content.replace(match.group(0), '')
            
            # Write back
            with open(index_path, 'w', encoding='utf-8') as f:
                f.write(updated_content)
            
            print(f"Removed tile for: {filename}")
            return True
        else:
            print(f"Tile not found for: {filename}")
            return False
        
    except Exception as e:
        print(f"Error removing research tile: {e}")
        return False

def process_enhanced_email_to_page(email_content: str) -> bool:
    """Enhanced email processing that always creates tiles"""
    try:
        # Parse email
        parsed = parse_email_content(email_content)
        
        # Check if this is a delete command
        is_delete, page_identifier = is_delete_command(parsed["title"], parsed["content"])
        
        if is_delete:
            print(f"Delete command detected for: {page_identifier}")
            
            # Delete the page and tile
            if delete_page_and_tile(page_identifier):
                # Get the actual filename that was used
                if page_identifier.endswith('.html'):
                    actual_filename = page_identifier
                else:
                    actual_filename = sanitize_filename(page_identifier) + '.html'
                
                # Commit and push the deletion
                if commit_delete_changes(actual_filename, page_identifier):
                    print(f"Successfully deleted '{page_identifier}' and pushed to GitHub!")
                    return True
                else:
                    print(f"Page deleted locally but failed to push to GitHub: {page_identifier}")
                    return False
            else:
                print(f"Failed to delete page: {page_identifier}")
                return False
        
        # Regular page creation logic
        # Generate filename
        filename = sanitize_filename(parsed["title"])
        
        # Create HTML page with attachments (enhanced version)
        success, saved_media_files, generated_description = create_enhanced_html_page(
            parsed["title"], 
            parsed["content"], 
            filename, 
            parsed.get("attachments")
        )
        
        if success:
            # Update navigation
            update_main_index_navigation()
            
            # ALWAYS add research tile to home page (this fixes the main issue)
            # Use explicit description from email, or generated description, or fallback
            description = parsed.get("description", "") or generated_description
            
            # Find the first image for the tile
            tile_image = None
            ordered_content = parsed.get("ordered_content", [])
            attachments = parsed.get("attachments", [])
            
            # Look through ordered content to find the first image
            for item in ordered_content:
                if item.get('type') == 'media':
                    attachment_index = item.get('attachment_index')
                    if attachment_index is not None and attachment_index < len(attachments):
                        attachment = attachments[attachment_index]
                        if attachment.get('content_type', '').startswith('image/'):
                            # Found the first image in body order - get its saved path
                            page_prefix = re.sub(r'[^a-zA-Z0-9]', '_', parsed["title"].lower())[:20]
                            # Sanitize attachment filename the same way save_attachment does
                            sanitized_attachment_filename = re.sub(r'[^a-zA-Z0-9._-]', '_', attachment['filename'])
                            expected_filename = f"{page_prefix}_{sanitized_attachment_filename}"
                            tile_image = f"images/{expected_filename}"
                            break
            
            # Always create a tile (this is the key fix)
            add_enhanced_research_tile(parsed["title"], description, filename, tile_image)
            print(f"Research tile added to home page with description: {description}")
            
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
        print("Usage: python enhanced_email_processor.py <email_file>")
        print("Example: python enhanced_email_processor.py example_email.txt")
        sys.exit(1)
    
    email_file = sys.argv[1]
    
    try:
        with open(email_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        if process_enhanced_email_to_page(email_content):
            print("Success! Email converted to web page with tile.")
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