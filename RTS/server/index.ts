import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import cors from 'cors';

const app = express();
app.use(cors());

// Serve models statically (models are in the project root)
const modelsPath = path.resolve(process.cwd(), 'models');
console.log('[server] Models path:', modelsPath);
console.log('[server] Current working directory:', process.cwd());
app.use('/models', express.static(modelsPath));

// Serve audio files statically
const audioPath = path.resolve(process.cwd(), 'audio');
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


