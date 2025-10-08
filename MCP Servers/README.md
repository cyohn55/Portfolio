# MCP Servers Configuration

This directory contains Model Context Protocol (MCP) server configurations for the Portfolio repository.

## GitHub MCP Server

### Overview
The GitHub MCP server enables AI-powered interactions with this Portfolio repository through the Model Context Protocol. It provides tools for managing issues, pull requests, and repository context.

### Prerequisites
- GitHub Copilot or Copilot Enterprise seat
- VS Code 1.92+ or another MCP-capable client
- Network access to `https://api.githubcopilot.com`

### Configuration

The `mcp-config.json` file contains the server configuration:

```json
{
  "mcpServers": {
    "github-portfolio": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "toolsets": ["context", "issues", "pull_requests", "repository"],
      "config": {
        "repository": "cyohn55/Portfolio",
        "defaultBranch": "main"
      }
    }
  }
}
```

### Setup Instructions

#### For VS Code:
1. Open the command palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Run: `> GitHub MCP: Install Remote Server`
3. Complete the OAuth authentication flow
4. Restart the server when prompted

#### For Other MCP Clients:
1. Add the configuration from `mcp-config.json` to your MCP client's settings
2. Set the server URL to `https://api.githubcopilot.com/mcp/`
3. Authenticate when prompted via OAuth

### Available Toolsets

- **context**: Access repository context and code
- **issues**: Create, read, and manage GitHub issues
- **pull_requests**: Work with pull requests
- **repository**: Repository-level operations

### Security Features

- OAuth authentication (no manual token management)
- Automatic security updates
- Configurable access controls
- Optional read-only mode

### Read-Only Mode

To enable read-only access (no write operations), update the configuration:

```json
{
  "type": "http",
  "url": "https://api.githubcopilot.com/mcp/",
  "headers": {
    "X-MCP-Readonly": "true"
  }
}
```

### Troubleshooting

- **401 Authentication errors**: Unset any `GITHUB_TOKEN` environment variables
- **Tools not appearing**: Check proxy settings and network connectivity
- **Model timeouts**: Consider restricting toolsets to fewer capabilities

### Benefits

- ✅ No infrastructure management required
- ✅ Automatic updates and maintenance
- ✅ Built-in OAuth authentication
- ✅ Secure by default
- ✅ Easy configuration

### Resources

- [GitHub MCP Server Guide](https://github.blog/ai-and-ml/generative-ai/a-practical-guide-on-how-to-use-the-github-mcp-server/)
- [Model Context Protocol](https://modelcontextprotocol.io/)
- [MCP Servers Repository](https://github.com/modelcontextprotocol/servers)
