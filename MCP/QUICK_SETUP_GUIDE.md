# 🚀 Quick Setup Guide for Email Automation

## Your Configuration
- **Receiving Email**: `email.to.portfolio.site@gmail.com`
- **Authorized Sender**: `cyohn55@yahoo.com`
- **Email Server**: Gmail (imap.gmail.com)

## ⚡ Quick Setup Steps

### Step 1: Set Up Gmail App Password

1. **Go to Google Account Settings**: https://myaccount.google.com/
2. **Navigate to Security** → **2-Step Verification**
3. **Enable 2-Step Verification** if not already enabled
4. **Scroll down to App passwords**
5. **Generate a new app password**:
   - Select "Mail" as the app
   - Select "Other" for device and enter "Portfolio Email Monitor"
6. **Copy the 16-character password** (something like: `abcd efgh ijkl mnop`)

### Step 2: Update Configuration

Edit `MCP/email_config.json` and replace `YOUR_APP_SPECIFIC_PASSWORD` with your generated password:

```json
{
    "email_settings": {
        "server": "imap.gmail.com",
        "port": 993,
        "username": "email.to.portfolio.site@gmail.com",
        "password": "abcd efgh ijkl mnop",
        "authorized_sender": "cyohn55@yahoo.com"
    }
}
```

### Step 3: Test the Connection

```bash
cd MCP
python email_monitor.py test
```

You should see:
```
INFO - Successfully connected to email server
INFO - Found 0 unread emails from cyohn55@yahoo.com
```

### Step 4: Start Monitoring

```bash
python email_monitor.py
```

You should see:
```
INFO - Starting continuous email monitoring for cyohn55@yahoo.com
INFO - Checking every 300 seconds...
```

## 📧 How to Send Test Email

### From cyohn55@yahoo.com, send email to: `email.to.portfolio.site@gmail.com`

**Subject**: My First Automated Page

**Body**:
```
# Welcome to My Automated Portfolio

This is my first page created automatically from an email!

## How Cool Is This?

I can now create portfolio pages by simply sending an email from my Yahoo account.

### Features I Love

- **Instant Publishing**: Pages go live in minutes
- **Mobile Friendly**: I can send emails from my phone
- **Markdown Support**: Headers, **bold**, *italic*, and lists work great
- **Automatic Navigation**: All my pages get updated menus

## Next Steps

Now I can easily add:
- Project updates
- New achievements  
- Technical articles
- Portfolio additions

This automation saves me so much time!
```

## 🎯 Expected Results

1. **Within 5 minutes** of sending the email, you should see logs showing:
   ```
   INFO - Found 1 unread emails from cyohn55@yahoo.com
   INFO - Processing email: My First Automated Page
   INFO - ✅ Successfully created page: My First Automated Page
   ```

2. **A new file** will be created: `Pages/myfirstautomatedpage.html`

3. **All navigation menus** in your portfolio will be updated with the new page link

4. **Changes will be committed** and pushed to GitHub automatically

5. **Your live website** will show the new page within 2-5 minutes

## 🔧 Troubleshooting

### "Failed to connect to email server"
- Double-check your app password is correct
- Make sure 2FA is enabled on `email.to.portfolio.site@gmail.com`
- Verify the password has no extra spaces

### "No emails found"
- Make sure you're sending from exactly `cyohn55@yahoo.com`
- Check that the email is unread in Gmail
- Look in spam/promotions folders

### "Page creation failed"
- Ensure git is configured with your credentials
- Check internet connection for GitHub push
- Verify write permissions in the Pages directory

## 📱 Mobile Usage

Perfect for on-the-go updates:

1. **Open Yahoo Mail app** on your phone
2. **Compose new email** to `email.to.portfolio.site@gmail.com`
3. **Subject line** becomes your page title
4. **Email body** becomes your page content
5. **Send email**
6. **New portfolio page** is live in ~5 minutes! 🎉

## 🔄 Workflow Summary

```
📱 cyohn55@yahoo.com sends email
    ↓
📧 email.to.portfolio.site@gmail.com receives
    ↓  
🤖 Email monitor processes (every 5 min)
    ↓
🏗️ HTML page generated
    ↓
🧭 Navigation updated
    ↓
📁 Git commit & push
    ↓
🌐 Live on GitHub Pages
    ↓
✨ Portfolio updated!
```

## 🎉 You're All Set!

Once you complete the app password setup, you'll have a powerful email-to-website automation system. You can create new portfolio pages as easily as sending an email from your phone! 