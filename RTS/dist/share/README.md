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

The still was produced by a small, throwaway offline render (not committed):
bundle a Three.js scene with esbuild (inlining the GLB via the `dataurl`
loader), load `Bear.glb`, light it with `RoomEnvironment` plus key/fill/rim
directional lights, set a radial-gradient teal background, and screenshot the
1280×720 canvas with headless Chromium loading the page from `file://` (no
server needed).

To feature a different animal, render another model from `public/models/` on a
contrasting background color (the rough complement of the animal's dominant hue)
so the subject stays legible, and overwrite `share-preview.jpg`.
