import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: here('.'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': here('./src'),
    },
  },
  optimizeDeps: {
    // @lew-ds/lds-react ships raw .jsx and its runtime imports
    // `renderToStaticMarkup` from react-dom/server, which resolves to a CJS
    // build. Left un-prebundled, the dev server hands that CJS file to the
    // browser as-is, no named exports can be detected, and the app dies at
    // import time with:
    //
    //   does not provide an export named 'renderToStaticMarkup'
    //
    // Forcing it through the optimizer produces real ESM with named exports.
    // Only react-dom/server needs listing — @lew-ds/lds-react is ESM source
    // Vite cannot prebundle, and naming it here just logs "Cannot optimize
    // dependency" without changing the outcome.
    //
    // `vite build` was never affected: Rollup's commonjs plugin does this
    // interop already. That is exactly why the bug is invisible to
    // `vite preview` and to CI, and shows up only in `npm run dev`.
    include: ['react-dom/server'],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // The LDS stylesheet is a 1.5k-line bundle that no assertion reads: every
    // test here checks rendered text, roles and state, never computed style.
    // Processing it would cost more than the whole suite.
    css: false,
  },
});
