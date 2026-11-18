import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import cesium from 'vite-plugin-cesium';

export default defineConfig({
  plugins: [react(), cesium()],
  define: { CESIUM_BASE_URL: JSON.stringify('/cesium/') },
  server: { host: '0.0.0.0', port: 5173, proxy: { '/api': 'http://localhost:8787' } },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
