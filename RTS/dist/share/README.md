# Share-link preview asset

`share-preview.jpg` is the **chat link-preview image** shown when a join link
(`…/RTS/dist/index.html?room=CODE`) is pasted into a messaging app. It is wired
up by the Open Graph / Twitter tags in `RTS/index.html`. Vite copies this
`public/share/` folder to `dist/share/`, so the live URL is:

`https://cyohn55.github.io/Portfolio/RTS/dist/share/share-preview.jpg`

## What it is

A 1280×720 offline render of the crowned **Bear** model (`public/models/Bear.glb`)
on a vibrant teal background, chosen to contrast the bear's dark/tan colors so
the subject pops and never blends into the background.

A looping animal video was considered but dropped: the source clip was ~44 MB,
well beyond what link crawlers (e.g. Discord) will fetch and embed, so a single
high-impact still is used instead.

## Regenerating the image

The still is produced by an offline Three.js render of the GLB (no running game
needed). The throwaway harness lives under `RTS/.render-tmp/` when present:

1. `cp public/models/Bear.glb .render-tmp/Bear.glb`
2. `npx esbuild .render-tmp/render-still.ts --bundle --format=iife --loader:.glb=dataurl --outfile=.render-tmp/render-still.js`
3. `node .render-tmp/capture.mjs public/share/share-preview.jpg`
   (headless Chromium; the renderer page loads from `file://`, no server)

To feature a different animal, point the import in `render-still.ts` at another
model in `public/models/` and pick a contrasting background color (rough
complement of the animal's dominant hue) so it stays legible.
