# Custom Alignment Tags Guide

## Overview

The email-to-webpage system supports custom alignment tags to easily control the positioning of text, images, and videos in your blog posts. Use simple bracket tags to align content without needing to write HTML.

## Alignment Tags

### **[center]** - Center Alignment
Centers text, images, or videos on the page.

**Syntax:**
```
[center] Your content here
```

### **[left]** - Left Alignment  
Aligns content to the left (this is the default, but useful for overriding other alignments).

**Syntax:**
```
[left] Your content here
```

### **[right]** - Right Alignment
Aligns content to the right side of the page.

**Syntax:**
```
[right] Your content here
```

## Examples

### **Text Alignment**

```
Subject: Alignment Demo

This is normal left-aligned text.

[center] This headline is centered

[right] This text is right-aligned

[left] This text is explicitly left-aligned
```

### **Image Alignment**

```
Subject: Photo Gallery

[center] photo1.jpg

[left] photo2.png

[right] photo3.jpeg
```

### **Video Alignment**

```
Subject: Video Showcase

[center] demo_video.mp4

[right] tutorial.mov
```

### **Inline Markdown Headers**

**NEW FEATURE**: You can now include markdown headers directly within alignment tags!

```
[center] ### This heading will be centered
[left] ## This heading will be left-aligned  
[right] # This heading will be right-aligned
[center] ### Which, links to the newly created web page.
```

### **Mixed Content Example**

```
Subject: My Blog Post

## Welcome to My Blog

This is regular paragraph text that flows normally.

[center] **This is a centered bold headline**

Here's some more regular text.

[center] hero_image.jpg

[right] *This caption is right-aligned*

## More Content

[left] side_image.png

The text continues here with normal flow.

[center] conclusion_video.mp4

[center] ### Final Thoughts

[right] - The End -
```

## How It Works

### **For Text:**
- Uses CSS `text-align` property
- Wraps content in a `<div>` with appropriate styling
- Maintains proper spacing with margins

### **For Images & Videos:**
- Uses CSS Flexbox for precise positioning
- `justify-content: center` for center alignment
- `justify-content: flex-start` for left alignment  
- `justify-content: flex-end` for right alignment
- Works with the responsive image sizing (50% on desktop, 100% on mobile)

## Technical Details

### **Supported Media Types:**
- **Images**: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`
- **Videos**: `.mp4`, `.mov`, `.avi`
- **HTML Elements**: `<img>`, `<video>` tags
- **Media Placeholders**: Internal system placeholders

### **Generated HTML Examples:**

**Text:**
```html
[center] Hello World
↓
<div style="text-align: center; margin: 10px 0;">Hello World</div>
```

**Inline Headers:**
```html
[center] ### My Heading
↓
<div style="text-align: center; margin: 10px 0;"><h3>My Heading</h3></div>
```

**Images:**
```html
[right] photo.jpg  
↓
<div style="display: flex; justify-content: flex-end; margin: 10px 0;">
    <img src="../images/photo.jpg" alt="photo.jpg">
</div>
```

## Best Practices

### **1. Use One Tag Per Line**
```
✅ Good:
[center] My centered text
[right] My right-aligned text

❌ Avoid:
[center] Text 1 [right] Text 2
```

### **2. Keep Tags at Line Start**
```
✅ Good:
[center] This works perfectly

❌ Won't Work:
Some text [center] This won't be processed
```

### **3. Mix with Other Formatting**
```
✅ Great Combination:
[center] **Bold Centered Title**
[right] *Italic right-aligned caption*
[center] ![Hero Image](hero.jpg)
```

### **4. Responsive Behavior**
- Text alignment works on all screen sizes
- Images maintain responsive sizing (50% desktop, 100% mobile)
- Videos scale appropriately within their alignment containers

## Integration with Existing Features

### **Works With:**
- ✅ Responsive image sizing
- ✅ Markdown formatting (`**bold**`, `*italic*`)
- ✅ **NEW**: Inline markdown headers (`[center] ### Heading`)
- ✅ Headers (`## Heading`)
- ✅ Email attachments (images/videos)
- ✅ YouTube embeds `[YOUTUBE](video_id)`
- ✅ Regular markdown images `![alt](url)`

### **Processing Order:**
1. Email attachments are processed and embedded
2. Alignment tags are processed
3. Markdown formatting is applied
4. HTML is generated and styled

## Examples in Action

### **Email Content:**
```
Subject: My Portfolio Update

[center] ## Welcome to My Latest Project

This project demonstrates advanced web development techniques.

[center] project_screenshot.png

[right] *Screenshot taken on mobile device*

## Technical Details

The implementation uses modern CSS and JavaScript:

[left] code_example.jpg

[center] **Live Demo Available**

[center] demo_video.mp4
```

### **Result:**
- Centered heading and project screenshot
- Right-aligned image caption
- Left-aligned code example image  
- Centered bold text and demo video
- All content properly spaced and responsive

This system makes it incredibly easy to create professional-looking blog posts with perfect alignment control! 