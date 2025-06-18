# Email-to-Page System for Portfolio

This system allows you to create and update portfolio pages by sending emails or using text files. It integrates with your existing MCP server to automatically generate HTML pages and push them to GitHub.

## Features

- ✅ Create new pages from email content
- ✅ Update existing pages from email content
- ✅ Automatic navigation updates
- ✅ Git integration (add, commit, push)
- ✅ Markdown-style formatting support
- ✅ HTML template generation
- ✅ Safe filename generation

## How It Works

1. **Email Processing**: Parse email content to extract title and body
2. **HTML Generation**: Convert content to properly formatted HTML
3. **Navigation Update**: Automatically update navigation in all pages
4. **Git Operations**: Stage, commit, and push changes to GitHub
5. **Auto-Deploy**: Changes are automatically deployed to GitHub Pages

## Usage

### Method 1: Command Line with Text Files

1. **Create a new page**:
   ```bash
   cd MCP
   python email_processor.py create example_email.txt
   ```

2. **Update an existing page**:
   ```bash
   python email_processor.py update update_email.txt
   ```

### Method 2: Direct MCP Server Calls

You can also call the MCP server tools directly:

```python
# Create a new page
await create_page_from_email({
    "title": "Machine Learning Projects",
    "content": "# My ML Journey\n\nThis is my content..."
})

# Update existing page
await update_page_from_email({
    "page_name": "machinelearningprojects",
    "content": "Updated content..."
})

# List all pages
await list_pages()
```

## Email Format

### Creating New Pages

Your email should follow this format:

```
Subject: Your Page Title

# Main Heading

Your content here with markdown-style formatting.

## Subheading

More content...

### Sub-subheading

- Bullet points
- More bullet points

**Bold text** and *italic text* are supported.
```

### Updating Existing Pages

For updates, use the same format but the subject will be used to identify the page to update.

## Supported Markdown Features

- **Headers**: `#`, `##`, `###`
- **Bold**: `**text**`
- **Italic**: `*text*`
- **Lists**: `-` or `*`
- **Paragraphs**: Double line breaks

## File Structure

```
MCP/
├── server.py              # Enhanced MCP server with email tools
├── email_processor.py     # Email processing script
├── example_email.txt      # Example email format
└── README_EMAIL_SYSTEM.md # This file
```

## New MCP Tools Added

### 1. `create_page_from_email`
Creates a new HTML page from email content.

**Parameters:**
- `title` (string): Page title
- `content` (string): Page content with markdown formatting

### 2. `update_page_from_email`
Updates an existing page with new content.

**Parameters:**
- `page_name` (string): Name of the page to update (without .html)
- `content` (string): New page content

### 3. `list_pages`
Lists all pages in the Pages directory.

**Parameters:** None

## Example Workflow

1. **Write your email content** in a text file:
   ```
   Subject: My New Project
   
   # My Amazing Project
   
   This is a description of my latest project...
   ```

2. **Process the email**:
   ```bash
   python email_processor.py create my_email.txt
   ```

3. **Check the result**:
   - New page created in `Pages/mynewproject.html`
   - Navigation updated in all pages
   - Changes committed and pushed to GitHub
   - Page automatically deployed to GitHub Pages

## Integration Options

### Option 1: Email Forwarding
Set up email forwarding to trigger the system automatically.

### Option 2: Zapier Integration
Use Zapier to connect your email to the MCP server.

### Option 3: Custom Email Bot
Create a Python script that monitors your email inbox.

### Option 4: Webhook Integration
Set up a webhook that can be triggered by email services.

## Troubleshooting

### Common Issues

1. **Page already exists**: Use `update` instead of `create`
2. **Navigation not updated**: Run the update_all_navigation tool manually
3. **Git push failed**: Check your GitHub credentials and permissions
4. **HTML formatting issues**: Check your markdown syntax

### Debug Mode

To see detailed output, you can modify the email processor to include debug logging:

```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## Security Considerations

- Email content is HTML-escaped to prevent injection attacks
- Filenames are sanitized to prevent directory traversal
- Git operations are performed in a controlled environment

## Future Enhancements

- [ ] Email attachment support (images, files)
- [ ] Rich text editor integration
- [ ] Email templates
- [ ] Scheduled publishing
- [ ] Version control for page history
- [ ] Email notifications for successful deployments

## Support

If you encounter any issues:

1. Check the MCP server logs
2. Verify your Git configuration
3. Ensure all required files exist
4. Test with the example email file first

The system is designed to be robust and user-friendly, making it easy to keep your portfolio updated with fresh content! 