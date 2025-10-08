import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',  // Assets resolve from root where symlinks/copies exist
  plugins: [react()],
  publicDir: 'public',  // Vite will copy public/ contents to dist/
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
});


