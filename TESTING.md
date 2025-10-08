# Testing the Embedded RTS Game

## Important: Use a Local Server

The RTS game **MUST** be tested through a web server (HTTP), not by opening `index.html` directly with `file://` protocol.

### Why?
- React/Vite applications require HTTP for module loading
- CORS policies block local file access
- Asset loading (models, audio) needs proper MIME types

## Testing Methods

### Option 1: Python HTTP Server (Recommended)
```bash
# In the Portfolio directory
python3 -m http.server 8080

# Then open in browser:
# http://localhost:8080/
```

### Option 2: Node.js HTTP Server
```bash
# Install globally (one time)
npm install -g http-server

# Run in Portfolio directory
http-server -p 8080

# Then open in browser:
# http://localhost:8080/
```

### Option 3: VS Code Live Server Extension
1. Install "Live Server" extension in VS Code
2. Right-click `index.html`
3. Select "Open with Live Server"

### Option 4: PHP Built-in Server
```bash
php -S localhost:8080
```

## Testing Steps

1. Start a local server using one of the methods above
2. Open http://localhost:8080/ in your browser
3. Scroll to the bottom of the page
4. Click the "▶ Load Game" button
5. The RTS game should load in the iframe (may take 5-10 seconds for models to load)

## Troubleshooting

### Black Screen in iframe
- **Check console** (F12 → Console tab) for errors
- **Verify server is running** on http://localhost:8080
- **Check paths**: RTS/dist/index.html should exist
- **Check models**: RTS/dist/models/ should contain .glb files

### Console Errors
- `Failed to fetch` → Not using HTTP server (using file://)
- `404 Not Found` → Build artifacts missing, run `cd RTS && npm run build`
- `CORS error` → Use same-origin server (localhost)

### Models Not Loading
- Check: `RTS/dist/models/Battle_Map_compressed.glb` exists
- Check: File size is ~26 MB
- Wait 10-15 seconds for large models to load

## Expected Behavior

1. Button shows "⏳ Loading Game..." briefly
2. Button disappears after 1 second
3. iframe shows dark background (#0b0f1a)
4. Game UI loads (main menu)
5. 3D models load progressively

## For GitHub Pages Deployment

The game will work on GitHub Pages because:
- GitHub Pages serves files via HTTPS
- Relative paths (`./`) work correctly
- All assets are in `RTS/dist/` folder

URL will be: `https://cyohn55.github.io/Portfolio/`
