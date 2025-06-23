# Delete Command Guide

## Overview

The email-to-website system now supports deleting pages and their corresponding home page tiles using simple email commands. This allows you to easily remove content from your portfolio website by sending an email.

## How to Delete Pages

### Method 1: Using Page Title

Send an email with the delete command and the **exact page title**:

**Subject Examples:**
- `[Del] This Web Page was Created with an Email`
- `Del: My Algorithm Projects`
- `[Remove] Database Design Principles`
- `Remove: Web Performance Optimization`

### Method 2: Using Filename

Send an email with the delete command and the **exact filename**:

**Subject Examples:**
- `[Del] thiswebpagewascreatedwithanemail.html`
- `Del: algorithms.html`
- `[Remove] database.html`
- `Remove: webperformance.html`

### Method 3: Delete Command in Email Body

You can also put the delete command in the email body instead of the subject:

**Subject:** `Website Update`
**Body:** `[Del] This Web Page was Created with an Email`

## Supported Delete Formats

The system recognizes these delete command patterns (case-insensitive):

- `[Del] <page identifier>`
- `Del: <page identifier>`
- `[Remove] <page identifier>`
- `Remove: <page identifier>`

## What Gets Deleted

When you send a delete command, the system will:

1. ✅ **Delete the HTML page** from the `Pages/` directory
2. ✅ **Remove the corresponding tile** from the home page
3. ✅ **Commit and push changes** to GitHub automatically
4. ✅ **Update the live website** immediately

## Examples

### Example 1: Delete by Title
```
From: cyohn55@yahoo.com
To: email.to.portfolio.site@gmail.com
Subject: [Del] This Web Page was Created with an Email

Please remove this page from my portfolio.
```

### Example 2: Delete by Filename
```
From: cyohn55@yahoo.com
To: email.to.portfolio.site@gmail.com
Subject: Del: algorithms.html

This page is outdated and should be removed.
```

### Example 3: Multiple Deletions
```
From: cyohn55@yahoo.com
To: email.to.portfolio.site@gmail.com
Subject: [Del] Bouncing Ball Animation

Remove this old project.
```

Then send another email:
```
From: cyohn55@yahoo.com
To: email.to.portfolio.site@gmail.com
Subject: [Del] videogame.html

Also remove the video game page.
```

## Finding Page Identifiers

### Finding Page Titles
1. Visit your portfolio website: https://cyohn55.github.io/Portfolio/
2. Look at the tile titles on the home page
3. Use the exact title text (case doesn't matter)

### Finding Filenames
1. Check the URL when viewing a page: `https://cyohn55.github.io/Portfolio/Pages/filename.html`
2. Or check the `Pages/` directory in your repository
3. Common filenames in your portfolio:
   - `algorithms.html`
   - `bouncingball.html`
   - `database.html`
   - `hardwarearchitecture.html`
   - `videogame.html`
   - `webperformance.html`
   - `thiswebpagewascreatedwithanemail.html`

## System Response

After processing a delete command, you'll see in the logs:

```
Del command detected for: this web page was created with an email
Deleted page: thiswebpagewascreatedwithanemail.html
Removed tile from home page
Successfully pushed deletion of 'This Web Page was Created with an Email' to GitHub!
```

## Error Handling

If a page doesn't exist, you'll see:
```
Page not found: ../Pages/nonexistent.html
Failed to delete page: nonexistent page
```

## ⚠️ ENHANCED FEATURE: Title-Based Email Processing

**NEW BEHAVIOR**: The system now processes emails based on **TITLE/SUBJECT** - processing the most recent email for each unique title.

### How It Works:
- **Title Grouping**: System groups emails by subject/title
- **Most Recent Per Title**: For each unique title, only the most recent email is processed
- **Overwrite Capability**: New emails with the same title will overwrite existing pages
- **Update Feature**: Send a new email with the same title to update/edit a page

### Example Scenario:
```
Email 1 (10:00 AM): "My Algorithm Projects" (creates page)
Email 2 (10:30 AM): "Database Design Tips" (creates page)  
Email 3 (11:00 AM): "My Algorithm Projects" (UPDATES first page)
Email 4 (11:30 AM): "[Del] Database Design Tips" (deletes second page)

Result: 
- "My Algorithm Projects" page shows content from Email 3 (most recent)
- "Database Design Tips" page is deleted (Email 4)
```

### Benefits:
- ✅ **Easy Page Updates**: Send new email with same title to update content
- ✅ **No Duplicate Pages**: Same titles overwrite instead of creating duplicates
- ✅ **Prevents Old Delete Commands**: Only most recent delete commands per title are processed
- ✅ **Flexible Workflow**: Edit pages by sending updated emails
- ✅ **Safe Processing**: Old emails with same title are automatically ignored

### Page Update Workflow:
1. **Create Page**: Send email with title "My Project"
2. **Update Page**: Send new email with same title "My Project" (overwrites)
3. **Delete Page**: Send email with title "[Del] My Project"

## Safety Features

- ✅ Only authorized sender (cyohn55@yahoo.com) can delete pages
- ✅ **Only the most recent email is processed (NEW SECURITY FEATURE)**
- ✅ System checks if page exists before attempting deletion
- ✅ Both page file and home page tile are removed together
- ✅ Changes are automatically committed to git with descriptive messages
- ✅ Detailed logging for troubleshooting

## Monitoring

The email system checks for new emails every 5 minutes, so delete commands will be processed within 5 minutes of sending the email.

You can monitor the system with:
```bash
# View recent logs
Get-Content MCP\email_monitor_service.log -Tail 20

# Check if system is running
Get-Process python | Where-Object {$_.CommandLine -like "*email_monitor*"}
```

## Troubleshooting

### Delete Command Not Working?

1. **Check the sender**: Only emails from `cyohn55@yahoo.com` are processed
2. **Check the format**: Use `[Del] Title` or `Del: filename.html`
3. **Check the page exists**: Verify the page title or filename is correct
4. **Check the logs**: Look at `email_monitor_service.log` for error messages

### Page Still Showing?

1. **Clear browser cache**: The page might be cached
2. **Wait a few minutes**: GitHub Pages takes a moment to update
3. **Check git history**: Verify the deletion was committed and pushed

## Integration with Existing System

The delete functionality is fully integrated with the existing email-to-website system:

- ✅ Same email monitoring service
- ✅ Same authentication (authorized sender)
- ✅ Same git workflow (commit and push)
- ✅ Same logging system
- ✅ No additional setup required

The system automatically detects whether an email is a page creation command or a delete command and processes it accordingly. 