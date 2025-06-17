# GitHub Portfolio MCP Server

A simple MCP (Model Context Protocol) server for managing your portfolio website on GitHub.

## Installation

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the server:
   ```bash
   python server.py
   ```

## Available Tools

### `git_status`
Check the current status of your Git repository.

### `git_add`
Stage all changes for commit.

### `git_commit`
Commit staged changes with a message.
- **message** (required): Commit message describing your changes

### `git_push`
Push changes to GitHub.
- **branch** (optional): Branch to push to (default: main)

### `setup_github_pages`
Set up GitHub Pages deployment.
- **remote_url** (required): Your GitHub repository URL (e.g., https://github.com/username/repo.git)

### `validate_files`
Check if all portfolio files exist in the current directory.

## Usage Example

1. **Check current status**:
   ```json
   {"name": "git_status", "arguments": {}}
   ```

2. **Stage changes**:
   ```json
   {"name": "git_add", "arguments": {}}
   ```

3. **Commit changes**:
   ```json
   {"name": "git_commit", "arguments": {"message": "Update portfolio"}}
   ```

4. **Push to GitHub**:
   ```json
   {"name": "git_push", "arguments": {"branch": "main"}}
   ```

5. **Set up GitHub Pages**:
   ```json
   {"name": "setup_github_pages", "arguments": {"remote_url": "https://github.com/yourusername/portfolio.git"}}
   ```

## Requirements

- Python 3.7+
- Git installed and configured
- GitHub repository set up
- MCP package installed

## Notes

- Make sure you have Git configured with your GitHub credentials
- The server runs in the current directory
- GitHub Pages will be deployed from the `gh-pages` branch 