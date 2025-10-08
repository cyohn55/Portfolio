# MCP Servers Configuration

This folder contains Model Context Protocol (MCP) server configurations for the RTS project.

## GitHub MCP Server Setup

### Prerequisites
1. GitHub Personal Access Token with `repo` scope
2. Node.js and npm installed

### Configuration Steps

1. **Get GitHub Personal Access Token**
   - Go to GitHub Settings → Developer settings → Personal access tokens → Tokens (classic)
   - Generate new token with `repo` scope (full control of private repositories)
   - Copy the token

2. **Configure the MCP Server**
   - Open `github-mcp-config.json`
   - Replace `YOUR_GITHUB_TOKEN_HERE` with your actual GitHub token
   - Save the file

3. **Add to Claude Desktop Config**

   For macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   For Windows: `%APPDATA%\Claude\claude_desktop_config.json`

   Add this configuration:
   ```json
   {
     "mcpServers": {
       "github": {
         "command": "npx",
         "args": [
           "-y",
           "@modelcontextprotocol/server-github"
         ],
         "env": {
           "GITHUB_PERSONAL_ACCESS_TOKEN": "your_token_here"
         }
       }
     }
   }
   ```

4. **Restart Claude Desktop**
   - Close and reopen Claude Desktop
   - The GitHub MCP server should now be active

### Available Features

Once configured, you can:
- Search repositories and code
- Create/read/update issues
- Manage pull requests
- Browse repository contents
- Fork repositories
- Create/update branches

### Repository Information
- **Owner**: cyohn55
- **Repository**: RTS
- **URL**: https://github.com/cyohn55/RTS

### Security Notes
- **Never commit your GitHub token to version control**
- Keep your token secure and private
- Regenerate token if compromised
- Use minimum required scopes for security

### Troubleshooting

If the MCP server doesn't connect:
1. Verify your token has correct permissions (`repo` scope)
2. Check that Node.js is installed and accessible
3. Restart Claude Desktop completely
4. Check Claude Desktop logs for error messages
