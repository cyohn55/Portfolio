import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import cors from 'cors';

const app = express();
app.use(cors());

// Static assets now live under public/ (Vite copies public/ -> dist/ on build).
// Prefer public/<dir>, falling back to the legacy project-root location.
function resolveAssetDir(dir: string): string {
  const publicDir = path.resolve(process.cwd(), 'public', dir);
  const rootDir = path.resolve(process.cwd(), dir);
  return fs.existsSync(publicDir) ? publicDir : rootDir;
}

// Serve models statically
const modelsPath = resolveAssetDir('models');
console.log('[server] Models path:', modelsPath);
console.log('[server] Current working directory:', process.cwd());
app.use('/models', express.static(modelsPath));

// Serve audio files statically
const audioPath = resolveAssetDir('audio');
console.log('[server] Audio path:', audioPath);
app.use('/audio', express.static(audioPath));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
});

io.on('connection', (socket) => {
  socket.on('ping', () => socket.emit('pong'));
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://localhost:${PORT}`);
});


