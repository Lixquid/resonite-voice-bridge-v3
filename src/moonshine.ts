/**
 * Typed access to the Moonshine WebAssembly speech-to-text binding.
 *
 * The binding is imported at runtime from the local copy in `/wasm/dist`
 * (served from `public/wasm/dist`), so the app runs fully offline. The npm
 * package is installed only for TypeScript declarations.
 */

import type { MicTranscriber, ModelArch, TranscriptLine } from '@moonshine-ai/moonshine-wasm';

export type { MicTranscriber, ModelArch, TranscriptLine };

const LOCAL_MODULE_URL = '/wasm/dist/index.js';

export interface MoonshineModule {
  MicTranscriber: typeof MicTranscriber;
  ModelArch: typeof ModelArch;
}

let cachedModule: Promise<MoonshineModule> | undefined;

/** Dynamically imports the local Moonshine binding (memoized). */
export function loadMoonshine(): Promise<MoonshineModule> {
  cachedModule ??= import(/* @vite-ignore */ LOCAL_MODULE_URL) as Promise<MoonshineModule>;
  return cachedModule;
}