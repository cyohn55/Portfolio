import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ command }) => ({
  base: './',  // Use relative paths for GitHub Pages deployment
  plugins: [react()],
  publicDir: 'public',  // Vite will copy public/ contents to dist/
  // Strip console/debugger from production builds only. The game loop and unit
  // rendering paths log heavily; removing them in the deployed bundle is a real
  // mobile win, while dev keeps full logging for debugging.
  esbuild: command === 'build' ? { drop: ['console', 'debugger'] } : {},
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
  // Configure how public assets are handled
  experimental: {
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') {
        // For JS imports, use relative paths
        return { relative: true };
      }
      return { relative: true };
    },
  },
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      usePolling: true,
    },
    proxy: {
      '/models': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/audio': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
}));


