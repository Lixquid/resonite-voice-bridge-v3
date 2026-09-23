import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const CONFIG_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * Serves the vendored Moonshine binding from public/wasm/dist as raw files,
 * ahead of Vite's module pipeline. The binding is loaded with a runtime
 * dynamic `import('/wasm/dist/index.js')` (never bundled); without this
 * middleware Vite's dev server tries to transform a public-dir file and fails
 * with "should not be imported from source code". On a static host the files
 * are simply served as-is (see TODO.txt for the server requirements).
 */
function serveVendoredWasm(): Plugin {
  const rootDir = path.resolve(CONFIG_DIR, 'public', 'wasm', 'dist');
  const MIME: Record<string, string> = {
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.wasm': 'application/wasm',
    '.map': 'application/json; charset=utf-8',
  };
  return {
    name: 'serve-vendored-wasm',
    configureServer(server) {
      server.middlewares.use('/wasm/dist', (req, res, next) => {
        void (async () => {
          // connect() strips the /wasm/dist prefix; drop any query string.
          const relative = decodeURIComponent((req.url ?? '/').split('?')[0]);
          const filePath = path.normalize(path.join(rootDir, relative));
          if (!filePath.startsWith(rootDir)) {
            res.writeHead(403).end('Forbidden');
            return;
          }
          try {
            const data = await readFile(filePath);
            res.writeHead(200, {
              'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
              'Cross-Origin-Opener-Policy': 'same-origin',
              'Cross-Origin-Embedder-Policy': 'require-corp',
              'Cache-Control': 'no-store',
            });
            res.end(data);
          } catch {
            next();
          }
        })();
      });
    },
  };
}

// The threaded WASM build needs SharedArrayBuffer, which browsers only expose
// to cross-origin-isolated pages. Two response headers make the page
// cross-origin isolated (same approach as the Moonshine examples' serve.mjs).
// Hosts that cannot set these headers still work: the Emscripten pthread
// support degrades to single-threaded when SharedArrayBuffer is unavailable
// (verified against this exact build).
export default defineConfig({
  plugins: [serveVendoredWasm()],
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