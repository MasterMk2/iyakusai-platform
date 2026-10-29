import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Client build only. The API server (src/server) serves dist/client in production mode.
// Loopback dev-server origins only; any other Origin is forwarded unchanged and rejected by the API.
const DEV_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // The API accepts only Host 127.0.0.1:5178 and a matching Origin, so the dev
    // proxy presents requests from this dev origin as same-origin API requests.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5178',
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (proxyReq, req) => {
            if (DEV_ORIGINS.has(req.headers.origin ?? '')) proxyReq.setHeader('origin', 'http://127.0.0.1:5178');
          });
        },
      },
    },
  },
});
