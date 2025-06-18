#!/usr/bin/env python3
"""
Simple GitHub Portfolio MCP Server
Provides basic tools for managing portfolio website on GitHub
"""

import asyncio
import os
import subprocess
import re
import html
from typing import Any, Dict, List
from datetime import datetime

import mcp.server
import mcp.server.stdio
from mcp.server import NotificationOptions
from mcp.server.models import InitializationOptions
from mcp.types import (
    CallToolResult,
    ListToolsResult,
    Tool,
    TextContent,
    ServerCapabilities,
)

# Initialize the server
server = mcp.server.Server("github-portfolio-mcp")

def run_git_command(command: List[str], cwd: str = None) -> Dict[str, Any]:
    """Run a git command and return the result"""
    try:
        result = subprocess.run(
            command,
            cwd=cwd or os.getcwd(),
            capture_output=True,
            text=True,
            check=True
        )
        return {
            "success": True,
            "stdout": result.stdout.strip(),
            "stderr": result.stderr.strip()
        }
    except subprocess.CalledProcessError as e:
        return {
            "success": False,
            "stdout": e.stdout.strip() if e.stdout else "",
            "stderr": e.stderr.strip() if e.stderr else ""
        }

def sanitize_filename(title: str) -> str:
    """Convert page title to a safe filename"""
    # Remove special characters and convert to lowercase
    filename = re.sub(r'[^a-zA-Z0-9\s-]', '', title)
    filename = filename.lower().replace(' ', '')
    return filename

def generate_html_template(title: str, content: str) -> str:
    """Generate HTML page with proper structure"""
    # Escape HTML content to prevent injection
    safe_content = html.escape(content)
    
    # Convert markdown-style headers to HTML
    content_html = re.sub(r'^### (.*?)$', r'<h3>\1</h3>', safe_content, flags=re.MULTILINE)
    content_html = re.sub(r'^## (.*?)$', r'<h2>\1</h2>', content_html, flags=re.MULTILINE)
    content_html = re.sub(r'^# (.*?)$', r'<h1>\1</h1>', content_html, flags=re.MULTILINE)
    
    # Convert line breaks to paragraphs
    content_html = re.sub(r'\n\n+', '</p><p>', content_html)
    content_html = f'<p>{content_html}</p>'
    
    # Get current navigation links
    nav_links = get_navigation_links()
    
    html_template = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
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
            {content_html}
        </div>
    </div>

    <footer>
        <p>&copy; 2025 Cody Yohn. All rights reserved.</p>
    </footer>
    <script src="../script.js"></script>
</body>
</html>"""
    
    return html_template

def get_navigation_links() -> str:
    """Get current navigation links from existing pages"""
    pages_dir = "Pages"
    if not os.path.exists(pages_dir):
        return ""
    
    nav_links = []
    nav_links.append('                <li><a href="index.html">Home</a></li>')
    
    # Get all HTML files in Pages directory
    for filename in os.listdir(pages_dir):
        if filename.endswith('.html') and filename != 'index.html':
            # Convert filename to display name
            display_name = filename.replace('.html', '').replace('-', ' ').title()
            nav_links.append(f'                <li><a href="{filename}">{display_name}</a></li>')
    
    return '\n'.join(nav_links)

def update_all_navigation() -> None:
    """Update navigation in all HTML files"""
    pages_dir = "Pages"
    if not os.path.exists(pages_dir):
        return
    
    nav_links = get_navigation_links()
    
    # Update each HTML file
    for filename in os.listdir(pages_dir):
        if filename.endswith('.html'):
            filepath = os.path.join(pages_dir, filename)
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    content = f.read()
                
                # Replace navigation section
                nav_pattern = r'<nav>\s*<ul>.*?</ul>\s*</nav>'
                new_nav = f'<nav>\n            <ul>\n{nav_links}\n            </ul>\n        </nav>'
                
                updated_content = re.sub(nav_pattern, new_nav, content, flags=re.DOTALL)
                
                with open(filepath, 'w', encoding='utf-8') as f:
                    f.write(updated_content)
                    
            except Exception as e:
                print(f"Error updating navigation in {filename}: {e}")

@server.list_tools()
async def handle_list_tools() -> ListToolsResult:
    """List all available tools"""
    tools = [
        Tool(
            name="git_status",
            description="Check the current status of the Git repository",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="git_add",
            description="Stage all changes for commit",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="git_commit",
            description="Commit staged changes with a message",
            inputSchema={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Commit message"
                    }
                },
                "required": ["message"]
            }
        ),
        Tool(
            name="git_push",
            description="Push changes to GitHub",
            inputSchema={
                "type": "object",
                "properties": {
                    "branch": {
                        "type": "string",
                        "description": "Branch to push to (default: main)"
                    }
                },
                "required": []
            }
        ),
        Tool(
            name="setup_github_pages",
            description="Set up GitHub Pages deployment",
            inputSchema={
                "type": "object",
                "properties": {
                    "remote_url": {
                        "type": "string",
                        "description": "GitHub repository URL"
                    }
                },
                "required": ["remote_url"]
            }
        ),
        Tool(
            name="validate_files",
            description="Check if all portfolio files exist",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        ),
        Tool(
            name="create_page_from_email",
            description="Create a new HTML page from email content",
            inputSchema={
                "type": "object",
                "properties": {
                    "title": {
                        "type": "string",
                        "description": "Page title"
                    },
                    "content": {
                        "type": "string",
                        "description": "Page content (supports markdown-style headers)"
                    }
                },
                "required": ["title", "content"]
            }
        ),
        Tool(
            name="update_page_from_email",
            description="Update existing page from email content",
            inputSchema={
                "type": "object",
                "properties": {
                    "page_name": {
                        "type": "string",
                        "description": "Name of the page to update (without .html extension)"
                    },
                    "content": {
                        "type": "string",
                        "description": "New page content"
                    }
                },
                "required": ["page_name", "content"]
            }
        ),
        Tool(
            name="list_pages",
            description="List all pages in the Pages directory",
            inputSchema={
                "type": "object",
                "properties": {},
                "required": []
            }
        )
    ]
    return ListToolsResult(tools=tools)

@server.call_tool()
async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> CallToolResult:
    """Handle tool calls"""
    try:
        if name == "git_status":
            return await git_status()
        elif name == "git_add":
            return await git_add()
        elif name == "git_commit":
            return await git_commit(arguments)
        elif name == "git_push":
            return await git_push(arguments)
        elif name == "setup_github_pages":
            return await setup_github_pages(arguments)
        elif name == "validate_files":
            return await validate_files()
        elif name == "create_page_from_email":
            return await create_page_from_email(arguments)
        elif name == "update_page_from_email":
            return await update_page_from_email(arguments)
        elif name == "list_pages":
            return await list_pages()
        else:
            return CallToolResult(
                content=[
                    TextContent(
                        text=f"Error: Unknown tool '{name}'"
                    )
                ]
            )
    except Exception as e:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error executing {name}: {str(e)}"
                )
            ]
        )

async def git_status() -> CallToolResult:
    """Check git repository status"""
    result = run_git_command(["git", "status"])
    
    if not result["success"]:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error checking git status: {result['stderr']}"
                )
            ]
        )
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"Git Status:\n{result['stdout']}"
            )
        ]
    )

async def git_add() -> CallToolResult:
    """Stage all changes"""
    result = run_git_command(["git", "add", "."])
    
    if not result["success"]:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error staging changes: {result['stderr']}"
                )
            ]
        )
    
    return CallToolResult(
        content=[
            TextContent(
                text="All changes staged successfully."
            )
        ]
    )

async def git_commit(arguments: Dict[str, Any]) -> CallToolResult:
    """Commit staged changes"""
    message = arguments["message"]
    result = run_git_command(["git", "commit", "-m", message])
    
    if not result["success"]:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error committing changes: {result['stderr']}"
                )
            ]
        )
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"Changes committed successfully: {message}"
            )
        ]
    )

async def git_push(arguments: Dict[str, Any]) -> CallToolResult:
    """Push changes to GitHub"""
    branch = arguments.get("branch", "main")
    result = run_git_command(["git", "push", "origin", branch])
    
    if not result["success"]:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error pushing to GitHub: {result['stderr']}"
                )
            ]
        )
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"Successfully pushed to GitHub {branch} branch."
            )
        ]
    )

async def setup_github_pages(arguments: Dict[str, Any]) -> CallToolResult:
    """Set up GitHub Pages deployment"""
    remote_url = arguments["remote_url"]
    
    # Set remote URL
    result = run_git_command(["git", "remote", "set-url", "origin", remote_url])
    if not result["success"]:
        # Try adding remote if it doesn't exist
        result = run_git_command(["git", "remote", "add", "origin", remote_url])
        if not result["success"]:
            return CallToolResult(
                content=[
                    TextContent(
                        text=f"Error setting remote URL: {result['stderr']}"
                    )
                ]
            )
    
    # Create gh-pages branch
    result = run_git_command(["git", "checkout", "-b", "gh-pages"])
    if not result["success"]:
        # Branch might already exist, try to switch to it
        result = run_git_command(["git", "checkout", "gh-pages"])
        if not result["success"]:
            return CallToolResult(
                content=[
                    TextContent(
                        text=f"Error creating/switching to gh-pages branch: {result['stderr']}"
                    )
                ]
            )
    
    # Push to gh-pages branch
    push_result = run_git_command(["git", "push", "origin", "gh-pages"])
    if not push_result["success"]:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error pushing to gh-pages: {push_result['stderr']}"
                )
            ]
        )
    
    # Switch back to main branch
    run_git_command(["git", "checkout", "main"])
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"GitHub Pages setup complete!\nRemote URL: {remote_url}\nPlease enable GitHub Pages in your repository settings."
            )
        ]
    )

async def validate_files() -> CallToolResult:
    """Check if all portfolio files exist"""
    required_files = [
        "index.html",
        "style.css", 
        "script.js",
        "bouncingball.html",
        "codeexample.html",
        "webperformance.html",
        "hardwarearchitecture.html",
        "database.html",
        "algorithms.html"
    ]
    
    missing_files = []
    existing_files = []
    
    for file in required_files:
        if os.path.exists(file):
            existing_files.append(file)
        else:
            missing_files.append(file)
    
    if missing_files:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Validation Results:\n\nMissing files:\n" + "\n".join(missing_files) + 
                         f"\n\nExisting files ({len(existing_files)}):\n" + "\n".join(existing_files)
                )
            ]
        )
    else:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"All portfolio files are present! ({len(existing_files)} files found)"
                )
            ]
        )

async def create_page_from_email(arguments: Dict[str, Any]) -> CallToolResult:
    """Create a new HTML page from email content"""
    title = arguments["title"]
    content = arguments["content"]
    
    filename = sanitize_filename(title) + ".html"
    filepath = os.path.join("Pages", filename)
    
    if os.path.exists(filepath):
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error: Page '{title}' already exists."
                )
            ]
        )
    
    html_template = generate_html_template(title, content)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(html_template)
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"Page '{title}' created successfully!"
            )
        ]
    )

async def update_page_from_email(arguments: Dict[str, Any]) -> CallToolResult:
    """Update existing page from email content"""
    page_name = arguments["page_name"]
    content = arguments["content"]
    
    filename = sanitize_filename(page_name) + ".html"
    filepath = os.path.join("Pages", filename)
    
    if not os.path.exists(filepath):
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Error: Page '{page_name}' does not exist."
                )
            ]
        )
    
    html_template = generate_html_template(page_name, content)
    
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(html_template)
    
    return CallToolResult(
        content=[
            TextContent(
                text=f"Page '{page_name}' updated successfully!"
            )
        ]
    )

async def list_pages() -> CallToolResult:
    """List all pages in the Pages directory"""
    pages_dir = "Pages"
    if not os.path.exists(pages_dir):
        return CallToolResult(
            content=[
                TextContent(
                    text="No pages found in the Pages directory."
                )
            ]
        )
    
    pages = []
    for filename in os.listdir(pages_dir):
        if filename.endswith('.html'):
            pages.append(filename.replace('.html', ''))
    
    if not pages:
        return CallToolResult(
            content=[
                TextContent(
                    text="No pages found in the Pages directory."
                )
            ]
        )
    else:
        return CallToolResult(
            content=[
                TextContent(
                    text=f"Pages in the Pages directory:\n" + "\n".join(pages)
                )
            ]
        )

async def main():
    """Main function to run the MCP server"""
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="github-portfolio-mcp",
                server_version="1.0.0",
                capabilities=ServerCapabilities(
                    notifications=NotificationOptions()
                )
            )
        )

if __name__ == "__main__":
    asyncio.run(main()) 