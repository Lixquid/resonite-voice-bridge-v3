import { defineConfig } from 'vite';

// The threaded WASM build needs SharedArrayBuffer, which browsers only expose
// to cross-origin-isolated pages. Two response headers make the page
// cross-origin isolated (same approach as the Moonshine examples' serve.mjs).
export default defineConfig({
  server: {
    port: 8080,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    target: 'es2022',
  },
});