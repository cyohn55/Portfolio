# Email-to-Web-Page Automation Setup Guide

This guide will help you set up automatic web page generation triggered by emails from `cyohn55@yahoo.com`.

## 🚀 Quick Start

1. **Configure Email Settings**
2. **Set Up App Passwords**  
3. **Run the Monitor**
4. **Send Test Email**

## 📧 Email Configuration

### Step 1: Update Configuration File

Edit `email_config.json` and update these settings:

```json
{
    "email_settings": {
        "server": "imap.gmail.com",           // Use imap.gmail.com for Gmail
        "port": 993,
        "username": "your_email@gmail.com",   // Your receiving email
        "password": "your_app_password",      // App-specific password (see below)
        "authorized_sender": "cyohn55@yahoo.com"
    }
}
```

### Step 2: Set Up App-Specific Password

#### For Gmail:
1. Go to [Google Account Settings](https://myaccount.google.com/)
2. Navigate to **Security** → **2-Step Verification**
3. Scroll down to **App passwords**
4. Generate a new app password for "Mail"
5. Copy the 16-character password and use it in the config

#### For Yahoo Mail:
1. Go to [Yahoo Account Security](https://login.yahoo.com/account/security)
2. Turn on **2-step verification** if not already enabled
3. Generate an **App Password** for "Mail"
4. Use the generated password in your config

## 🛠️ Installation & Setup

### Step 1: Install Dependencies

```bash
cd MCP
pip install -r requirements.txt
```

Add to `requirements.txt` if not present:
```
imaplib2
```

### Step 2: Test Configuration

```bash
python email_monitor.py config
```

### Step 3: Test Email Connection

```bash
python email_monitor.py test
```

### Step 4: Start Continuous Monitoring

```bash
python email_monitor.py
```

## 📝 How to Send Emails for Page Creation

### Email Format

Send an email from `cyohn55@yahoo.com` to your configured receiving email with this format:

```
Subject: My New Portfolio Page

# Main Heading

This is the content of my new page. I can use markdown-style formatting.

## Subheading

- Bullet points work
- Multiple bullet points
- More content

### Sub-subheading

**Bold text** and *italic text* are supported.

This content will automatically become a new page on my portfolio website!
```

### Automatic Triggers

The system automatically creates pages when emails from `cyohn55@yahoo.com` contain:

1. **Keywords** (if enabled):
   - "create page"
   - "new page" 
   - "portfolio page"
   - "add page"
   - "website update"

2. **Markdown formatting** (headers with `#`)

3. **Any subject line** that doesn't contain common non-page keywords like "Re:", "Fwd:", "meeting", etc.

## 🔄 Automation Workflow

```
📧 Email from cyohn55@yahoo.com
    ↓
🔍 Email Monitor checks every 5 minutes
    ↓
✅ Validates sender authorization
    ↓
📝 Extracts subject and content
    ↓
🏗️ Generates HTML page
    ↓
🧭 Updates navigation in all pages
    ↓
📁 Git add, commit, push
    ↓
🌐 Auto-deploy to GitHub Pages
    ↓
✨ Live webpage in ~2-5 minutes!
```

## 🛡️ Security Features

- **Authorized Sender Only**: Only `cyohn55@yahoo.com` can create pages
- **Content Sanitization**: HTML escaping prevents injection attacks
- **Filename Safety**: Special characters removed from filenames
- **Email Tracking**: Prevents duplicate processing of same email

## 🚀 Deployment Options

### Option 1: Local Computer (Recommended for Testing)
```bash
python email_monitor.py
```

### Option 2: Cloud Server (VPS/AWS/DigitalOcean)
1. Upload files to server
2. Set up cron job or systemd service
3. Run continuously in background

### Option 3: GitHub Actions (Advanced)
Set up GitHub Actions to run the monitor on schedule.

## 📋 Monitoring & Logs

The system creates detailed logs in `email_monitor.log`:

```
2025-01-17 10:30:00 - INFO - Starting continuous email monitoring for cyohn55@yahoo.com
2025-01-17 10:30:05 - INFO - Successfully connected to email server
2025-01-17 10:30:06 - INFO - Found 1 unread emails from cyohn55@yahoo.com
2025-01-17 10:30:07 - INFO - Processing email: My New Project
2025-01-17 10:30:10 - INFO - ✅ Successfully created page: My New Project
```

## 🔧 Troubleshooting

### Common Issues

1. **"Failed to connect to email server"**
   - Check email/password in config
   - Verify app-specific password is correct
   - Ensure 2FA is enabled

2. **"No emails found"**
   - Check email is from exact address: `cyohn55@yahoo.com`
   - Verify email is unread
   - Check spam/junk folders

3. **"Page creation failed"**
   - Check git credentials are set up
   - Verify write permissions to Pages directory
   - Check internet connection for GitHub push

### Debug Mode

Run with verbose logging:
```bash
python email_monitor.py test
```

## 📱 Mobile Usage

You can create pages from your phone by:
1. Opening Yahoo Mail app
2. Composing email to your receiving address
3. Using the standard email format
4. Sending the email
5. Page will be live within 5 minutes!

## 🔄 Advanced Features

### Custom Page Templates
Modify the HTML template in `email_processor.py` to change page layout.

### Scheduled Publishing
Add date/time parsing to schedule page publication.

### Image Support
Extend system to handle email attachments as page images.

### Email Notifications
Get confirmation emails when pages are successfully created.

## 📞 Support

If you encounter issues:
1. Check the log file: `email_monitor.log`
2. Test with `python email_monitor.py test`
3. Verify email configuration
4. Check GitHub repository permissions

The system is designed to be robust and will continue monitoring even if individual emails fail to process. 