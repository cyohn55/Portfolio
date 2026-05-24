"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const cors_1 = __importDefault(require("cors"));
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
// Static assets now live under public/ (Vite copies public/ -> dist/ on build).
// Prefer public/<dir>, falling back to the legacy project-root location.
function resolveAssetDir(dir) {
    const publicDir = path_1.default.resolve(process.cwd(), 'public', dir);
    const rootDir = path_1.default.resolve(process.cwd(), dir);
    return fs_1.default.existsSync(publicDir) ? publicDir : rootDir;
}
// Serve models statically
const modelsPath = resolveAssetDir('models');
console.log('[server] Models path:', modelsPath);
console.log('[server] Current working directory:', process.cwd());
app.use('/models', express_1.default.static(modelsPath));
// Serve audio files statically
const audioPath = resolveAssetDir('audio');
console.log('[server] Audio path:', audioPath);
app.use('/audio', express_1.default.static(audioPath));
app.get('/api/health', (_req, res) => res.json({ ok: true }));
const server = http_1.default.createServer(app);
const io = new socket_io_1.Server(server, {
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
