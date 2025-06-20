# 🛌 Sleep Mode Fix Guide

## 🎯 **PROBLEM IDENTIFIED**

Your email automation system stops working when your computer goes to sleep because:
- ❌ Tasks are configured as "Interactive only" 
- ❌ No system-level service running
- ❌ Python processes get suspended during sleep
- ❌ Missing proper wake-on-timer configuration

---

## 🔧 **SOLUTION: Multiple Approaches**

### **🚀 Option 1: Fixed Task Scheduler (RECOMMENDED)**

**Run the improved setup script:**
```bash
cd MCP
setup_auto_monitoring_fixed.bat
```

**What this fixes:**
- ✅ Creates SYSTEM-level tasks that survive sleep
- ✅ Configures wake-on-timer capability
- ✅ Allows running on battery power
- ✅ Prevents task suspension during sleep

---

### **🛡️ Option 2: True Windows Service (ADVANCED)**

**Step 1: Install Dependencies**
```bash
pip install pywin32 pywin32-ctypes
```

**Step 2: Install Windows Service**
```bash
cd MCP
python email_monitor_windows_service.py install
```

**Step 3: Start Service**
```bash
net start PortfolioEmailMonitor
```

**Benefits:**
- ✅ Runs as true Windows service
- ✅ Survives sleep/wake/reboot cycles
- ✅ Starts automatically with Windows
- ✅ Runs even when not logged in

---

### **⚡ Option 3: Power Management Settings**

**Prevent Sleep During Monitoring:**
```bash
# Run this before starting email monitor
powercfg /requestsoverride PROCESS python.exe SYSTEM DISPLAY AWAYMODE
```

**Allow Specific Wake Events:**
```bash
# Enable wake-on-LAN if on network
powercfg /devicequery wake_armed
```

---

## 🔍 **VERIFICATION STEPS**

### **Test Your Fix:**

1. **Start the fixed system**
2. **Put computer to sleep**
3. **Send test email from phone**
4. **Wake computer after 10 minutes**
5. **Check if email was processed**

### **Monitoring Commands:**
```bash
# Check if tasks are running
tasklist | findstr python

# View task status
schtasks /query /tn "Portfolio_Email_Monitor_Hourly" /v

# Check service status (if using Option 2)
sc query PortfolioEmailMonitor

# View recent logs
type email_monitor.log | findstr /C:$(date)
```

---

## 🎯 **BEST PRACTICE SETUP**

**Recommended configuration for maximum reliability:**

1. **Use Option 1** (Fixed Task Scheduler) for primary monitoring
2. **Add Option 2** (Windows Service) as backup
3. **Configure power settings** to allow wake-on-timer
4. **Test thoroughly** before relying on it

**Setup commands:**
```bash
cd MCP

# Install dependencies
pip install -r requirements.txt

# Set up fixed task scheduler
setup_auto_monitoring_fixed.bat

# Install Windows service as backup
python email_monitor_windows_service.py install
net start PortfolioEmailMonitor

# Test the system
python email_monitor.py test
```

---

## 📱 **MOBILE TESTING WORKFLOW**

**To verify your fix works:**

1. **Set up monitoring** using steps above
2. **Put computer to sleep**
3. **Send email from phone:**
   - To: `email.to.portfolio.site@gmail.com`
   - Subject: "Sleep Mode Test"
   - Body: "Testing sleep mode fix"
4. **Wait 10 minutes** (don't wake computer)
5. **Wake computer and check results**

**Expected result:** Email should be processed and website updated even though computer was asleep when email was sent.

---

## 🔧 **POWER SETTINGS OPTIMIZATION**

**Windows Power Options to Check:**

1. **Open Power Options** (Control Panel → Power Options)
2. **Click "Change plan settings"**
3. **Click "Change advanced power settings"**
4. **Configure these settings:**
   - **Sleep → Allow wake timers: Enabled**
   - **USB → USB selective suspend: Disabled**
   - **Network → Wake on LAN: Enabled**

---

## 📊 **TROUBLESHOOTING**

### **If Still Not Working:**

**Check Task Scheduler Settings:**
1. Open Task Scheduler (`taskschd.msc`)
2. Find `Portfolio_Email_Monitor_Hourly`
3. Right-click → Properties
4. **Verify these settings:**
   - **General tab:** "Run whether user is logged on or not"
   - **Conditions tab:** "Wake the computer to run this task" ✅
   - **Conditions tab:** "Start the task only if the computer is on AC power" ❌
   - **Settings tab:** "Allow task to be run on demand" ✅

**Check Windows Services:**
1. Open Services (`services.msc`)
2. Look for "Portfolio Email Monitor Service"
3. **Verify:** Status = "Running", Startup Type = "Automatic"

---

## ✅ **SUCCESS INDICATORS**

**Your system is working correctly when:**
- ✅ Tasks show "Running" in Task Scheduler
- ✅ Python processes visible in Task Manager
- ✅ Log files show recent activity
- ✅ Emails processed during sleep periods
- ✅ Website updates work from phone

---

**Status**: 🛠️ **SOLUTION READY**  
**Next Step**: Run `setup_auto_monitoring_fixed.bat` to implement the fix! 