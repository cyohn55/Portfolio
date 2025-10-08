# GitHub MCP Server Setup for Cursor

## Quick Setup for Cursor IDE

### Method 1: Using Cursor Settings UI

1. **Open Cursor Settings**
   - Press `Ctrl+,` (Windows/Linux) or `Cmd+,` (Mac)
   - Or: Click gear icon → Settings

2. **Navigate to MCP Servers**
   - Search for "MCP" in settings
   - Find "MCP Servers" section

3. **Add GitHub MCP Server**
   - Click "Add MCP Server" or "Edit in settings.json"
   - Add the configuration below

### Method 2: Direct Configuration File

1. **Open Cursor Config**
   - Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
   - Type: "Preferences: Open User Settings (JSON)"

2. **Add MCP Configuration**

Add this to your Cursor `settings.json`:

```json
{
  "mcp.servers": {
    "github-portfolio": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "description": "GitHub MCP for Portfolio repository",
      "toolsets": [
        "context",
        "issues",
        "pull_requests",
        "repository"
      ],
      "config": {
        "repository": "cyohn55/Portfolio",
        "defaultBranch": "main"
      }
    }
  }
}
```

### Method 3: Copy Configuration File

Cursor may look for MCP config in:
- `~/.cursor/mcp.json` (Linux/Mac)
- `%APPDATA%\Cursor\mcp.json` (Windows)

Copy `mcp-config.json` to the appropriate location.

### Authentication

1. After adding the server configuration, Cursor will prompt for authentication
2. Complete the OAuth flow through your browser
3. Grant the necessary permissions for the Portfolio repository
4. Cursor will automatically manage the auth token

### Verify Setup

1. Restart Cursor after configuration
2. Open command palette: `Ctrl+Shift+P` / `Cmd+Shift+P`
3. Look for GitHub MCP commands or tools
4. Test with: "List issues in Portfolio repository"

### Troubleshooting

**MCP Server Not Appearing:**
- Ensure Cursor version supports MCP (check for updates)
- Verify JSON syntax is correct (no trailing commas)
- Check Cursor's output panel for errors

**Authentication Issues:**
- Clear any `GITHUB_TOKEN` environment variables
- Re-authenticate through OAuth flow
- Check network connectivity to `api.githubcopilot.com`

**Tools Not Working:**
- Verify you have GitHub Copilot access
- Check repository permissions
- Try limiting toolsets if experiencing timeouts

### Alternative: Using npx (Local MCP Server)

If managed server doesn't work, use local GitHub MCP server:

```json
{
  "mcp.servers": {
    "github-local": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token-here"
      }
    }
  }
}
```

**Note**: Create a GitHub Personal Access Token at https://github.com/settings/tokens

### Available Commands in Cursor

Once configured, you can use natural language with Cursor's AI:
- "Show me recent issues in this repository"
- "Create a new issue for the bug I just found"
- "List open pull requests"
- "Get repository context and stats"

### Security Best Practices

- ✅ Use OAuth authentication (managed server)
- ✅ Enable read-only mode if you only need viewing capabilities
- ✅ Limit toolsets to only what you need
- ✅ Never commit `.env` files with tokens

### Resources

- [Cursor Documentation](https://cursor.sh/docs)
- [MCP Protocol Docs](https://modelcontextprotocol.io/)
- [GitHub MCP Guide](https://github.blog/ai-and-ml/generative-ai/a-practical-guide-on-how-to-use-the-github-mcp-server/)
