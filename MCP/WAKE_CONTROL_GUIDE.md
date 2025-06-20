# 🌍⚡ Email-Based Wake Control System

## 🎯 **OVERVIEW**

Control your computer's wake behavior from anywhere in the world using simple email commands! Turn your email into a remote control for your computer's power management.

---

## 📧 **WAKE COMMAND FORMATS**

### **1. 🔥 Immediate Wake Up**
```
Subject: [Wake Up]
```
- **Action**: Wakes computer immediately and keeps it awake for 5 minutes
- **Use Case**: Need to ensure your computer is awake right now
- **Example**: Sending before you need to remote desktop in

### **2. ⏰ Frequent Wake Schedule**
```
Subject: [Wake Up] every 5 minutes
Subject: [Wake Up] every 10 mins  
Subject: [Wake Up] every 2 hours
```
- **Action**: Changes wake schedule to specified interval
- **Duration**: Automatically reverts to normal (hourly) after 24 hours
- **Use Cases**: 
  - Intensive email processing periods
  - When you need frequent updates while traveling
  - Testing or debugging scenarios

### **3. 🛌 Stay Awake Mode**
```
Subject: [Wake Up] for 30 minutes
Subject: [Wake Up] for 2 hours
Subject: [Wake Up] for 1 hr
```
- **Action**: Prevents computer from sleeping for specified duration
- **Use Cases**:
  - Long downloads or uploads
  - Extended remote work sessions
  - Preventing sleep during presentations

---

## 🎮 **USAGE EXAMPLES**

### **Scenario 1: Quick Remote Access**
```
📧 Email Subject: [Wake Up]
🎯 Result: Computer wakes up immediately, stays awake 5 minutes
⏱️  Perfect for: Quick remote desktop access
```

### **Scenario 2: Heavy Travel Day**
```
📧 Email Subject: [Wake Up] every 15 minutes
🎯 Result: Computer checks email every 15 minutes for 24 hours
⏱️  Perfect for: Getting rapid updates while on business trips
```

### **Scenario 3: Long Video Call**
```
📧 Email Subject: [Wake Up] for 3 hours
🎯 Result: Computer stays awake for 3 hours straight
⏱️  Perfect for: Important video conferences or long work sessions
```

### **Scenario 4: Return to Normal**
```
📧 Email Subject: [Wake Up] every 1 hour
🎯 Result: Returns to normal hourly wake schedule
⏱️  Perfect for: Ending frequent wake periods early
```

---

## 🧠 **SMART FEATURES**

### **Automatic Safety Measures:**
- ✅ **Auto-Revert**: Frequent schedules automatically return to normal after 24 hours
- ✅ **Power Awareness**: Works on battery power without draining excessively  
- ✅ **Graceful Degradation**: Falls back to normal schedule if errors occur
- ✅ **Conflict Resolution**: New commands override previous ones intelligently

### **Supported Time Units:**
- **Minutes**: `minutes`, `mins`, `minute`, `min`
- **Hours**: `hours`, `hrs`, `hour`, `hr`
- **Case Insensitive**: `[WAKE UP]`, `[Wake Up]`, `[wake up]` all work

### **Flexible Parsing:**
- ✅ `[Wake Up] every 5 minutes` 
- ✅ `[Wake Up] every 10 mins`
- ✅ `[Wake Up] for 2 hours`
- ✅ `[Wake Up] for 30 minutes`

---

## 🔧 **TECHNICAL DETAILS**

### **How It Works:**
1. **Email Detection**: System checks for `[Wake Up]` in subject line
2. **Command Parsing**: Extracts time intervals and command type
3. **Task Management**: Creates/modifies Windows scheduled tasks dynamically
4. **Power Control**: Uses Windows `powercfg` for power override
5. **Auto-Cleanup**: Automatically reverts settings after timeouts

### **System Requirements:**
- ✅ **Windows 10/11**: Uses Windows Task Scheduler and powercfg
- ✅ **Administrator Rights**: Required for system-level task creation
- ✅ **Active Email Monitor**: Must have email monitoring running

### **Created Tasks:**
- **Normal**: `Portfolio_Email_Monitor_WORKING` (hourly)
- **Frequent**: `Portfolio_Email_Monitor_FREQUENT` (custom interval)
- **Both configured**: With wake-on-timer and battery support

---

## 📊 **COMMAND REFERENCE**

| Command | Action | Duration | Auto-Revert |
|---------|---------|----------|-------------|
| `[Wake Up]` | Wake once + 5min awake | 5 minutes | Immediate |
| `[Wake Up] every X mins` | Change wake frequency | 24 hours | Yes |
| `[Wake Up] for X hours` | Prevent sleep | X hours | Yes |

**Minimum Intervals:**
- **Frequent Wake**: 1 minute minimum
- **Stay Awake**: 1 minute minimum  
- **Maximum Stay Awake**: No limit (but battery-aware)

---

## 🧪 **TESTING YOUR SETUP**

### **Test Command Detection:**
```bash
cd MCP
python test_wake_commands.py
```

### **Test Live Email Processing:**
1. **Send test email**: `[Wake Up]` to `email.to.portfolio.site@gmail.com`
2. **Check logs**: Look for `⚡ Wake command detected` in logs
3. **Verify execution**: Should see `✅ Wake command executed successfully`

### **Monitor Current Status:**
```bash
# View current tasks
schtasks /query | findstr Portfolio

# Check wake controller status
python -c "from wake_controller import wake_controller; print(wake_controller.get_current_status())"
```

---

## 🌟 **REAL-WORLD USE CASES**

### **📱 Business Travel**
- Set frequent wake (every 10 minutes) during travel days
- Ensure important emails are processed quickly
- Access computer remotely with guaranteed wake-up

### **🏠 Remote Work**
- Wake computer before starting work session
- Keep computer awake during long video calls
- Ensure email processing during important periods

### **🔧 System Administration**
- Wake for remote maintenance windows
- Keep system awake during backups/updates
- Test automation and monitoring systems

### **📊 Development/Testing**
- Frequent wake during development cycles
- Test email automation thoroughly
- Debug system behavior patterns

---

## ⚠️ **IMPORTANT NOTES**

### **Security Considerations:**
- ✅ **Authorized Sender Only**: Only emails from `cyohn55@yahoo.com` are processed
- ✅ **No Remote Access**: Wake commands don't provide system access
- ✅ **Safe Power Management**: Uses Windows built-in power controls

### **Battery Life:**
- 🔋 **Frequent Wake**: May impact battery life if on battery power
- 🔋 **Stay Awake**: Prevents sleep but allows display dimming
- 🔋 **Auto-Revert**: Protects against excessive battery drain

### **Network Requirements:**
- 📡 **Email Access**: Computer must have internet to check emails
- 📡 **IMAP Connection**: Requires working Gmail IMAP connection
- 📡 **Firewall**: Ensure email monitoring isn't blocked

---

## 🎉 **SUCCESS EXAMPLES**

### **Example 1: Quick Wake**
```
📧 Subject: [Wake Up]
📝 Log: "⚡ Wake command detected: Wake computer once"
📝 Log: "✅ Wake command executed successfully"
📝 Log: "✅ Computer woken up and will stay awake for 5 minutes"
```

### **Example 2: Frequent Schedule**
```
📧 Subject: [Wake Up] every 5 minutes
📝 Log: "⚡ Wake command detected: Wake every 5 minutes"
📝 Log: "✅ Frequent wake schedule set: every 5 minutes"
📝 Task: Portfolio_Email_Monitor_FREQUENT created
```

### **Example 3: Stay Awake**
```
📧 Subject: [Wake Up] for 2 hours
📝 Log: "⚡ Wake command detected: Stay awake for 2 hours"
📝 Log: "✅ Computer will stay awake until 3:45 PM"
📝 Power: Override applied for 120 minutes
```

---

**Your computer is now a globally-controllable, email-responsive system! 🌍⚡📧**

**Status**: 🚀 **WAKE CONTROL READY**  
**Next Step**: Send your first wake command and watch the magic happen! 