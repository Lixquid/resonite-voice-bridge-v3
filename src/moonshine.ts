/**
 * Typed access to the Moonshine WebAssembly speech-to-text binding.
 *
 * The binding is imported at runtime — never bundled — because its
 * Emscripten layer (`moonshine.mjs` + `moonshine.wasm` + pthread workers)
 * must be served as-is. The default source is the vendored copy at
 * `/wasm/dist` (see vite.config.ts for how the dev server serves it raw);
 * the binding URL can be overridden from the settings dialog, so the
 * binding can be loaded from any host that serves the `dist` files.
 * The npm package is installed only for TypeScript declarations.
 */

import type { MicTranscriber, ModelArch, TranscriptLine } from '@moonshine-ai/moonshine-wasm';

export type { MicTranscriber, ModelArch, TranscriptLine };

const DEFAULT_MODULE_URL = '/wasm/dist/index.js';
/** Persisted override for where the binding is imported from. */
const MODULE_URL_KEY = 'moduleUrl';

export interface MoonshineModule {
  MicTranscriber: typeof MicTranscriber;
  ModelArch: typeof ModelArch;
}

/** Reads the configured binding URL, falling back to the vendored copy. */
export function loadModuleUrlPreference(): string {
  try {
    const saved = localStorage.getItem(MODULE_URL_KEY);
    if (saved && saved.trim()) return saved.trim();
  } catch {
    // Private mode or storage disabled: the default simply applies.
  }
  return DEFAULT_MODULE_URL;
}

function saveModuleUrlPreference(url: string): void {
  try {
    localStorage.setItem(MODULE_URL_KEY, url);
  } catch {
    // Nothing to do — the value still applies for this session.
  }
}

let cachedModule: Promise<MoonshineModule> | undefined;

/**
 * Dynamically imports the Moonshine binding (memoized). The specifier is
 * computed at runtime and annotated @vite-ignore: the binding is a public-dir
 * asset that must never go through Vite's transform pipeline.
 */
export function loadMoonshine(): Promise<MoonshineModule> {
  cachedModule ??= import(
    /* @vite-ignore */ loadModuleUrlPreference()
  ) as Promise<MoonshineModule>;
  return cachedModule;
}

/** Discards the memoized binding so the next load uses new settings. */
export function resetMoonshine(): void {
  cachedModule = undefined;
}

export { saveModuleUrlPreference as saveModuleUrl };
