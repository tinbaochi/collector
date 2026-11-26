import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { existsSync } from 'node:fs';

export default defineConfig(({ mode }) => ({
  root: path.resolve(__dirname, 'web'),
  base: '/',
  plugins: [react()],
  // static GitHub Pages build runs the in-browser demo API (no secrets involved)
  // live mode when the cloud collector produced real data (web/public/live/profiles.json, one folder per profile), demo fixtures otherwise
  define: {
    'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'pages' ? '1' : ''),
    'import.meta.env.VITE_LIVE': JSON.stringify(mode === 'pages' && existsSync(path.resolve(__dirname, 'web/public/live/profiles.json')) ? '1' : ''),
    // shared review store (Cloudflare Worker URL, set as a GitHub repository variable REVIEW_API_URL)
    'import.meta.env.VITE_REVIEW_API': JSON.stringify(mode === 'pages' ? (process.env.REVIEW_API_URL ?? '') : ''),
  },
  build: {
    outDir: path.resolve(__dirname, mode === 'pages' ? 'dist/pages' : 'dist/web'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2500,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:5178', changeOrigin: false } },
  },
}));
