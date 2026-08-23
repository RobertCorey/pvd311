import { defineConfig } from 'vitest/config';

// Default run = unit tests only. The portal simulator suites (*.sim.test.ts) drive the real driver through a real
// Chromium and take ~70 s; run them with `npm run test:sim` (CI job "portal-sim").
export default defineConfig({ test: { environment: 'node', include: ['test/**/*.test.ts'], exclude: ['test/**/*.sim.test.ts', '**/node_modules/**'] } });
