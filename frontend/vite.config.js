import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// npm run dev: the API of the backend on this computer (port 4000).
// npm run dev:live: the live system's API instead — to look over a change with the real data, no backend running
// here (whatever is done in it is done for real).
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    proxy: {
      '/api': mode === 'live' ? { target: 'https://cargo-pos-system.vercel.app', changeOrigin: true } : 'http://localhost:4000',
    },
  },
}));
