# 🚀 GitHub Actions Cloud Setup Guide

## 🎯 Overview

This guide sets up a **24/7 cloud-based email-to-portfolio system** using GitHub Actions. Your portfolio will automatically update every 5 minutes, even when your computer is off or asleep!

## ✨ Key Features

### 🔧 **Fixed Issues**
- ✅ **Tile Generation Fixed**: All pages now get tiles on the home page, even without `[Description]` tags
- ✅ **24/7 Operation**: Runs in GitHub's cloud, never dependent on your local machine
- ✅ **Auto-Description**: Generates descriptions from content if none provided
- ✅ **Enhanced Error Handling**: Better logging and error recovery

### 🌟 **Cloud Benefits**
- 🌍 **Global Availability**: Works from anywhere, anytime
- ⚡ **5-Minute Updates**: Fastest possible GitHub Actions schedule
- 🔄 **Reliable Processing**: GitHub's robust infrastructure
- 💰 **Free Tier**: Uses GitHub's free Actions minutes
- 📱 **Mobile Friendly**: Send emails from phone, get instant updates

## 🔐 Required GitHub Secrets

You need to add these secrets to your GitHub repository:

1. Go to your GitHub repository
2. Click **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** for each:

### **Required Secrets:**
```
GMAIL_USERNAME = email.to.portfolio.site@gmail.com
GMAIL_PASSWORD = dylvisrabxmfkzrx
AUTHORIZED_SENDER = cyohn55@yahoo.com
```

## 📋 Setup Steps

### **Step 1: Commit New Files**
```bash
git add .github/workflows/email-to-portfolio.yml
git add MCP/github_actions_email_processor.py
git add MCP/enhanced_email_processor.py
git add MCP/github_actions_setup.md
git commit -m "Add GitHub Actions cloud email processing"
git push origin main
```

### **Step 2: Configure GitHub Pages**
1. Go to **Settings** → **Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**
4. Folder: **/ (root)**
5. Click **Save**

### **Step 3: Enable GitHub Actions**
1. Go to **Actions** tab in your repository
2. Enable workflows if prompted
3. The workflow will start running automatically every 5 minutes

### **Step 4: Test the System**
1. Send a test email to `email.to.portfolio.site@gmail.com`
2. Subject: `Test Cloud Publishing`
3. Body: `# Hello from the Cloud! This page was created using GitHub Actions.`
4. Wait 5 minutes and check your portfolio website

## 🔄 How It Works

### **Automated Workflow:**
```
Every 5 Minutes:
1. 📧 Check Gmail inbox
2. 📄 Process new emails
3. 🎨 Generate HTML pages
4. 🏠 Create home page tiles (ALWAYS!)
5. 📸 Process attachments
6. 💾 Commit to GitHub
7. 🌐 Deploy to GitHub Pages
```

### **Email Processing:**
- **Title-based grouping**: Multiple emails with same title = updated page
- **Auto-description**: Generates descriptions if missing
- **Smart tile creation**: Always creates tiles, even without `[Description]`
- **Media support**: Images and videos automatically embedded
- **Delete commands**: `[Del] Page Title` to remove pages

## 📈 Monitoring & Logs

### **Check Workflow Status:**
1. Go to **Actions** tab
2. Click on latest "Email to Portfolio Publisher" run
3. View logs for each step

### **Successful Run Looks Like:**
```
✅ Checkout repository
✅ Setup Python
✅ Install dependencies
✅ Configure Git
✅ Check for new emails and generate pages
✅ Commit and push changes if any
✅ Deploy to GitHub Pages
```

## 🐞 Troubleshooting

### **Common Issues:**

#### **No New Pages Created**
- Check if email is from authorized sender (`cyohn55@yahoo.com`)
- Verify Gmail credentials in secrets
- Check Actions logs for error messages

#### **Tiles Not Appearing**
- ✅ **FIXED**: Enhanced processor always creates tiles
- Check if index.html was properly updated in commit

#### **Images Not Loading**
- Verify attachments are supported formats (JPG, PNG, GIF, WEBP, MP4)
- Check if images were committed to `images/` directory

#### **Workflow Not Running**
- Ensure workflow file is in `.github/workflows/`
- Check if Actions are enabled in repository settings
- Verify YAML syntax is correct

### **Manual Trigger:**
You can manually trigger the workflow:
1. Go to **Actions** → **Email to Portfolio Publisher**
2. Click **Run workflow**
3. Click **Run workflow** button

## 🎉 Success Metrics

After setup, you should see:
- ✅ Workflow runs every 5 minutes
- ✅ New emails processed within 5-10 minutes
- ✅ Pages published with tiles automatically
- ✅ System works 24/7 without your computer

## 🔮 Advanced Features

### **Repository Dispatch Trigger**
For instant processing, you can trigger via webhook:
```bash
curl -X POST \
  -H "Authorization: token YOUR_GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  https://api.github.com/repos/cyohn55/Portfolio/dispatches \
  -d '{"event_type":"email_trigger"}'
```

### **Scaling Up**
- Current: 5-minute intervals (GitHub Actions minimum)
- Alternative: Use GitHub webhooks for instant triggers
- Enterprise: Consider GitHub Actions paid plans for more minutes

---

## 🎊 Congratulations!

Your email-to-portfolio system is now **fully cloud-based** and will work 24/7! 

**Send an email from anywhere, anytime, and watch your portfolio update automatically!** 📧→🌐✨ 