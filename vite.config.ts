import { defineConfig } from 'vite';

// base: './' で GitHub Pages の /<repo>/ 配下でも相対パスで読める
export default defineConfig({
  base: './',
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
