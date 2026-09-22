/**
 * Typed access to the Moonshine WebAssembly speech-to-text binding.
 *
 * The binding is imported at runtime (CDN by default, `?local=1` to use a
 * locally built copy) rather than bundled, because its Emscripten layer pulls
 * in generated `moonshine.mjs`/`moonshine.wasm` plus pthread workers. The
 * npm package is installed only for its TypeScript declarations.
 */

import type { MicTranscriber, ModelArch, TranscriptLine } from '@moonshine-ai/moonshine-wasm';

export type { MicTranscriber, ModelArch, TranscriptLine };

const CDN_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@moonshine-ai/moonshine-wasm/dist/index.js';
const LOCAL_MODULE_URL = '/wasm/dist/index.js';

export interface MoonshineModule {
  MicTranscriber: typeof MicTranscriber;
  ModelArch: typeof ModelArch;
}

/** Resolves where the binding module should be loaded from. */
export function moduleUrl(): string {
  return new URLSearchParams(location.search).get('local') === '1'
    ? LOCAL_MODULE_URL
    : CDN_MODULE_URL;
}

let cachedModule: Promise<MoonshineModule> | undefined;

/** Dynamically imports the Moonshine binding (memoized). */
export function loadMoonshine(): Promise<MoonshineModule> {
  cachedModule ??= import(/* @vite-ignore */ moduleUrl()) as Promise<MoonshineModule>;
  return cachedModule;
}