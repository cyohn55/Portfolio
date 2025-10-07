# 🚀 Email-to-Portfolio Cloud System

## Overview

This is a **cloud-based email-to-portfolio system** that automatically converts emails into web pages and publishes them to your GitHub Pages portfolio. The system runs entirely in the cloud using GitHub Actions, ensuring 24/7 availability and automatic updates.

## ✨ Key Features

- **🌍 Cloud-Based**: Runs on GitHub Actions - no local setup required
- **⚡ Real-Time**: Processes emails every 5 minutes automatically  
- **📱 Mobile-Friendly**: Send emails from anywhere, get instant website updates
- **🎨 Professional**: Generates responsive HTML pages with SEO optimization
- **📎 Media Support**: Handles images, videos, and other attachments
- **🔄 Smart Updates**: Groups emails by title, always uses the most recent version
- **🏠 Auto-Tiles**: Automatically creates homepage tiles for all pages

## 🔧 How It Works

### Simple Workflow:
1. **📧 Send Email** from `cyohn55@yahoo.com` to `email.to.portfolio.site@gmail.com`
2. **⏰ GitHub Actions** checks for new emails every 5 minutes
3. **🤖 Processing** converts email content to HTML with professional styling
4. **🚀 Auto-Deploy** pushes changes to GitHub Pages
5. **🌐 Live Website** updates automatically at https://cyohn55.github.io/Portfolio/

### Email Format:
```
Subject: My Project Title

# Main Heading
This becomes the page content with full **Markdown** support.

## Subheading
- Bullet points work
- *Italic* and **bold** text supported
- Links: [GitHub](https://github.com)

You can attach images and videos directly to the email!
```

## 📁 Core Files

### GitHub Actions System:
- `github_actions_email_processor.py` - Main cloud email processor
- `enhanced_email_processor.py` - HTML page generator optimized for cloud
- `simple_email_processor.py` - Core processing functions and utilities
- `.github/workflows/email-to-portfolio.yml` - GitHub Actions workflow

### Configuration:
- `processed_emails_cloud.json` - Tracks processed emails in the cloud
- `requirements.txt` - Python dependencies for GitHub Actions

### Documentation:
- `github_actions_setup.md` - Complete setup guide
- `EMAIL_ATTACHMENT_GUIDE.md` - How to use attachments
- `MEDIA_SUPPORT_GUIDE.md` - Image and video embedding
- `DELETE_COMMAND_GUIDE.md` - How to delete pages
- `MANUAL_EMAIL_CLEANUP_GUIDE.md` - Email management tips

## 🔐 Setup Requirements

The system uses GitHub Secrets for authentication:

```
GMAIL_USERNAME = email.to.portfolio.site@gmail.com
GMAIL_PASSWORD = [app password]
AUTHORIZED_SENDER = cyohn55@yahoo.com
```

## 🎯 Features in Detail

### Smart Email Processing:
- **Title-based grouping**: Multiple emails with same subject = page updates
- **Most recent wins**: System always uses the newest email per title
- **Auto-descriptions**: Generates descriptions if none provided
- **Skip patterns**: Ignores reply chains, out-of-office, etc.

### Professional Pages:
- **SEO optimized**: Meta tags, Open Graph, Twitter cards
- **Responsive design**: Works on all devices
- **Professional styling**: Consistent with portfolio theme
- **Media integration**: Embedded images and videos

### Cloud Advantages:
- **Always available**: Works 24/7, even when your computer is off
- **No maintenance**: GitHub handles all infrastructure
- **Version controlled**: All changes tracked in git
- **Free to run**: Uses GitHub's free Actions minutes

## 🚀 Usage Examples

### Simple Page:
```
Subject: New Python Project

# Machine Learning Classifier

Built a neural network that classifies images with 95% accuracy!

## Technologies Used:
- Python & TensorFlow
- 50,000 training images
- GPU acceleration

The model can identify objects in real-time.
```

### Page with Media:
```
Subject: Arduino LED Controller

# RGB LED Project

Created an Arduino-based LED controller with mobile app!

## Features:
- Color mixing
- Pattern animations  
- Bluetooth control

*Attach images and videos directly to this email*
```

### Delete a Page:
```
Subject: [Del] Old Project Name

Remove this outdated project from my portfolio.
```

## 📊 System Status

**✅ Active Features:**
- Cloud-based email processing
- Automatic page generation
- Homepage tile creation
- Media attachment support
- Delete command functionality
- GitHub Pages deployment
- 5-minute processing intervals

**🎯 Optimized For:**
- GitHub Actions cloud execution
- Mobile email composition
- Professional portfolio presentation
- SEO and social media sharing
- Cross-device compatibility

---

## 🔧 Troubleshooting

1. **Check GitHub Actions**: Go to Actions tab to see workflow runs
2. **Verify Secrets**: Ensure Gmail credentials are set in repository secrets
3. **Email Format**: Use Markdown formatting for best results
4. **Authorized Sender**: Only emails from `cyohn55@yahoo.com` are processed

---

**🌟 This system transforms your email into a powerful, cloud-based content management system for your portfolio!** 