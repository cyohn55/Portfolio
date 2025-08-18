#!/usr/bin/env python3
"""
Simplified Email Processor for Portfolio Website
Directly creates HTML pages from email content without MCP server dependency

IMPROVEMENTS:
- Configuration constants for maintainability
- Pre-compiled regex patterns for performance
- Enhanced error logging with context
- Better code organization and documentation
"""

import re
import os
import sys
import html
import subprocess
import email
import mimetypes
import base64
import traceback
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple
from template_engine import render as render_template

# -----------------------------------------------------------------------------
# Override with centralized config (allows env-based overrides and DRY setup)
# -----------------------------------------------------------------------------
try:
    import config  # Local import when running from CMS directory
except ModuleNotFoundError:
    # Fallback to package-style import when executed via `python -m CMS.simple_email_processor`
    from . import config  # type: ignore

PAGES_DIR = config.PAGES_DIR
IMAGES_DIR = config.IMAGES_DIR
INDEX_PATH = config.INDEX_PATH

DEFAULT_IMAGE = config.DEFAULT_IMAGE
DEFAULT_DESCRIPTION_TEMPLATE = config.DEFAULT_DESCRIPTION_TEMPLATE
MAX_DESCRIPTION_LENGTH = config.MAX_DESCRIPTION_LENGTH
MAX_TITLE_PREFIX_LENGTH = config.MAX_TITLE_PREFIX_LENGTH

SUPPORTED_IMAGE_EXTENSIONS = config.SUPPORTED_IMAGE_EXTENSIONS
SUPPORTED_VIDEO_EXTENSIONS = config.SUPPORTED_VIDEO_EXTENSIONS
SUPPORTED_AUDIO_EXTENSIONS = config.SUPPORTED_AUDIO_EXTENSIONS

GIT_COMMIT_AUTHOR = config.GIT_COMMIT_AUTHOR
GIT_COMMIT_EMAIL = config.GIT_COMMIT_EMAIL

# =============================================================================
# PRE-COMPILED REGEX PATTERNS FOR PERFORMANCE
# =============================================================================

# Delete command patterns
DELETE_PATTERNS = [
    re.compile(r'\[del\]\s*(.+)', re.IGNORECASE),
    re.compile(r'del:\s*(.+)', re.IGNORECASE),
    re.compile(r'remove:\s*(.+)', re.IGNORECASE),
    re.compile(r'\[remove\]\s*(.+)', re.IGNORECASE),
    re.compile(r'\[delete\]\s*(.+)', re.IGNORECASE),
    re.compile(r'delete:\s*(.+)', re.IGNORECASE)
]

# Content processing patterns
DESCRIPTION_PATTERN = re.compile(r'\[Description\](.*?)\[/Description\]', re.IGNORECASE | re.DOTALL)
MARKDOWN_BOLD_PATTERN = re.compile(r'\*\*(.*?)\*\*')
MARKDOWN_ITALIC_PATTERN = re.compile(r'\*(.*?)\*')
MARKDOWN_IMAGE_PATTERN = re.compile(r'!\[(.*?)\]\((.*?)\)')
MARKDOWN_LINK_PATTERN = re.compile(r'\[([^\]]+)\]\(([^)]+)\)')
YOUTUBE_PATTERN = re.compile(r'https?://(?:www\.)?youtube\.com/watch\?v=([a-zA-Z0-9_-]{11})')
YOUTUBE_SHORT_PATTERN = re.compile(r'https?://(?:www\.)?youtu\.be/([a-zA-Z0-9_-]{11})')
EMAIL_PATTERN = re.compile(r'\[Email:[^\]]*\]', re.IGNORECASE)
DELETE_PATTERN = re.compile(r'\[DELETE\s+CONFIRM\]\s*(.+)$', re.IGNORECASE)
VIDEO_PATTERN = re.compile(r'\[VIDEO\]\((.*?)\)')

# Responsive tag patterns
DESKTOP_PATTERN = re.compile(r'\[Desktop\](.*?)\[/Desktop\]', re.DOTALL | re.IGNORECASE)
MOBILE_PATTERN = re.compile(r'\[Mobile\](.*?)\[/Mobile\]', re.DOTALL | re.IGNORECASE)

# Alignment patterns
ALIGNMENT_PATTERNS = {
    'center': re.compile(r'\[center\](.*?)$', re.IGNORECASE),
    'left': re.compile(r'\[left\](.*?)$', re.IGNORECASE),
    'right': re.compile(r'\[right\](.*?)$', re.IGNORECASE)
}

# Carousel pattern
CAROUSEL_PATTERN = re.compile(r'\[Carousel\](.*?)\[/Carousel\]', re.DOTALL | re.IGNORECASE)

# Filename sanitization pattern
FILENAME_SANITIZE_PATTERN = re.compile(r'[^a-zA-Z0-9._-]')

# =============================================================================
# ENHANCED LOGGING SETUP
# =============================================================================

def setup_logging():
    """Setup enhanced logging with context"""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(funcName)s:%(lineno)d - %(message)s',
        handlers=[
            logging.StreamHandler(sys.stdout)
        ]
    )
    return logging.getLogger(__name__)

logger = setup_logging()

# =============================================================================
# ENHANCED ERROR HANDLING DECORATOR
# =============================================================================

def log_errors(func_name: str):
    """Decorator for enhanced error logging with context"""
    def decorator(func):
        def wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except Exception as e:
                logger.error(f"Error in {func_name}: {str(e)}")
                logger.error(f"Function args: {args[:2] if args else 'None'}")  # First 2 args only for privacy
                logger.error(f"Exception type: {type(e).__name__}")
                logger.debug(f"Full traceback: {traceback.format_exc()}")
                raise
        return wrapper
    return decorator

# =============================================================================
# UTILITY FUNCTIONS
# =============================================================================

def ensure_directory_exists(directory_path: str) -> bool:
    """Ensure directory exists, create if necessary"""
    try:
        if not os.path.exists(directory_path):
            os.makedirs(directory_path)
            logger.info(f"Created directory: {directory_path}")
        return True
    except Exception as e:
        logger.error(f"Failed to create directory {directory_path}: {e}")
        return False

def is_supported_media_file(filename: str) -> Tuple[bool, str]:
    """Check if file is supported media and return type"""
    filename_lower = filename.lower()
    
    if any(filename_lower.endswith(ext) for ext in SUPPORTED_IMAGE_EXTENSIONS):
        return True, 'image'
    elif any(filename_lower.endswith(ext) for ext in SUPPORTED_VIDEO_EXTENSIONS):
        return True, 'video'
    elif any(filename_lower.endswith(ext) for ext in SUPPORTED_AUDIO_EXTENSIONS):
        return True, 'audio'
    
    return False, 'unknown'

def sanitize_filename_enhanced(title: str) -> str:
    """Enhanced filename sanitization with better handling"""
    if not title or not title.strip():
        return f"untitled_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    
    # Remove extra whitespace and convert to lowercase
    sanitized = title.strip().lower()
    
    # Replace spaces with hyphens for better URL structure
    sanitized = re.sub(r'\s+', '-', sanitized)
    
    # Remove or replace special characters
    sanitized = FILENAME_SANITIZE_PATTERN.sub('', sanitized)
    
    # Remove consecutive hyphens
    sanitized = re.sub(r'-+', '-', sanitized)
    
    # Remove leading/trailing hyphens
    sanitized = sanitized.strip('-')
    
    # Ensure reasonable length
    if len(sanitized) > 50:
        sanitized = sanitized[:50].rstrip('-')
    
    # Ensure it ends with .html
    if not sanitized.endswith('.html'):
        sanitized += '.html'
    
    return sanitized

# -------------------------------------------------
# HTML to plain-text helper (for HTML-only emails)
# -------------------------------------------------

def html_to_text(html_content: str) -> str:
    """Convert basic HTML to plain text for tag parsing.

    Keeps line breaks created by <br> and </p> so that later markdown/
    description extraction logic still sees paragraph boundaries.
    No external dependencies, quick regex-based stripping is enough
    because we only need the raw text for the [Description] block.
    """
    import html as _html

    # Normalise newline-style breaks
    text = re.sub(r'<\s*br\s*/?>', '\n', html_content, flags=re.IGNORECASE)
    text = re.sub(r'</\s*p\s*>', '\n', text, flags=re.IGNORECASE)

    # Drop all other tags
    text = re.sub(r'<[^>]+>', '', text)

    # Un-escape HTML entities (&amp; → & etc.)
    return _html.unescape(text)

# =============================================================================
# ORIGINAL FUNCTIONS (Enhanced with logging and error handling)
# =============================================================================

def extract_attachments(msg) -> List[Dict[str, Any]]:
    """Extract attachments and inline images from email message"""
    attachments = []
    inline_counter = 1
    
    for part in msg.walk():
        content_disposition = part.get_content_disposition()
        content_type = part.get_content_type()
        
        # Check for both attachments and inline images
        if content_disposition in ['attachment', 'inline'] or content_type.startswith(('image/', 'video/')):
            filename = part.get_filename()
            
            # Generate filename for inline images without names
            if not filename and content_type.startswith('image/'):
                ext = content_type.split('/')[-1]
                if ext in ['jpeg', 'jpg', 'png', 'gif', 'webp', 'svg']:
                    filename = f"inline_image_{inline_counter}.{ext}"
                    inline_counter += 1
            
            if filename and content_type.startswith(('image/', 'video/')):
                try:
                    # Get file content
                    content = part.get_payload(decode=True)
                    
                    if content and len(content) > 100:  # Ensure it's not empty/tiny
                        attachments.append({
                            'filename': filename,
                            'content': content,
                            'content_type': content_type,
                            'disposition': content_disposition or 'inline'
                        })
                        print(f"Found {content_disposition or 'inline'} media: {filename} ({len(content)} bytes)")
                except Exception as e:
                    print(f"Error extracting {filename}: {e}")
                    continue
    
    return attachments

@log_errors("save_attachment")
def save_attachment(attachment: Dict[str, Any], page_title: str) -> Optional[str]:
    """Save attachment to images directory and return relative path"""
    # Ensure images directory exists
    if not ensure_directory_exists(IMAGES_DIR):
        return None
    
    # Validate attachment data
    attachment_data = attachment.get('data') or attachment.get('content')
    if not attachment_data:
        logger.warning(f"No attachment data found for {attachment.get('filename', 'unknown')}")
        return None
    
    # Sanitize filename
    filename = attachment.get('filename', 'unknown_file')
    filename = os.path.basename(filename)  # Remove path components
    filename = FILENAME_SANITIZE_PATTERN.sub('_', filename)
    
    # Add page prefix to avoid conflicts (using enhanced function)
    page_prefix = FILENAME_SANITIZE_PATTERN.sub('_', page_title.lower())[:MAX_TITLE_PREFIX_LENGTH]
    filename = f"{page_prefix}_{filename}"
    
    # Save file
    filepath = os.path.join(IMAGES_DIR, filename)
    with open(filepath, 'wb') as f:
        f.write(attachment_data)
    
    logger.info(f"Saved attachment: {filename} ({len(attachment_data)} bytes)")
    return f"../images/{filename}"

def parse_email_content(email_text: str) -> Dict[str, Any]:
    """Parse email content maintaining exact sequential order of text and media"""
    try:
        # Try to parse as full email message first
        msg = email.message_from_string(email_text)
        
        # Extract basic info
        subject = msg.get('Subject', 'New Page')
        
        # Process parts in exact sequential order to maintain 1:1 structure
        ordered_content = []
        attachments = []
        
        if msg.is_multipart():
            # Process all parts in the order they appear in the email
            for part in msg.walk():
                content_type = part.get_content_type()
                content_disposition = part.get('Content-Disposition', '')
                
                if content_type in ("text/plain", "text/html") and 'attachment' not in content_disposition:
                    # This is text content - add to ordered sequence
                    try:
                        payload = part.get_payload(decode=True)
                        raw_text = payload.decode('utf-8') if isinstance(payload, bytes) else str(payload)
                        # If HTML, convert to plain text first
                        text_content = html_to_text(raw_text) if content_type == "text/html" else raw_text
                        if text_content.strip():
                            ordered_content.append({
                                'type': 'text',
                                'content': text_content.strip()
                            })
                    except:
                        continue
                        
                elif content_type.startswith(('image/', 'video/', 'audio/')):
                    # This is media - add placeholder to ordered sequence
                    filename = part.get_filename()
                    if not filename:
                        # Generate filename for inline attachments
                        ext = mimetypes.guess_extension(content_type) or '.bin'
                        filename = f"inline_media_{len(attachments) + 1}{ext}"
                    
                    try:
                        payload = part.get_payload(decode=True)
                        if payload:
                            attachment_info = {
                                'filename': filename,
                                'content_type': content_type,
                                'data': payload,
                                'disposition': 'inline' if 'inline' in content_disposition else 'attachment'
                            }
                            attachments.append(attachment_info)
                            
                            # Add media placeholder to ordered content at exact position
                            ordered_content.append({
                                'type': 'media',
                                'filename': filename,
                                'attachment_index': len(attachments) - 1
                            })
                    except:
                        continue
        else:
            # Single part message (non-multipart)
            try:
                payload = msg.get_payload(decode=True)
                raw_text = payload.decode('utf-8') if isinstance(payload, bytes) else str(payload)
            except Exception:
                raw_text = str(msg.get_payload())

            if raw_text.strip():
                content_type = msg.get_content_type()
                text_content = html_to_text(raw_text) if content_type == "text/html" else raw_text
                ordered_content.append({'type': 'text', 'content': text_content.strip()})
        
        # Reconstruct content maintaining exact order with media placeholders
        sequential_content = []
        for item in ordered_content:
            if item['type'] == 'text':
                sequential_content.append(item['content'])
            elif item['type'] == 'media':
                # Insert media placeholder that preserves exact position
                sequential_content.append(f"__MEDIA_PLACEHOLDER_{item['attachment_index']}__")
        
        content = '\n\n'.join(sequential_content)
        
        # Extract description if present and remove it from content
        description = extract_description(content)
        if description:
            # Remove the [Description] tag from content
            content = re.sub(r'\[Description\](.*?)\[/Description\]', '', content, flags=re.IGNORECASE).strip()
        
        return {
            "title": subject,
            "content": content,
            "attachments": attachments,
            "ordered_content": ordered_content,
            "description": description
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
            "attachments": [],
            "ordered_content": [{'type': 'text', 'content': content}],
            "description": ""
        }

def extract_description(content: str) -> str:
    """Extract description from [Description] tag in content using pre-compiled pattern"""
    match = DESCRIPTION_PATTERN.search(content)
    if match:
        # Extract the description and remove any media placeholders
        description = match.group(1).strip()
        # Remove any placeholder artefacts (both new and legacy spellings)
        description = re.sub(r'(?:__)?MEDIA_?PLACEHOLDER_?\d+__?', '', description, flags=re.IGNORECASE).strip()
        return description
    return ""

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

def sanitize_filename(title: str) -> str:
    """Convert page title to a safe filename"""
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename + '.html'

def process_responsive_tags(content: str) -> str:
    """Process responsive device tags: [Desktop], [Mobile] with optional alignment"""
    import re
    
    # Process [Desktop]...[/Desktop] blocks with optional alignment
    def process_desktop_block(match):
        block_content = match.group(1).strip()
        
        # Check for alignment tags within the desktop block
        alignment_style = ""
        if block_content.startswith('[center]'):
            block_content = block_content[8:].strip()  # Remove [center]
            alignment_style = "text-align: center; "
        elif block_content.startswith('[left]'):
            block_content = block_content[6:].strip()  # Remove [left]
            alignment_style = "text-align: left; "
        elif block_content.startswith('[right]'):
            block_content = block_content[7:].strip()  # Remove [right]
            alignment_style = "text-align: right; "
        
        # Wrap in desktop-only div with media query
        return f'<div class="desktop-only" style="display: block; {alignment_style}margin: 10px 0;">{block_content}</div>'
    
    # Process [Mobile]...[/Mobile] blocks with optional alignment
    def process_mobile_block(match):
        block_content = match.group(1).strip()
        
        # Check for alignment tags within the mobile block (default to left if none specified)
        alignment_style = "text-align: left; "  # Default mobile alignment
        if block_content.startswith('[center]'):
            block_content = block_content[8:].strip()  # Remove [center]
            alignment_style = "text-align: center; "
        elif block_content.startswith('[left]'):
            block_content = block_content[6:].strip()  # Remove [left]
            alignment_style = "text-align: left; "
        elif block_content.startswith('[right]'):
            block_content = block_content[7:].strip()  # Remove [right]
            alignment_style = "text-align: right; "
        
        # Wrap in mobile-only div with media query
        return f'<div class="mobile-only" style="display: none; {alignment_style}margin: 10px 0;">{block_content}</div>'
    
    # Replace [Desktop]...[/Desktop] blocks
    content = re.sub(r'\[Desktop\](.*?)\[/Desktop\]', process_desktop_block, content, flags=re.DOTALL | re.IGNORECASE)
    
    # Replace [Mobile]...[/Mobile] blocks
    content = re.sub(r'\[Mobile\](.*?)\[/Mobile\]', process_mobile_block, content, flags=re.DOTALL | re.IGNORECASE)
    
    return content

def process_alignment_tags(content: str) -> str:
    """Process custom alignment tags: [center], [left], [right] for text, images, and videos"""
    lines = content.split('\n')
    processed_lines = []
    
    for line in lines:
        original_line = line
        line = line.strip()
        
        # Check for alignment tags at the beginning of the line
        if line.startswith('[center]'):
            # Remove the tag and get content
            content_text = line[8:].strip()  # Remove '[center]' (8 characters)
            if content_text:
                # Process markdown headers within alignment tags
                if content_text.startswith('###'):
                    # Convert ### to <h3> and center it
                    header_text = content_text[3:].strip()
                    processed_lines.append(f'<div style="text-align: center; margin: 10px 0;"><h3>{header_text}</h3></div>')
                elif content_text.startswith('##'):
                    # Convert ## to <h2> and center it
                    header_text = content_text[2:].strip()
                    processed_lines.append(f'<div style="text-align: center; margin: 10px 0;"><h2>{header_text}</h2></div>')
                elif content_text.startswith('#'):
                    # Convert # to <h1> and center it
                    header_text = content_text[1:].strip()
                    processed_lines.append(f'<div style="text-align: center; margin: 10px 0;"><h1>{header_text}</h1></div>')
                # Check if content contains media elements (img, video, or media placeholders)
                elif ('<img ' in content_text or '<video ' in content_text or 
                    '__MEDIA_PLACEHOLDER_' in content_text or 
                    any(content_text.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi'])):
                    # For media, use flexbox centering for better control
                    processed_lines.append(f'<div style="display: flex; justify-content: center; margin: 10px 0;">{content_text}</div>')
                else:
                    # For text, use text-align
                    processed_lines.append(f'<div style="text-align: center; margin: 10px 0;">{content_text}</div>')
            else:
                processed_lines.append(original_line)  # Keep original if no content after tag
                
        elif line.startswith('[left]'):
            # Remove the tag and get content
            content_text = line[6:].strip()  # Remove '[left]' (6 characters)
            if content_text:
                # Process markdown headers within alignment tags
                if content_text.startswith('###'):
                    # Convert ### to <h3> and left-align it
                    header_text = content_text[3:].strip()
                    processed_lines.append(f'<div style="text-align: left; margin: 10px 0;"><h3>{header_text}</h3></div>')
                elif content_text.startswith('##'):
                    # Convert ## to <h2> and left-align it
                    header_text = content_text[2:].strip()
                    processed_lines.append(f'<div style="text-align: left; margin: 10px 0;"><h2>{header_text}</h2></div>')
                elif content_text.startswith('#'):
                    # Convert # to <h1> and left-align it
                    header_text = content_text[1:].strip()
                    processed_lines.append(f'<div style="text-align: left; margin: 10px 0;"><h1>{header_text}</h1></div>')
                # Check if content contains media elements
                elif ('<img ' in content_text or '<video ' in content_text or 
                    '__MEDIA_PLACEHOLDER_' in content_text or 
                    any(content_text.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi'])):
                    # For media, use flexbox left alignment
                    processed_lines.append(f'<div style="display: flex; justify-content: flex-start; margin: 10px 0;">{content_text}</div>')
                else:
                    # For text, use text-align
                    processed_lines.append(f'<div style="text-align: left; margin: 10px 0;">{content_text}</div>')
            else:
                processed_lines.append(original_line)  # Keep original if no content after tag
                
        elif line.startswith('[right]'):
            # Remove the tag and get content
            content_text = line[7:].strip()  # Remove '[right]' (7 characters)
            if content_text:
                # Process markdown headers within alignment tags
                if content_text.startswith('###'):
                    # Convert ### to <h3> and right-align it
                    header_text = content_text[3:].strip()
                    processed_lines.append(f'<div style="text-align: right; margin: 10px 0;"><h3>{header_text}</h3></div>')
                elif content_text.startswith('##'):
                    # Convert ## to <h2> and right-align it
                    header_text = content_text[2:].strip()
                    processed_lines.append(f'<div style="text-align: right; margin: 10px 0;"><h2>{header_text}</h2></div>')
                elif content_text.startswith('#'):
                    # Convert # to <h1> and right-align it
                    header_text = content_text[1:].strip()
                    processed_lines.append(f'<div style="text-align: right; margin: 10px 0;"><h1>{header_text}</h1></div>')
                # Check if content contains media elements
                elif ('<img ' in content_text or '<video ' in content_text or 
                    '__MEDIA_PLACEHOLDER_' in content_text or 
                    any(content_text.endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.avi'])):
                    # For media, use flexbox right alignment
                    processed_lines.append(f'<div style="display: flex; justify-content: flex-end; margin: 10px 0;">{content_text}</div>')
                else:
                    # For text, use text-align
                    processed_lines.append(f'<div style="text-align: right; margin: 10px 0;">{content_text}</div>')
            else:
                processed_lines.append(original_line)  # Keep original if no content after tag
        else:
            processed_lines.append(original_line)
    
    return '\n'.join(processed_lines)

def markdown_to_html(content: str) -> str:
    """Convert basic markdown to HTML with media support"""
    # Don't escape HTML if it contains pre-embedded media tags
    if '<img ' in content or '<video ' in content:
        # Content already has HTML, process carefully
        pass
    else:
        # Escape HTML for safety
        content = html.escape(content)
    
    # Process responsive device tags FIRST (before alignment and markdown headers)
    content = process_responsive_tags(content)
    
    # Process custom alignment tags SECOND (before markdown headers)
    # This allows alignment tags to handle their own markdown
    content = process_alignment_tags(content)
    
    # Convert markdown headers (but skip headers that are already inside alignment divs)
    lines = content.split('\n')
    processed_lines = []
    first_h1_found = False
    inside_alignment_div = False
    
    for line in lines:
        # Check if we're inside an alignment div
        if '<div style=' in line and ('text-align:' in line or 'display: flex' in line):
            inside_alignment_div = True
            processed_lines.append(line)
            continue
        elif line.strip() == '</div>' and inside_alignment_div:
            inside_alignment_div = False
            processed_lines.append(line)
            continue
        elif inside_alignment_div:
            # Skip markdown processing for lines inside alignment divs
            processed_lines.append(line)
            continue
        
        # Process markdown headers only if not inside alignment divs
        line_stripped = line.strip()
        if line_stripped.startswith('### '):
            processed_lines.append('<h3>' + line_stripped[4:] + '</h3>')
        elif line_stripped.startswith('## '):
            processed_lines.append('<h2>' + line_stripped[3:] + '</h2>')
        elif line_stripped.startswith('# ') and not first_h1_found:
            # Skip the first H1 to avoid duplication with page title
            first_h1_found = True
            continue
        elif line_stripped.startswith('# '):
            # Convert subsequent H1s to H2s for better hierarchy
            processed_lines.append('<h2>' + line_stripped[2:] + '</h2>')
        else:
            processed_lines.append(line)
    
    content = '\n'.join(processed_lines)
    
    # Convert markdown formatting using pre-compiled patterns for better performance
    content = MARKDOWN_BOLD_PATTERN.sub(r'<strong>\1</strong>', content)
    content = MARKDOWN_ITALIC_PATTERN.sub(r'<em>\1</em>', content)
    
    # Convert markdown images: ![alt text](url)
    content = MARKDOWN_IMAGE_PATTERN.sub(r'<img src="\2" alt="\1" style="max-width: 50vw; height: auto; margin: 10px 0;">', content)
    
    # Convert markdown links: [text](url)
    content = MARKDOWN_LINK_PATTERN.sub(r'<a href="\2" target="_blank">\1</a>', content)
    
    # Convert video tags: [VIDEO](url)
    content = VIDEO_PATTERN.sub(r'<video controls style="max-width: 100%; height: auto; margin: 10px 0; border-radius: 8px;" preload="metadata"><source src="\1" type="video/mp4"><p>Your browser doesn\'t support HTML video. <a href="\1">Download the video</a> instead.</p></video>', content)
    
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
    
    content = YOUTUBE_PATTERN.sub(youtube_replacer, content)
    
    # Process [Carousel][/Carousel] tags for image/video galleries
    def process_carousel_tags(content):
        """Process [Carousel] tags to create responsive image/video carousels"""
        carousel_pattern = r'\[Carousel\](.*?)\[/Carousel\]'
        
        def carousel_replacer(match):
            carousel_content = match.group(1).strip()
            carousel_items = []
            
            # Split content by lines and process each item
            for line in carousel_content.split('\n'):
                line = line.strip()
                if not line:
                    continue
                    
                # Check if line contains media (image or video)
                if any(line.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
                    # Image item
                    if '__MEDIA_PLACEHOLDER_' in line:
                        carousel_items.append(f'<div class="carousel-item"><img src="{line}" alt="Carousel Image" style="width: 100%; height: auto; border-radius: 8px;"></div>')
                    else:
                        carousel_items.append(f'<div class="carousel-item"><img src="../images/{line}" alt="Carousel Image" style="width: 100%; height: auto; border-radius: 8px;"></div>')
                elif any(line.lower().endswith(ext) for ext in ['.mp4', '.mov', '.avi']):
                    # Video item - improved compatibility
                    if '__MEDIA_PLACEHOLDER_' in line:
                        carousel_items.append(f'<div class="carousel-item"><video controls style="width: 100%; height: auto; border-radius: 8px;" preload="metadata"><source src="{line}" type="video/mp4"><p>Your browser doesn\'t support HTML video. <a href="{line}">Download the video</a> instead.</p></video></div>')
                    else:
                        carousel_items.append(f'<div class="carousel-item"><video controls style="width: 100%; height: auto; border-radius: 8px;" preload="metadata"><source src="../images/{line}" type="video/mp4"><p>Your browser doesn\'t support HTML video. <a href="../images/{line}">Download the video</a> instead.</p></video></div>')
                elif '<img ' in line or '<video ' in line or '__MEDIA_PLACEHOLDER_' in line:
                    # Already processed media
                    carousel_items.append(f'<div class="carousel-item">{line}</div>')
                else:
                    # Text content or captions
                    carousel_items.append(f'<div class="carousel-item carousel-text"><p style="text-align: center; margin: 10px 0; font-style: italic;">{line}</p></div>')
            
            if not carousel_items:
                return carousel_content  # Return original if no items found
            
            # Generate unique carousel ID
            import random
            carousel_id = f"carousel_{random.randint(1000, 9999)}"
            
            # Create carousel HTML with navigation
            carousel_html = f'''
<div class="carousel-container" id="{carousel_id}" style="position: relative; max-width: 800px; margin: 20px auto; background: #f5f5f5; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.1);">
    <div class="carousel-track" style="display: flex; transition: transform 0.3s ease;">
        {"".join(carousel_items)}
    </div>
    <button class="carousel-btn carousel-prev" onclick="moveCarousel('{carousel_id}', -1)" style="position: absolute; top: 50%; left: 10px; transform: translateY(-50%); background: rgba(0,0,0,0.7); color: white; border: none; padding: 10px 15px; border-radius: 50%; cursor: pointer; font-size: 18px; z-index: 10;">❮</button>
    <button class="carousel-btn carousel-next" onclick="moveCarousel('{carousel_id}', 1)" style="position: absolute; top: 50%; right: 10px; transform: translateY(-50%); background: rgba(0,0,0,0.7); color: white; border: none; padding: 10px 15px; border-radius: 50%; cursor: pointer; font-size: 18px; z-index: 10;">❯</button>
    <div class="carousel-indicators" style="text-align: center; padding: 15px;">
        {" ".join([f'<span class="carousel-dot" onclick="currentSlide(&quot;{carousel_id}&quot;, {i+1})" style="height: 12px; width: 12px; margin: 0 5px; background-color: #bbb; border-radius: 50%; display: inline-block; cursor: pointer; transition: background-color 0.3s;"></span>' for i in range(len(carousel_items))])}
    </div>
</div>
<script>
if (typeof carouselData === 'undefined') {{
    var carouselData = {{}};
}}
carouselData['{carousel_id}'] = {{currentSlide: 0, totalSlides: {len(carousel_items)}}};

function moveCarousel(carouselId, direction) {{
    var data = carouselData[carouselId];
    var track = document.querySelector('#' + carouselId + ' .carousel-track');
    data.currentSlide += direction;
    
    if (data.currentSlide >= data.totalSlides) data.currentSlide = 0;
    if (data.currentSlide < 0) data.currentSlide = data.totalSlides - 1;
    
    track.style.transform = 'translateX(-' + (data.currentSlide * 100) + '%%)';
    updateDots(carouselId);
}}

function currentSlide(carouselId, slideIndex) {{
    var data = carouselData[carouselId];
    var track = document.querySelector('#' + carouselId + ' .carousel-track');
    data.currentSlide = slideIndex - 1;
    track.style.transform = 'translateX(-' + (data.currentSlide * 100) + '%%)';
    updateDots(carouselId);
}}

function updateDots(carouselId) {{
    var data = carouselData[carouselId];
    var dots = document.querySelectorAll('#' + carouselId + ' .carousel-dot');
    dots.forEach((dot, index) => {{
        dot.style.backgroundColor = index === data.currentSlide ? '#333' : '#bbb';
    }});
}}

// Initialize carousel
document.addEventListener('DOMContentLoaded', function() {{
    updateDots('{carousel_id}');
}});
</script>
<style>
.carousel-item {{
    min-width: 100%;
    padding: 20px;
    box-sizing: border-box;
}}
.carousel-btn:hover {{
    background: rgba(0,0,0,0.9) !important;
}}
.carousel-dot:hover {{
    background-color: #333 !important;
}}
</style>'''
            
            return carousel_html
        
        return re.sub(carousel_pattern, carousel_replacer, content, flags=re.DOTALL | re.IGNORECASE)
    
    content = process_carousel_tags(content)
    
    # Convert lists
    content = re.sub(r'^- (.*?)$', r'<li>\1</li>', content, flags=re.MULTILINE)
    content = re.sub(r'(<li>.*?</li>)', r'<ul>\1</ul>', content, flags=re.DOTALL)
    
    # Convert paragraphs - but preserve all HTML elements
    paragraphs = content.split('\n\n')
    html_paragraphs = []
    
    for para in paragraphs:
        para = para.strip()
        if para:
            # Split paragraph into lines to check for headers and HTML elements
            lines = para.split('\n')
            processed_para_lines = []
            current_text_block = []
            inside_html_block = False
            html_block_tag = None
            
            for line in lines:
                line_stripped = line.strip()
                
                # Check if we're starting a multi-line HTML block
                if not inside_html_block:
                    # Check for opening tags of multi-line HTML elements
                    if line_stripped.startswith('<video') and not line_stripped.endswith('</video>'):
                        inside_html_block = True
                        html_block_tag = 'video'
                        # If we have accumulated text, wrap it in a paragraph
                        if current_text_block:
                            processed_para_lines.append(f'<p>{" ".join(current_text_block)}</p>')
                            current_text_block = []
                        processed_para_lines.append(line)
                        continue
                    elif line_stripped.startswith('<div') and not line_stripped.endswith('</div>'):
                        inside_html_block = True
                        html_block_tag = 'div'
                        # If we have accumulated text, wrap it in a paragraph
                        if current_text_block:
                            processed_para_lines.append(f'<p>{" ".join(current_text_block)}</p>')
                            current_text_block = []
                        processed_para_lines.append(line)
                        continue
                
                # If we're inside an HTML block, continue until we find the closing tag
                if inside_html_block:
                    processed_para_lines.append(line)
                    if line_stripped.endswith(f'</{html_block_tag}>'):
                        inside_html_block = False
                        html_block_tag = None
                    continue
                
                # Check if this line is already a single-line HTML element (including headers)
                if (line_stripped.startswith('<h1>') or line_stripped.startswith('<h2>') or 
                    line_stripped.startswith('<h3>') or line_stripped.startswith('<h4>') or
                    line_stripped.startswith('<h5>') or line_stripped.startswith('<h6>') or
                    line_stripped.startswith('<img') or 
                    line_stripped.startswith('<ul>') or line_stripped.startswith('<li>') or
                    line_stripped.startswith('<strong>') or line_stripped.startswith('<em>') or
                    line_stripped.startswith('<a ') or
                    line_stripped.endswith('</h1>') or line_stripped.endswith('</h2>') or
                    line_stripped.endswith('</h3>') or line_stripped.endswith('</h4>') or
                    line_stripped.endswith('</h5>') or line_stripped.endswith('</h6>') or
                    line_stripped.endswith('</ul>') or line_stripped.endswith('</li>') or
                    '<h1>' in line_stripped or '<h2>' in line_stripped or '<h3>' in line_stripped or
                    '<h4>' in line_stripped or '<h5>' in line_stripped or '<h6>' in line_stripped or
                    (line_stripped.startswith('<video') and line_stripped.endswith('</video>')) or
                    (line_stripped.startswith('<div') and line_stripped.endswith('</div>'))):
                    # If we have accumulated text, wrap it in a paragraph
                    if current_text_block:
                        processed_para_lines.append(f'<p>{" ".join(current_text_block)}</p>')
                        current_text_block = []
                    # Add the HTML element as-is
                    processed_para_lines.append(line)
                else:
                    # Accumulate text lines that aren't HTML elements
                    if line.strip():
                        current_text_block.append(line.strip())
            
            # Handle any remaining text
            if current_text_block:
                processed_para_lines.append(f'<p>{" ".join(current_text_block)}</p>')
            
            html_paragraphs.extend(processed_para_lines)
        else:
            html_paragraphs.append(para)
    
    return '\n'.join(html_paragraphs)

def get_existing_nav_links() -> str:
    """Get navigation links - proper home icon structure"""
    # Use proper home icon structure to match subpages
    nav_links = ['                <li><a href="../index.html" class="home-icon"><span class="house-silhouette"></span></a></li>']
    return '\n'.join(nav_links)

def process_inline_media(content: str, attachments: List[Dict], title: str) -> tuple:
    """Process content to embed media inline in exact 1:1 order from email"""
    if not attachments:
        return content, []
    
    saved_files = []
    processed_content = content
    
    print(f"Processing {len(attachments)} media files for exact 1:1 positioning...")
    
    # Save all attachments and create media HTML in order
    media_html_map = {}
    for i, attachment in enumerate(attachments):
        saved_path = save_attachment(attachment, title)
        if saved_path:
            saved_files.append(saved_path)
            original_filename = attachment['filename']
            content_type = attachment['content_type']
            
            # Create HTML for the media
            if content_type.startswith('image/'):
                alt_text = os.path.basename(original_filename)
                media_html = f'<img src="{saved_path}" alt="{alt_text}">'
            elif content_type.startswith('video/'):
                # Improve video compatibility by using mp4 as primary type and original as fallback
                primary_type = "video/mp4" if content_type == "video/quicktime" else content_type
                media_html = f'''<video controls style="max-width: 100%; height: auto; margin: 10px 0; border-radius: 8px;" preload="metadata">
    <source src="{saved_path}" type="{primary_type}">
    <source src="{saved_path}" type="{content_type}">
    <p>Your browser doesn't support HTML video. <a href="{saved_path}">Download the video</a> instead.</p>
</video>'''
            else:
                continue
            
            # Store media HTML with its index for placeholder replacement
            media_html_map[i] = media_html
    
    # Replace media placeholders with actual HTML (this preserves exact order)
    placeholders_replaced = []
    for i, media_html in media_html_map.items():
        placeholder = f"__MEDIA_PLACEHOLDER_{i}__"
        if placeholder in processed_content:
            processed_content = processed_content.replace(placeholder, media_html)
            placeholders_replaced.append(i)
            print(f"Replaced media placeholder {i} with inline media at exact position")
    
    # Also handle explicit filename references for backwards compatibility (but not for already replaced placeholders)
    for i, attachment in enumerate(attachments):
        if i not in placeholders_replaced:  # Only process if placeholder wasn't already replaced
            original_filename = attachment['filename']
            if i in media_html_map:
                media_html = media_html_map[i]
                
                # Look for explicit references to replace
                patterns_to_replace = [
                    original_filename,  # Direct filename reference
                    f"[{original_filename}]",  # Markdown-style reference
                    f"![{original_filename}]",  # Markdown image reference
                    f"<{original_filename}>",  # Angle bracket reference
                ]
                
                for pattern in patterns_to_replace:
                    if pattern in processed_content:
                        processed_content = processed_content.replace(pattern, media_html)
                        print(f"Replaced '{pattern}' with inline media at exact position")
    
    return processed_content, saved_files

def create_html_page(title: str, content: str, filename: str, attachments: Optional[List[Dict]] = None) -> tuple:
    """Create HTML page with inline media embedded in content, returns (success, saved_files)"""
    try:
        # Process attachments and embed them inline in content
        processed_content, saved_media_files = process_inline_media(content, attachments or [], title)
        
        # Convert content to HTML (this will process the embedded media HTML)
        content_html = markdown_to_html(processed_content)
        
        # Get navigation links
        nav_links = get_existing_nav_links()
        
        # Determine the best image for social media (first image from saved files or default)
        page_image = DEFAULT_IMAGE  # Default fallback
        if saved_media_files:
            # Use the first saved image file
            for file_path in saved_media_files:
                if any(file_path.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.webp', '.gif']):
                    page_image = file_path.replace('../', '')
                    break
        
        # Extract a meaningful description from the content
        description = extract_description(content)
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
        
        # ------------------------------------------------------------------
        # 🆕 Prefer Jinja2 template rendering (overrides legacy string above)
        # ------------------------------------------------------------------
        html_template = render_template(
            'page.html',
            title=title,
            description=description,
            page_image=page_image,
            filename=filename,
            nav_links=nav_links,
            content_html=content_html,
            responsive_css=responsive_css,
            created_at=datetime.now().strftime('%B %d, %Y')
        )
        
        # Write to Pages directory
        pages_dir = PAGES_DIR
        if not os.path.exists(pages_dir):
            os.makedirs(pages_dir)
        
        filepath = os.path.join(pages_dir, filename)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(html_template)
        
        print(f"Successfully created: {filepath}")
        if saved_media_files:
            print(f"Saved {len(saved_media_files)} media files: {', '.join(os.path.basename(f) for f in saved_media_files)}")
        
        return True, saved_media_files
        
    except Exception as e:
        print(f"Error creating HTML page: {e}")
        return False, []

def update_main_index_navigation():
    """Update navigation in main index.html - restore proper home icon"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Proper home icon structure for main navigation
        home_nav_links = '                <li><a href="index.html" class="home-icon"><span class="house-silhouette"></span></a></li>'
        
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

def add_research_tile(title: str, description: str, filename: str, tile_image: Optional[str] = None):
    """Add a new tile to the Research section on the home page (newest first)"""
    try:
        index_path = "../index.html"
        if not os.path.exists(index_path):
            print(f"Warning: Index file not found at {index_path}")
            return False
        
        # Read current index.html
        with open(index_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Check if tile already exists
        if f'href="Pages/{filename}"' in content:
            print(f"Updating existing tile for '{title}'")
            # Remove the existing tile first
            remove_research_tile(filename, title)
            # Re-read content after removal
            with open(index_path, 'r', encoding='utf-8') as f:
                content = f.read()
        
        # Clean description - remove any media placeholders
        if description:
            description = re.sub(r'__MEDIA_PLACEHOLDER_\d+__', '', description).strip()
        else:
            description = f"Learn about {title} in Cody's portfolio"
        
        # Set default image if none provided
        if not tile_image:
            tile_image = DEFAULT_IMAGE  # Default fallback image
        
        # Prepare new tile HTML
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
                
            print(f"Successfully added research tile for: {title}")
            return True
        else:
            print("DEBUG: Could not find project container div")
            print("Could not find insertion point for tile")
            return False
                
    except Exception as e:
        print(f"Error adding research tile: {e}")
        return False

def commit_and_push_changes(filename: str, title: str, media_files: Optional[List[str]] = None) -> bool:
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
        
        # Add index.html if it was modified (for research tiles)
        result = subprocess.run([
            'git', 'add', 'index.html'
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git add index.html failed: {result.stderr}")
            # Continue anyway, this is not critical
        
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

def delete_page_and_tile(page_identifier: str) -> bool:
    """Delete a page and its corresponding tile from the home page"""
    try:
        # Determine if identifier is a title or filename
        if page_identifier.endswith('.html'):
            # It's a filename
            filename = page_identifier
            # Try to extract title from the file
            page_path = f"../Pages/{filename}"
            title = None
            if os.path.exists(page_path):
                with open(page_path, 'r', encoding='utf-8') as f:
                    content = f.read()
                    # Extract title from HTML
                    title_match = re.search(r'<title>([^<]+)</title>', content)
                    if title_match:
                        title = title_match.group(1).strip()
        else:
            # It's a title, generate filename
            title = page_identifier
            filename = sanitize_filename(title)
            if not filename.endswith('.html'):
                filename += '.html'
        
        page_path = f"../Pages/{filename}"
        
        # Check if page exists
        if not os.path.exists(page_path):
            print(f"Page not found: {page_path}")
            return False
        
        # Delete the page file
        os.remove(page_path)
        print(f"Deleted page: {filename}")
        
        # Remove tile from home page
        success = remove_research_tile(filename, title)
        if success:
            print(f"Removed tile from home page")
        else:
            print(f"Warning: Could not remove tile from home page")
        
        return True
        
    except Exception as e:
        print(f"Error deleting page and tile: {e}")
        return False

def remove_research_tile(filename: str, title: Optional[str] = None) -> bool:
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
        tile_pattern = rf'<div class="project">\s*<img[^>]*>\s*<h3>[^<]*</h3>\s*<p>[^<]*</p>\s*<a href="Pages/{re.escape(filename)}"[^>]*>Read On\.\.\.</a>\s*</div>'
        
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

def is_delete_command(subject: str, content: str) -> tuple[bool, str]:
    """
    ENHANCED SAFE Delete Command Detection
    
    Requirements for deletion to prevent accidents:
    1. Must be EXACTLY in subject line (not content) - reduces false positives
    2. Must start with [DELETE] (case insensitive) - stronger pattern
    3. Must include "CONFIRM" keyword - explicit confirmation required
    4. Subject must match pattern: [DELETE CONFIRM] <page_identifier>
    
    This prevents accidental deletions from:
    - Regular email content mentioning "delete" 
    - Casual subject lines like "del old stuff"
    - Email forwards/replies containing delete-like text
    """
    try:
        if not subject or not subject.strip():
            return False, ""
        
        subject_clean = subject.strip()
        
        # STRICT PATTERN: Must be exact format with CONFIRM keyword
        # Pattern: [DELETE CONFIRM] page_identifier
        delete_pattern = re.compile(r'^\[DELETE\s+CONFIRM\]\s*(.+)$', re.IGNORECASE)
        
        match = delete_pattern.match(subject_clean)
        if match:
            page_identifier = match.group(1).strip()
            if page_identifier:  # Ensure we have something to delete
                logger.info(f"🚨 SAFE DELETE COMMAND CONFIRMED: '{page_identifier}'")
                logger.info(f"📧 Subject: {subject}")
                return True, page_identifier
        
        # Log potential unsafe delete attempts for monitoring
        unsafe_patterns = [
            r'\[del\]', r'del:', r'delete:', r'\[delete\]', 
            r'remove:', r'\[remove\]', r'rm '
        ]
        
        subject_lower = subject.lower()
        for pattern in unsafe_patterns:
            if re.search(pattern, subject_lower):
                logger.warning(f"⚠️  UNSAFE DELETE PATTERN DETECTED (IGNORED): '{subject}'")
                logger.warning("ℹ️  To delete pages, use format: [DELETE CONFIRM] page_name")
                break
        
        return False, ""
        
    except Exception as e:
        logger.error(f"Error checking delete command: {e}")
        return False, ""

def commit_delete_changes(filename: str, title: str) -> bool:
    """Commit and push page deletion to GitHub"""
    try:
        # Change to the main directory (parent of MCP)
        main_dir = ".."
        
        # Remove the deleted page file from git
        result = subprocess.run([
            'git', 'rm', f'Pages/{filename}'
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git rm page failed: {result.stderr}")
            return False
        
        # Add updated index.html (for tile removal)
        result = subprocess.run([
            'git', 'add', 'index.html'
        ], cwd=main_dir, capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"Git add index.html failed: {result.stderr}")
            return False
        
        # Commit the changes
        commit_message = f"Delete page: {title or filename}\n\nAutomatically deleted via email command\nRemoved page and corresponding home page tile"
            
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
        
        print(f"Successfully pushed deletion of '{title or filename}' to GitHub!")
        return True
        
    except Exception as e:
        print(f"Error with git operations: {e}")
        return False

def process_email_to_page(email_content: str) -> bool:
    """Process email content - either create web page or delete existing page"""
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
                
                # Check if we're running in GitHub Actions
                is_github_actions = os.getenv('GITHUB_ACTIONS') == 'true'
                
                if is_github_actions:
                    # In GitHub Actions, let the workflow handle git operations
                    print(f"✅ Successfully deleted '{page_identifier}' (GitHub Actions will handle git operations)")
                    return True
                else:
                    # Local execution - handle git operations ourselves
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
        
        # Create HTML page with attachments
        success, saved_media_files = create_html_page(parsed["title"], parsed["content"], filename, parsed.get("attachments"))
        
        if success:
            
            # Update navigation
            update_main_index_navigation()
            
            # Always add research tile to home page (FIXED: no longer conditional on description)
            description = parsed.get("description", "")
            if not description:
                # Auto-generate description from content if not provided
                description = generate_description_from_content(parsed["content"], parsed["title"])
            
            # Find the first image in the email body order (not just first in attachments)
            tile_image = DEFAULT_IMAGE  # Default fallback image
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
                            for saved_file in saved_media_files:
                                base_saved_file = os.path.basename(saved_file)
                                print(f"DEBUG: Checking saved file: {base_saved_file}")
                                
                                if base_saved_file == expected_filename:
                                    tile_image = saved_file.replace('../', '')
                                    print(f"DEBUG: MATCH! Setting tile image to: {tile_image}")
                                    break
                            
                            # If we didn't find an exact match, check for partial filename matches
                            if not tile_image:
                                for saved_file in saved_media_files:
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
            if not tile_image and saved_media_files:
                for saved_file in saved_media_files:
                    if any(saved_file.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
                        tile_image = saved_file.replace('../', '')
                        print(f"DEBUG: Using first saved image file: {tile_image}")
                        break
            
            # ALWAYS create the tile (this was the main bug - tiles only created with [Description])
            add_research_tile(parsed["title"], description, filename, tile_image)
            print(f"✅ Research tile added to home page: {parsed['title']} - {description}")
            
            # Check if we're running in GitHub Actions
            is_github_actions = os.getenv('GITHUB_ACTIONS') == 'true'
            
            if is_github_actions:
                # In GitHub Actions, let the workflow handle git operations
                print(f"✅ Page '{parsed['title']}' created successfully (GitHub Actions will handle git operations)")
                print(f"File: Pages/{filename}")
                if saved_media_files:
                    print(f"Media files: {', '.join(os.path.basename(f) for f in saved_media_files)}")
                if description:
                    print(f"Research tile added to home page with description: {description}")
                print(f"Will be live at: https://cyohn55.github.io/Portfolio/Pages/{filename}")
                return True
            else:
                # Local execution - handle git operations ourselves
                if commit_and_push_changes(filename, parsed["title"], saved_media_files):
                    print(f"Page '{parsed['title']}' created and pushed to GitHub successfully!")
                    print(f"File: Pages/{filename}")
                    if saved_media_files:
                        print(f"Media files: {', '.join(os.path.basename(f) for f in saved_media_files)}")
                    if description:
                        print(f"Research tile added to home page with description: {description}")
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