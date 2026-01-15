# 🎬 Media Support Guide - Images & Videos in Emails

## 🎯 **NEW FEATURE: Media Embedding in Emails**

Your email-to-website system now supports **images, videos, and YouTube embeds**! Here's how to use them:

---

## 📸 **IMAGES**

### **Standard Markdown Images:**
```markdown
![Description](https://example.com/image.jpg)
![My Project Screenshot](https://i.imgur.com/abc123.png)
![Portfolio Photo](https://your-domain.com/images/photo.jpg)
```

### **Using Your Existing Images:**
You can reference images already in your portfolio:
```markdown
![Algorithm Diagram](../images/algorithms.webp)
![Bouncing Ball Demo](../images/ball.jpg)
![Database Schema](../images/database.png)
```

---

## 🎥 **VIDEOS**

### **Direct Video Files:**
```markdown
[VIDEO](https://example.com/video.mp4)
[VIDEO](../images/Blender%20Clip.mp4)
```

### **YouTube Videos:**
```markdown
[YOUTUBE](dQw4w9WgXcQ)
[YOUTUBE](https://www.youtube.com/watch?v=dQw4w9WgXcQ)
[YOUTUBE](https://youtu.be/dQw4w9WgXcQ)
```

---

## 🔗 **LINKS**

### **Standard Links:**
```markdown
[Visit My GitHub](https://github.com/cyohn55)
[Portfolio Website](https://cyohn55.github.io/Portfolio/)
[University of the People](https://www.uopeople.edu/)
```

---

## 📧 **COMPLETE EMAIL EXAMPLE**

```
Subject: My Latest Project - AI Image Classifier

# AI Image Classifier Project

I just completed an exciting machine learning project! Here's what I built:

## Project Overview

![Project Architecture](https://i.imgur.com/project-diagram.png)

This AI system can classify images with **95% accuracy** using TensorFlow and Python.

## Demo Video

[YOUTUBE](abc123defgh)

The video shows the classifier in action, processing various images in real-time.

## Technical Details

- **Framework**: TensorFlow 2.x
- **Dataset**: CIFAR-10 (60,000 images)
- **Accuracy**: 95.2%
- **Training Time**: 4 hours on GPU

![Training Results](https://example.com/training-graph.png)

## Code Repository

Check out the full code on [GitHub](https://github.com/cyohn55/ai-classifier).

## Next Steps

I'm planning to deploy this as a web app using Flask. Stay tuned for updates!

![Final Demo](../images/ai-demo.gif)
```

---

## 🎨 **STYLING**

All media automatically includes responsive styling:
- **Images**: Max-width 50% of viewport (50vw), auto-height, 10px margins, rounded corners, drop shadow
- **Videos**: Responsive, controls enabled
- **YouTube**: 16:9 aspect ratio, fully responsive
- **Links**: Open in new tab

---

## 📁 **FILE ORGANIZATION**

### **For Best Results:**
1. **Upload images** to your `images/` directory first
2. **Reference them** in emails using relative paths
3. **Use external URLs** for temporary or large media
4. **YouTube videos** are embedded, not downloaded

### **Supported Formats:**
- **Images**: JPG, PNG, GIF, WEBP, SVG
- **Videos**: MP4, WEBM, OGV
- **YouTube**: All public YouTube videos

---

## 🚀 **WORKFLOW EXAMPLES**

### **Quick Blog Post with Image:**
```
Subject: Coffee Shop Coding Session

# Productive Day at the Coffee Shop

![Coding Setup](https://i.imgur.com/my-setup.jpg)

Spent the afternoon working on my portfolio website. The atmosphere here is perfect for coding!

## What I Accomplished:
- Fixed navigation bugs
- Added responsive design
- Deployed to GitHub Pages

[Check it out](https://cyohn55.github.io/Portfolio/)
```

### **Project Showcase with Video:**
```
Subject: New Game Development Project

# Unity 3D Game Project

I've been working on a 3D platformer game in Unity. Here's the latest progress:

[VIDEO](https://example.com/game-demo.mp4)

## Features Implemented:
- Player movement and jumping
- Collectible items
- Enemy AI
- Level progression

The game is coming along nicely! Next up: adding sound effects and music.
```

---

## ⚡ **INSTANT PUBLISHING**

Once you send the email:
1. **Email processed** within 5 minutes
2. **Page created** with embedded media
3. **Automatically pushed** to GitHub
4. **Live on website** in 5-10 minutes

**Your media-rich content goes from email to live website automatically! 🎬→🌐**

---

## 🔧 **TROUBLESHOOTING**

### **Images Not Showing:**
- Check URL is publicly accessible
- Verify image format is supported
- Use HTTPS URLs when possible

### **Videos Not Playing:**
- Ensure video format is MP4
- Check file size (keep under 50MB for web)
- Use YouTube for large videos

### **YouTube Not Embedding:**
- Verify video is public
- Check video ID is correct
- Try different URL format

**Status**: 🎬 **MEDIA SUPPORT READY**  
**Next Step**: Send an email with images/videos and watch them appear on your live website! 