import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Capacitor loads index.html via file:// and needs relative asset
    // paths ('./assets/...'). The Vercel-hosted web build needs absolute
    // root paths ('/assets/...') instead -- relative paths break on any
    // route other than the exact site root, since vercel.json's SPA
    // rewrite serves index.html for every path while keeping the URL
    // unchanged, so the browser resolves './assets/...' against that
    // route's path, not the site root, and the CSS/JS 404 silently.
    // `npm run cap:sync`/`cap:build` pass --mode capacitor to opt into the
    // relative base; the plain `npm run build` (Vercel) keeps '/'.
    base: mode === 'capacitor' ? './' : '/',
  },
  server: {
    port: 5173,
    proxy: {
      '/api':       { target: 'https://sniffrweb.onrender.com', changeOrigin: true },
      '/uploads':   { target: 'https://sniffrweb.onrender.com', changeOrigin: true },
      '/socket.io': { target: 'https://sniffrweb.onrender.com', ws: true },
    }
  }
}));
