#!/usr/bin/env python3
"""
Test Git Operations
Debug script to test git operations that might be failing in GitHub Actions
"""

import subprocess
import os
import sys

def test_git_operations():
    """Test git operations to identify issues"""
    print("🔧 Testing Git Operations...")
    print("=" * 60)
    
    # Test current directory
    print(f"Current directory: {os.getcwd()}")
    
    # Test if we're in a git repo
    try:
        result = subprocess.run(['git', 'status'], capture_output=True, text=True, cwd="..")
        print(f"Git status (return code {result.returncode}):")
        if result.returncode == 0:
            print("✅ Git repository detected")
            print(f"Status output: {result.stdout[:200]}...")
        else:
            print("❌ Git status failed")
            print(f"Error: {result.stderr}")
    except Exception as e:
        print(f"❌ Git status exception: {e}")
    
    print("-" * 60)
    
    # Test git config
    try:
        result = subprocess.run(['git', 'config', 'user.name'], capture_output=True, text=True, cwd="..")
        print(f"Git user.name: {result.stdout.strip() if result.returncode == 0 else 'Not set'}")
        
        result = subprocess.run(['git', 'config', 'user.email'], capture_output=True, text=True, cwd="..")
        print(f"Git user.email: {result.stdout.strip() if result.returncode == 0 else 'Not set'}")
    except Exception as e:
        print(f"❌ Git config exception: {e}")
    
    print("-" * 60)
    
    # Test creating a dummy file and adding it
    test_file = "../test_git_operations.txt"
    try:
        # Create test file
        with open(test_file, 'w') as f:
            f.write("Test file for git operations")
        print("✅ Created test file")
        
        # Test git add
        result = subprocess.run(['git', 'add', 'test_git_operations.txt'], 
                              capture_output=True, text=True, cwd="..")
        if result.returncode == 0:
            print("✅ Git add successful")
        else:
            print(f"❌ Git add failed: {result.stderr}")
        
        # Test git status after add
        result = subprocess.run(['git', 'status', '--porcelain'], 
                              capture_output=True, text=True, cwd="..")
        if result.returncode == 0:
            print(f"Git status after add: {result.stdout.strip()}")
        
        # Clean up - remove from staging
        subprocess.run(['git', 'reset', 'HEAD', 'test_git_operations.txt'], 
                      capture_output=True, text=True, cwd="..")
        os.remove(test_file)
        print("✅ Cleaned up test file")
        
    except Exception as e:
        print(f"❌ Test file operations failed: {e}")
        # Try to clean up anyway
        try:
            if os.path.exists(test_file):
                os.remove(test_file)
        except:
            pass
    
    print("-" * 60)
    
    # Test the specific paths used by commit_and_push_changes
    test_paths = [
        "../Pages/",
        "../index.html",
        "../images/"
    ]
    
    for path in test_paths:
        if os.path.exists(path):
            print(f"✅ Path exists: {path}")
        else:
            print(f"❌ Path missing: {path}")
    
    print("-" * 60)
    
    # Test git remote
    try:
        result = subprocess.run(['git', 'remote', '-v'], capture_output=True, text=True, cwd="..")
        if result.returncode == 0:
            print("Git remotes:")
            print(result.stdout)
        else:
            print(f"❌ Git remote failed: {result.stderr}")
    except Exception as e:
        print(f"❌ Git remote exception: {e}")

def test_commit_and_push_simulation():
    """Simulate the commit_and_push_changes function to find issues"""
    print("\n🧪 Simulating commit_and_push_changes function...")
    print("=" * 60)
    
    # Simulate the exact steps from the function
    main_dir = ".."
    filename = "test.html"
    title = "Test Page"
    
    print(f"Working directory: {main_dir}")
    print(f"Test filename: {filename}")
    
    # Test each git command individually
    commands = [
        (['git', 'add', f'Pages/{filename}'], f"Add Pages/{filename}"),
        (['git', 'add', 'index.html'], "Add index.html"),
        (['git', 'status', '--porcelain'], "Check status"),
    ]
    
    for cmd, description in commands:
        try:
            result = subprocess.run(cmd, cwd=main_dir, capture_output=True, text=True)
            print(f"{description}: Return code {result.returncode}")
            if result.returncode != 0:
                print(f"  ❌ STDERR: {result.stderr}")
            else:
                print(f"  ✅ Success")
                if result.stdout.strip():
                    print(f"  Output: {result.stdout.strip()}")
        except Exception as e:
            print(f"  ❌ Exception: {e}")

if __name__ == "__main__":
    test_git_operations()
    test_commit_and_push_simulation() 