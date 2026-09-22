// Lists the files each Moonshine model needs by asking the WASM module's
// manifest helpers (the same JSON the app downloads from the CDN).
//
//   node scripts/list-model-assets.mjs
//
// Prints JSON to stdout: { "tiny_streaming": ["frontend.ort", ...], ... }
// and logs the CDN base URLs to stderr for reference.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '@moonshine-ai',
  'moonshine-wasm',
  'dist',
);

const { default: factory } = await import(
  `file://${path.join(DIST, 'moonshine.mjs')}`
);
const module = await factory({ printErr: () => {} });

// ModelArch enum values from the binding.
const ARCHES = {
  tiny_streaming: '2',
  small_streaming: '4',
  medium_streaming: '5',
};

const result = {};
for (const [name, archValue] of Object.entries(ARCHES)) {
  const manifest = JSON.parse(module.sttDependencies('en', archValue, false));
  const names = [];
  for (const group of manifest.groups ?? []) {
    console.error(`[${name}] base_url: ${group.base_url}`);
    for (const file of group.files ?? []) {
      names.push(file.name);
      console.error(
        `  ${file.name} (${file.size ?? '?'} bytes, checksum: ${file.checksum ? 'yes' : 'no'})`,
      );
    }
  }
  result[name] = names;
}

console.log(JSON.stringify(result, null, 2));