import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Our own service worker (src/sw.ts): the same precache + navigation fallback generateSW produced, plus the
      // web-push handlers ("Notify me on this phone"). The plugin compiles it and injects the precache manifest.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: null, // explicit registration in main.tsx (reload on update + hourly checks)
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png', 'icons/icon-mono.svg'],
      manifest: {
        name: 'FixMyPVD',
        short_name: 'FixMyPVD',
        description: "Report a Providence street problem in one photo — we file it with the city's 311 for you.",
        start_url: '/',
        display: 'standalone',
        background_color: '#F7F1E6',
        theme_color: '#F7F1E6',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      injectManifest: {
        // Same set generateSW precached: the built shell only — never the 16 MB basemap under /map.
        globPatterns: ['**/*.{js,css,html}'],
      },
    }),
  ],
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
  },
  server: { port: 5173, fs: { allow: ['..'] } },
});
