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

/** The vendored binding location, also shown by the settings reset button. */
export const DEFAULT_MODULE_URL = '/wasm/dist/index.js';
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

/** Persists an override for where the binding is imported from. */
export function saveModuleUrl(url: string): void {
  try {
    localStorage.setItem(MODULE_URL_KEY, url);
  } catch {
    // Nothing to do — the value still applies for this session.
  }
}

let cachedModule: Promise<MoonshineModule> | undefined;

/**
 * An indirect dynamic import, created through the Function constructor so
 * that bundlers and dev servers cannot statically analyze — and rewrite —
 * the specifier. Vite's import analysis otherwise appends `?import` and runs
 * the request through its transform pipeline, which rejects files under
 * public/ ("should not be imported from source code"). The binding must be
 * served as-is, so it must stay invisible to the bundler.
 *
 * A direct `import(/* @vite-ignore * / url)` is kept as a fallback for pages
 * with a strict CSP (unsafe-eval disabled), where `new Function` is blocked;
 * in that case the @vite-ignore annotation is relied upon instead.
 */
const opaqueImport = (() => {
  try {
    return new Function(
      'specifier',
      'return import(specifier);',
    ) as (specifier: string) => Promise<MoonshineModule>;
  } catch {
    return (specifier: string) => import(/* @vite-ignore */ specifier);
  }
})();

/** Dynamically imports the Moonshine binding (memoized). */
export function loadMoonshine(): Promise<MoonshineModule> {
  cachedModule ??= opaqueImport(loadModuleUrlPreference());
  return cachedModule;
}

/** Discards the memoized binding so the next load uses new settings. */
export function resetMoonshine(): void {
  cachedModule = undefined;
}
