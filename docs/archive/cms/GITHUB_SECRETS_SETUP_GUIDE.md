# 🔐 GitHub Secrets Setup & Testing Guide

## **Status: SECRETS NEED CONFIGURATION**

Your email-to-portfolio system is **code-complete** and ready to work, but requires GitHub secrets to be configured for cloud operation.

---

## **🎯 REQUIRED SECRETS**

You need to add these **3 secrets** to your GitHub repository:

### **1. GMAIL_USERNAME**
- **Value**: `email.to.portfolio.site@gmail.com`
- **Purpose**: The Gmail account that receives portfolio emails

### **2. GMAIL_PASSWORD** 
- **Value**: `dylvisrabxmfkzrx`
- **Purpose**: Gmail App Password for authentication

### **3. AUTHORIZED_SENDER**
- **Value**: `cyohn55@yahoo.com`
- **Purpose**: The only email address allowed to create/delete pages

---

## **📋 STEP-BY-STEP SETUP**

### **Step 1: Access Repository Secrets**
1. Go to: `https://github.com/cyohn55/Portfolio`
2. Click **Settings** tab
3. Click **Secrets and variables** → **Actions**
4. You'll see the "Repository secrets" section

### **Step 2: Add Each Secret**
For each secret, click **"New repository secret"**:

#### **Secret 1:**
- **Name**: `GMAIL_USERNAME`
- **Secret**: `email.to.portfolio.site@gmail.com`
- Click **Add Secret**

#### **Secret 2:**
- **Name**: `GMAIL_PASSWORD`  
- **Secret**: `dylvisrabxmfkzrx`
- Click **Add Secret**

#### **Secret 3:**
- **Name**: `AUTHORIZED_SENDER`
- **Secret**: `cyohn55@yahoo.com`
- Click **Add Secret**

### **Step 3: Verify Secrets Added**
After adding all 3 secrets, you should see:
- ✅ GMAIL_USERNAME
- ✅ GMAIL_PASSWORD
- ✅ AUTHORIZED_SENDER

---

## **🧪 TESTING THE SETUP**

### **Test 1: Check GitHub Actions**
1. Go to: `https://github.com/cyohn55/Portfolio/actions`
2. Look for **"Email to Portfolio Publisher"** workflow
3. Check if it's running every 5 minutes
4. Look for any error messages

### **Test 2: Manual Workflow Trigger**
1. Go to Actions → **"Email to Portfolio Publisher"**
2. Click **"Run workflow"** → **"Run workflow"**
3. Watch the workflow execute
4. Check logs for any errors

### **Test 3: Send Test Email**
1. **From**: `cyohn55@yahoo.com`
2. **To**: `email.to.portfolio.site@gmail.com`
3. **Subject**: `GitHub Secrets Test Page`
4. **Body**:
   ```
   # GitHub Secrets Test

   This email tests the GitHub secrets configuration!

   ## System Check
   - ✅ Gmail authentication  
   - ✅ Email processing
   - ✅ Page generation
   - ✅ Tile creation

   [Description] Testing GitHub secrets configuration for automated email-to-portfolio processing.
   ```

### **Test 4: Wait and Verify**
- **Wait**: 5-10 minutes for processing
- **Check**: GitHub Actions for new workflow run
- **Verify**: New page at `https://cyohn55.github.io/Portfolio/`
- **Confirm**: New tile on homepage

---

## **🔍 TROUBLESHOOTING**

### **Common Issues:**

#### **❌ "GMAIL_PASSWORD environment variable is required"**
- **Problem**: GMAIL_PASSWORD secret not configured
- **Solution**: Add the secret with exact value: `dylvisrabxmfkzrx`

#### **❌ "Could not connect to email server"**
- **Problem**: Gmail credentials incorrect
- **Solution**: Verify GMAIL_USERNAME and GMAIL_PASSWORD are exact

#### **❌ "No recent emails found from authorized sender"**
- **Problem**: AUTHORIZED_SENDER doesn't match your email
- **Solution**: Ensure secret is exactly: `cyohn55@yahoo.com`

#### **❌ Workflow not running**
- **Problem**: Workflow might be disabled
- **Solution**: Go to Actions tab, enable workflows if needed

### **How to Check Workflow Logs:**
1. Go to: `https://github.com/cyohn55/Portfolio/actions`
2. Click on a workflow run
3. Click on **"email-to-portfolio"** job
4. Expand each step to see detailed logs
5. Look for error messages or success confirmations

---

## **🎉 SUCCESS INDICATORS**

### **✅ When Working Correctly:**
- **GitHub Actions**: Green checkmarks every 5 minutes
- **Workflow Logs**: "Successfully connected to email server"
- **Email Processing**: "Found page creation email: [subject]"
- **Page Creation**: "Successfully created page from email"  
- **Git Operations**: New commit with "📧 Auto-update from email-to-portfolio system"
- **Live Website**: New page visible at your portfolio URL

### **📊 Monitoring Dashboard:**
- **Actions**: `https://github.com/cyohn55/Portfolio/actions`
- **Latest Commits**: `https://github.com/cyohn55/Portfolio/commits/main`
- **Live Site**: `https://cyohn55.github.io/Portfolio/`

---

## **🚀 EXPECTED WORKFLOW**

Once secrets are configured:

```
📧 Email sent to email.to.portfolio.site@gmail.com
    ↓ (within 5 minutes)
🤖 GitHub Actions detects and processes email
    ↓
🎨 HTML page generated with professional styling
    ↓  
🏠 Homepage tile created automatically
    ↓
📝 Changes committed to repository
    ↓
🌐 GitHub Pages deploys updated site
    ↓
✅ New page live at https://cyohn55.github.io/Portfolio/
```

**Timeline**: 5-10 minutes from email send to live webpage

---

## **🔧 QUICK VERIFICATION SCRIPT**

After setting up secrets, run this to verify:

```bash
# In your local CMS directory
python test_secrets_config.py
```

**Expected Output (locally):**
- ❌ Secrets not configured (EXPECTED - they're on GitHub)
- ❌ Email connection failed (EXPECTED - running locally)

**This is normal!** Secrets are only available in GitHub Actions, not locally.

---

## **📞 NEXT STEPS**

1. **✅ Configure all 3 secrets** (5 minutes)
2. **✅ Send test email** (1 minute)  
3. **✅ Wait for processing** (5-10 minutes)
4. **✅ Check your live website** for new page
5. **✅ Monitor GitHub Actions** for ongoing operation

---

## **🎯 FINAL CHECK**

**Before you start, verify:**
- [ ] You have access to GitHub repository settings
- [ ] You know your email credentials  
- [ ] You can send emails from cyohn55@yahoo.com
- [ ] You can access https://github.com/cyohn55/Portfolio/settings/secrets/actions

**After setup, confirm:**
- [ ] All 3 secrets show in repository secrets
- [ ] Test email sent from cyohn55@yahoo.com
- [ ] GitHub Actions workflow runs without errors
- [ ] New page appears on your live website

---

**Status**: 🔧 **READY FOR SECRETS CONFIGURATION**  
**Time Required**: ~5 minutes  
**Result**: Fully automated 24/7 email-to-portfolio system  

**Once configured, your system will work automatically every 5 minutes!** 🚀 