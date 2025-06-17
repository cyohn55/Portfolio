#!/usr/bin/env python3
"""
Simple GitHub Portfolio MCP Server
Provides basic tools for managing portfolio website on GitHub
"""

import asyncio
import os
import subprocess
from typing import Any, Dict, List

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