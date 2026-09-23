// One-time helper to vendor the Moonshine streaming models into public/models
// so the app runs fully offline. Re-run any time to repair missing files.
//
//   node scripts/fetch-models.mjs
//
// Downloads into public/models/<arch>/ using the canonical filenames the
// binding expects, verifying each file's declared size against the manifest
// (read via the WASM module's manifest helpers).

import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'public', 'models');
const DIST = path.join(
  ROOT,
  'node_modules',
  '@moonshine-ai',
  'moonshine-wasm',
  'dist',
);

// ModelArch enum values from the binding.
const ARCHES = {
  tiny_streaming: '2',
  small_streaming: '4',
  medium_streaming: '5',
};

const { default: factory } = await import(
  `file://${path.join(DIST, 'moonshine.mjs')}`
);
const module = await factory({ printErr: () => {} });

await mkdir(OUT_DIR, { recursive: true });

let failures = 0;
for (const [name, archValue] of Object.entries(ARCHES)) {
  const manifest = JSON.parse(module.sttDependencies('en', archValue, false));
  const dir = path.join(OUT_DIR, name);
  await mkdir(dir, { recursive: true });

  for (const group of manifest.groups ?? []) {
    for (const file of group.files ?? []) {
      const outPath = path.join(dir, file.name);
      if (existsSync(outPath)) {
        console.log(`[${name}] ${file.name}: already present`);
        continue;
      }
      const url = file.url ?? `${group.base_url}/${file.name}`;
      const response = await fetch(url);
      if (!response.ok) {
        console.error(`[${name}] ${file.name}: FAILED ${response.status}`);
        failures++;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (typeof file.size === 'number' && bytes.byteLength !== file.size) {
        console.error(
          `[${name}] ${file.name}: size mismatch (expected ${file.size}, got ${bytes.byteLength})`,
        );
        failures++;
        continue;
      }
      await writeFile(outPath, bytes);
      console.log(`[${name}] ${file.name}: ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} file(s) failed — re-run to retry.`);
  process.exit(1);
}
console.log('\nAll models vendored into public/models/.');