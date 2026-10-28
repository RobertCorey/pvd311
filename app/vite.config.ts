import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath } from 'node:url';

/** week/index.html and street/index.html: the built index.html with each page's own title, description, Open Graph tags
 *  and canonical link, so a shared /week or /street link previews as that page, not as the report pitch (2026-10-28
 *  audit). Firebase Hosting serves them at /week and /street (firebase.json trailingSlash: false); the app sets the
 *  same titles at run time (components/Layout.tsx). */
const PAGE_HEADS: Record<string, { title: string; description: string }> = {
  week: { title: 'This week in Providence · FixMyPVD', description: "A week of Providence 311 requests: what was reported, what the city closed and the busiest neighborhoods, from the city's public list." },
  street: { title: 'Map · FixMyPVD', description: "Every request on Providence 311's public list, on a map: what's open on your street and what the city closed." },
};
function pageHeads(): Plugin {
  return {
    name: 'fixmypvd-page-heads',
    enforce: 'post',
    generateBundle(_, bundle) {
      const index = bundle['index.html'];
      if (!index || index.type !== 'asset') return this.error('page heads: no index.html in the bundle');
      for (const [path, head] of Object.entries(PAGE_HEADS)) {
        let html = String(index.source);
        const swap = (re: RegExp, value: string) => {
          if (!re.test(html)) this.error(`page heads: ${re} not in index.html`);
          html = html.replace(re, (_m, open: string) => `${open}${value}`);
        };
        swap(/(<title>)[^<]*/, head.title);
        swap(/(<meta name="description" content=")[^"]*/, head.description);
        swap(/(<meta property="og:title" content=")[^"]*/, head.title);
        swap(/(<meta property="og:description" content=")[^"]*/, head.description);
        swap(/(<link rel="canonical" href=")[^"]*/, `https://fixmypvd.org/${path}`);
        this.emitFile({ type: 'asset', fileName: `${path}/index.html`, source: html });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    pageHeads(),
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
