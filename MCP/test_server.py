#!/usr/bin/env python3
"""
Simple test script to verify the MCP server is working
"""

import subprocess
import sys
import time

def test_git_status():
    """Test if git is available and working"""
    try:
        result = subprocess.run(["git", "--version"], capture_output=True, text=True)
        if result.returncode == 0:
            print(f"✓ Git is available: {result.stdout.strip()}")
            return True
        else:
            print("✗ Git is not working properly")
            return False
    except FileNotFoundError:
        print("✗ Git is not installed or not in PATH")
        return False

def test_mcp_imports():
    """Test if MCP imports work"""
    try:
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
        print("✓ All MCP imports successful")
        return True
    except ImportError as e:
        print(f"✗ MCP import error: {e}")
        return False

def test_portfolio_files():
    """Test if portfolio files exist"""
    import os
    
    required_files = [
        "../index.html",
        "../style.css", 
        "../script.js",
        "../bouncingball.html",
        "../codeexample.html",
        "../webperformance.html",
        "../hardwarearchitecture.html",
        "../database.html",
        "../algorithms.html"
    ]
    
    missing_files = []
    existing_files = []
    
    for file in required_files:
        if os.path.exists(file):
            existing_files.append(file)
        else:
            missing_files.append(file)
    
    print(f"✓ Found {len(existing_files)} portfolio files")
    if missing_files:
        print(f"✗ Missing {len(missing_files)} files: {', '.join(missing_files)}")
        return False
    else:
        print("✓ All portfolio files present")
        return True

def main():
    """Run all tests"""
    print("GitHub Portfolio MCP Server - System Check")
    print("=" * 40)
    
    tests = [
        ("Git Installation", test_git_status),
        ("MCP Dependencies", test_mcp_imports),
        ("Portfolio Files", test_portfolio_files),
    ]
    
    all_passed = True
    
    for test_name, test_func in tests:
        print(f"\n{test_name}:")
        if test_func():
            print("  ✓ PASSED")
        else:
            print("  ✗ FAILED")
            all_passed = False
    
    print("\n" + "=" * 40)
    if all_passed:
        print("✓ All tests passed! Your MCP server should work correctly.")
        print("\nTo start the server:")
        print("  python server.py")
        print("\nThe server will run silently and wait for MCP client connections.")
    else:
        print("✗ Some tests failed. Please fix the issues before running the server.")
    
    return all_passed

if __name__ == "__main__":
    main() 