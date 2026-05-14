import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  plugins: [
    tailwindcss(),
    solidPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      // Inline workbox config — generates sw.js at build time
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,wasm,woff2}'],
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
        disableDevLogs: true,
        // Take over immediately on update — don't wait for all tabs to close.
        // Combined with the _headers no-cache rules for index.html/sw.js this
        // ensures users see the new version on next hard-refresh or tab open.
        skipWaiting: true,
        clientsClaim: true,
      },
      // Web app manifest
      manifest: {
        name: 'NO(DE)-SDR — WebSDR',
        short_name: 'NO(DE)-SDR',
        description: 'Multi-user WebSDR receiver for RTL-SDR dongles',
        start_url: '/',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'any',
        background_color: '#07090e',
        theme_color: '#07090e',
        categories: ['utilities', 'productivity'],
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      // Dev mode: show SW in development too so install prompt works during dev
      devOptions: {
        enabled: true,
        type: 'module',
      },
    }),
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
