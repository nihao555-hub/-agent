import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// 前端只做展示与调用；/api 代理到本地后端（默认 3002）。
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.API_TARGET ?? 'http://localhost:3002',
        changeOrigin: true,
      },
      '/health': {
        target: process.env.API_TARGET ?? 'http://localhost:3002',
        changeOrigin: true,
      },
    },
  },
});
