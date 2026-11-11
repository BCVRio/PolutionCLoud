import { defineConfig } from 'vite';

export default defineConfig({
  appType: 'spa',
  server: { port: 8080 },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
