## Animal RTS (Hex Grid)

Run locally:

1. Install deps

```
npm install
```

2. Start client and server

```
npm run dev
```

Open the printed Vite URL (default `http://localhost:5173`).

Notes:
- The server serves `models/` at `/models`. 3D assets in `RTS/models` are used directly.
- Click 3 animals, then Start to play 1v1 vs a basic AI. Units spawn near queens every 10s and regen near queens.
- Kings are stronger and move slower; bases are stationary with high HP.



