import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:";

/** Production pages get a strict CSP. The dev server needs an inline refresh script, so it is skipped there. */
const cspPlugin: Plugin = {
  name: 'glossly-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
};

export default defineConfig({
  main: {
    build: {
      // Core ships TypeScript sources, so it is bundled. Native packages (sqlite-vec,
      // transformers.js with onnxruntime) stay external through this package's dependencies.
      externalizeDeps: { exclude: ['@glossly/core'] },
      rollupOptions: {
        input: {
          index: here('src/main/index.ts'),
          'embed-worker': here('src/main/embed-worker.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: ['@glossly/core'] },
      rollupOptions: {
        input: { index: here('src/preload/index.ts') },
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: here('../ui'),
    plugins: [react(), cspPlugin],
    build: {
      outDir: here('out/renderer'),
      rollupOptions: {
        input: {
          overlay: here('../ui/overlay.html'),
          settings: here('../ui/settings.html'),
        },
      },
    },
  },
});
