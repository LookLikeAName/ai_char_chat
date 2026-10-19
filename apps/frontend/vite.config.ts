import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 開發時把 API、WebSocket、圖片轉給本機的後端（npm run dev:api）
const backend = process.env.BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/media': backend,
      '/ws': { target: backend.replace(/^http/, 'ws'), ws: true },
    },
  },
});
