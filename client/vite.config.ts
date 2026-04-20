import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    solidPlugin(),
  ],
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3001,
    proxy: {
      '/ws': {
        target: 'ws://localhost:3000',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:3000',
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    sourcemap: true,
  },
});
