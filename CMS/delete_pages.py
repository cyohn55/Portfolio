#!/usr/bin/env python3
"""
Delete specified pages and their tiles, then commit to Git
"""

import sys
import os

# Add the CMS directory to the path so we can import the functions
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from simple_email_processor import delete_page_and_tile, commit_delete_changes

def main():
    """Delete emailtest.html and testing.html pages and tiles"""
    pages_to_delete = [
        "emailtest.html",
        "testing.html"
    ]
    
    deleted_pages = []
    
    for page in pages_to_delete:
        print(f"\n=== Deleting {page} ===")
        
        if delete_page_and_tile(page):
            print(f"✅ Successfully deleted {page} and its tile")
            deleted_pages.append(page)
        else:
            print(f"❌ Failed to delete {page}")
    
    if deleted_pages:
        print(f"\n=== Committing changes to Git ===")
        
        # For Git operations, we need to handle both files together
        # First, let's manually handle the git operations since the function is for single files
        
        import subprocess
        
        try:
            # Remove the deleted page files from git (if they exist in git)
            for page in deleted_pages:
                result = subprocess.run([
                    'git', 'rm', f'Pages/{page}'
                ], capture_output=True, text=True)
                
                if result.returncode == 0:
                    print(f"✅ Removed {page} from git")
                else:
                    print(f"ℹ️  {page} was not in git or already removed")
            
            # Add updated index.html (for tile removal)
            result = subprocess.run([
                'git', 'add', 'index.html'
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Git add index.html failed: {result.stderr}")
                return False
            
            # Also add any media files that might need to be removed
            result = subprocess.run([
                'git', 'add', '-A'
            ], capture_output=True, text=True)
            
            # Commit the changes
            commit_message = f"🗑️ Delete pages: {', '.join(deleted_pages)}\n\nAutomatically deleted pages and corresponding home page tiles:\n" + "\n".join([f"- {page}" for page in deleted_pages])
                
            result = subprocess.run([
                'git', 'commit', '-m', commit_message
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Git commit failed: {result.stderr}")
                return False
            
            print("✅ Changes committed successfully")
            
            # Push to GitHub
            result = subprocess.run([
                'git', 'push'
            ], capture_output=True, text=True)
            
            if result.returncode != 0:
                print(f"❌ Git push failed: {result.stderr}")
                return False
            
            print("✅ Successfully pushed page deletions to GitHub!")
            print(f"\n🎉 Deleted pages: {', '.join(deleted_pages)}")
            return True
            
        except Exception as e:
            print(f"❌ Error with git operations: {e}")
            return False
    else:
        print("\n❌ No pages were successfully deleted")
        return False

if __name__ == "__main__":
    main() 