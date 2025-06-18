#!/usr/bin/env python3
"""
Email Processor for Portfolio MCP Server
Processes email content and creates/updates portfolio pages
"""

import re
import json
import subprocess
import sys
from typing import Dict, Any, Optional

def parse_email_content(email_text: str) -> Dict[str, Any]:
    """Parse email content to extract title and content"""
    lines = email_text.strip().split('\n')
    
    # Extract subject/title from first line or subject line
    title = ""
    content_lines = []
    
    for line in lines:
        line = line.strip()
        if not line:
            continue
            
        # Look for subject patterns
        if line.lower().startswith('subject:') or line.lower().startswith('title:'):
            title = line.split(':', 1)[1].strip()
        elif line.lower().startswith('new page:') or line.lower().startswith('create page:'):
            title = line.split(':', 1)[1].strip()
        elif not title and line and not line.startswith('#'):
            # Use first non-empty line as title if no subject found
            title = line
        else:
            content_lines.append(line)
    
    # If no title found, use a default
    if not title:
        title = "New Page"
    
    # Join content lines
    content = '\n'.join(content_lines).strip()
    
    return {
        "title": title,
        "content": content
    }

def call_mcp_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Call MCP server tool via command line"""
    try:
        # Create a simple JSON request
        request = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            }
        }
        
        # For now, we'll use a simpler approach with direct function calls
        # In a real implementation, you'd communicate with the MCP server
        
        # Simulate the call by running the server and passing arguments
        cmd = [
            sys.executable, "server.py", 
            "--tool", tool_name,
            "--args", json.dumps(arguments)
        ]
        
        result = subprocess.run(
            cmd,
            cwd=".",
            capture_output=True,
            text=True
        )
        
        if result.returncode == 0:
            return {"success": True, "output": result.stdout}
        else:
            return {"success": False, "error": result.stderr}
            
    except Exception as e:
        return {"success": False, "error": str(e)}

def process_email(email_content: str, action: str = "create") -> Dict[str, Any]:
    """Process email content and create/update page"""
    
    # Parse email content
    parsed = parse_email_content(email_content)
    
    if action == "create":
        # Create new page
        result = call_mcp_tool("create_page_from_email", {
            "title": parsed["title"],
            "content": parsed["content"]
        })
        
        if result["success"]:
            # Update navigation in all files
            call_mcp_tool("update_all_navigation", {})
            
            # Stage and commit changes
            call_mcp_tool("git_add", {})
            call_mcp_tool("git_commit", {
                "message": f"Add new page: {parsed['title']}"
            })
            call_mcp_tool("git_push", {})
            
        return result
        
    elif action == "update":
        # Update existing page
        page_name = parsed["title"].lower().replace(' ', '')
        result = call_mcp_tool("update_page_from_email", {
            "page_name": page_name,
            "content": parsed["content"]
        })
        
        if result["success"]:
            # Stage and commit changes
            call_mcp_tool("git_add", {})
            call_mcp_tool("git_commit", {
                "message": f"Update page: {parsed['title']}"
            })
            call_mcp_tool("git_push", {})
            
        return result
    
    return {"success": False, "error": f"Unknown action: {action}"}

def main():
    """Main function for command line usage"""
    if len(sys.argv) < 3:
        print("Usage: python email_processor.py <action> <email_file>")
        print("Actions: create, update")
        print("Example: python email_processor.py create email.txt")
        sys.exit(1)
    
    action = sys.argv[1]
    email_file = sys.argv[2]
    
    try:
        with open(email_file, 'r', encoding='utf-8') as f:
            email_content = f.read()
        
        result = process_email(email_content, action)
        
        if result["success"]:
            print("✅ Success!")
            print(result.get("output", "Page processed successfully"))
        else:
            print("❌ Error:")
            print(result.get("error", "Unknown error"))
            sys.exit(1)
            
    except FileNotFoundError:
        print(f"❌ Error: Email file '{email_file}' not found")
        sys.exit(1)
    except Exception as e:
        print(f"❌ Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main() 