/**
 * Typed access to the Cactus Needle 3 engine, compiled to WebAssembly.
 *
 * Needle turns a natural-language request into tool calls against a JSON
 * tool definition (OpenAI-style function schemas). The engine ships as
 * `wasm/needle.js` + `wasm/needle.wasm` plus a `needle3.cact` model blob on
 * Hugging Face; the desktop client downloads all three into its cache folder
 * and serves them itself (see systray/modelcache.go). It runs inside a
 * dedicated classic Worker (created from a Blob URL, exactly like the Needle
 * 3 sandbox in the project's reference folder) so its synchronous decode
 * never blocks the transcription UI.
 */

/**
 * Base URL for the Needle 3 engine and model. The desktop client downloads
 * the pinned Hugging Face revision (files wasm/needle.js, wasm/needle.wasm
 * and needle3.cact) into its cache folder on startup and serves them from
 * /needle3/ here, so the frontend never depends on an external service.
 * The URL must be absolute: the worker fetches these paths from a blob-URL
 * scope, where origin-relative paths do not resolve against the page.
 */
const NEEDLE_BASE = `${window.location.origin}/needle3`;
/** The model blob filename within {@link NEEDLE_BASE}. */
const NEEDLE_BLOB = 'needle3.cact';

/** One tool call the engine produced. */
export interface NeedleCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** The parsed result of one natural-language request. */
export interface NeedleResult {
  calls: NeedleCall[];
  /** The engine's self-reported confidence, 0-1. */
  confidence: number;
  /** The full engine output JSON, for logging. */
  raw: Record<string, unknown>;
}

/**
 * The worker source, kept as a plain string so it never touches the bundler
 * (mirroring the sandbox's WORKER_SOURCE). Loads the Emscripten needle
 * module, the model blob, and exposes load/init/reset/complete over
 * postMessage.
 */
const WORKER_SOURCE = [
  'var mod = null, outPtr = 0;',
  'function cstr(s) { var b = new TextEncoder().encode(s), p = mod._malloc(b.length + 1); mod.HEAPU8.set(b, p); mod.HEAPU8[p + b.length] = 0; return p; }',
  'async function fetchBytes(url, onProgress) {',
  '  var r = await fetch(url);',
  '  if (!r.ok) throw new Error("download failed (" + r.status + "): " + url);',
  '  if (!r.body || !onProgress) return new Uint8Array(await r.arrayBuffer());',
  '  var total = Number(r.headers.get("Content-Length")) || 0, reader = r.body.getReader(), chunks = [], got = 0;',
  '  for (;;) { var step = await reader.read(); if (step.done) break; chunks.push(step.value); got += step.value.length; onProgress(got, total); }',
  '  var bytes = new Uint8Array(got), off = 0;',
  '  for (var i = 0; i < chunks.length; i++) { bytes.set(chunks[i], off); off += chunks[i].length; }',
  '  return bytes;',
  '}',
  'self.onmessage = async function (e) {',
  '  var m = e.data, result = null;',
  '  try {',
  '    if (m.type === "load") {',
  '      var r = await fetch(m.base + "/wasm/needle.js");',
  '      if (!r.ok) throw new Error("download failed (" + r.status + "): " + m.base + "/wasm/needle.js");',
  '      importScripts(URL.createObjectURL(new Blob([await r.text()], { type: "text/javascript" })));',
  '      var wasm = fetchBytes(m.base + "/wasm/needle.wasm");',
  '      var cact = fetchBytes(m.base + "/" + m.blob, function (got, total) { self.postMessage({ type: "progress", got: got, total: total }); });',
  '      mod = await createNeedle({ wasmBinary: await wasm });',
  '      var blob = await cact, p = mod._malloc(blob.length);',
  '      mod.HEAPU8.set(blob, p);',
  '      if (mod._needle_load(p, BigInt(blob.length)) !== 0) throw new Error("model load failed");',
  '      outPtr = mod._malloc(16384);',
  '      result = true;',
  '    } else if (m.type === "init") { result = mod._needle_init(cstr(""), cstr(m.tools), 0); }',
  '    else if (m.type === "reset") { mod._needle_reset(); result = true; }',
  '    else if (m.type === "complete") { if (mod._needle_set_audio) mod._needle_complete(cstr(m.text), 0, 0, 384, outPtr, 16384); else mod._needle_complete(cstr(m.text), 384, outPtr, 16384); result = mod.UTF8ToString(outPtr); }',
  '    self.postMessage({ id: m.id, result: result });',
  '  } catch (err) { self.postMessage({ id: m.id, error: String(err && err.message || err) }); }',
  '};',
].join('\n');

let engineWorker: Worker | null = null;
let rpcSeq = 0;
const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let loadedTools: string | null = null;
/** Serializes whole run operations (load + init + reset + complete). */
let queue: Promise<unknown> = Promise.resolve();
/** Progress reporting callback, set per run and cleared afterwards. */
let onProgress: ((got: number, total: number) => void) | null = null;

/** Formats the model download progress message. */
function downloadStatus(got: number, total: number): string {
  const mb = (got / 1048576).toFixed(1);
  return total
    ? `Needle: downloading model — ${mb} / ${(total / 1048576).toFixed(1)} MB`
    : `Needle: downloading model — ${mb} MB`;
}

/** Installs the progress-reporting callback for the current queued operation. */
function trackDownload(onStatus?: (message: string) => void): void {
  onProgress = (got, total) => onStatus?.(downloadStatus(got, total));
}

/** Starts the worker and downloads the engine + model blob if not yet loaded. */
async function ensureEngineLoaded(onStatus?: (message: string) => void): Promise<void> {
  if (engineWorker) return;
  onStatus?.('Needle: loading engine…');
  startWorker();
  await rpc({ type: 'load', base: NEEDLE_BASE, blob: NEEDLE_BLOB });
  loadedTools = null;
}

function startWorker(): void {
  engineWorker = new Worker(URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' })));
  engineWorker.onmessage = (event: MessageEvent) => {
    const m = event.data as { id?: number; type?: string; got?: number; total?: number; result?: unknown; error?: string };
    if (m.type === 'progress') {
      onProgress?.(m.got ?? 0, m.total ?? 0);
      return;
    }
    if (m.id === undefined) return;
    const pending = rpcPending.get(m.id);
    if (!pending) return;
    rpcPending.delete(m.id);
    if (m.error) pending.reject(new Error(m.error));
    else pending.resolve(m.result);
  };
  engineWorker.onerror = (event) => {
    const error = new Error((event as ErrorEvent).message || 'needle engine worker failed');
    for (const pending of rpcPending.values()) pending.reject(error);
    rpcPending.clear();
  };
}

function rpc(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!engineWorker) {
      reject(new Error('needle engine worker is not running'));
      return;
    }
    const id = ++rpcSeq;
    rpcPending.set(id, { resolve, reject });
    engineWorker.postMessage({ id, ...payload });
  });
}

/**
 * Runs one natural-language request against the engine: loads it on first
 * use (reporting download progress through `onStatus`), re-inits the tool
 * definition when it changed, resets the conversation, and decodes the
 * request. Runs are serialized so overlapping wake-word hits cannot
 * interleave worker traffic.
 */
export function needleRun(
  tools: string,
  text: string,
  onStatus?: (message: string) => void,
): Promise<NeedleResult> {
  const run = queue.then(async () => {
    trackDownload(onStatus);
    try {
      await ensureEngineLoaded(onStatus);
      if (loadedTools !== tools) {
        onStatus?.('Needle: preparing tools…');
        const rc = (await rpc({ type: 'init', tools })) as number;
        if (rc < 0) throw new Error('tool schema rejected by the engine');
        loadedTools = tools;
      }
      await rpc({ type: 'reset' });
      const raw = (await rpc({ type: 'complete', text })) as string;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return {
        calls: (Array.isArray(parsed.function_calls) ? parsed.function_calls : []) as NeedleCall[],
        confidence: Number(parsed.confidence ?? 0),
        raw: parsed,
      };
    } finally {
      onProgress = null;
    }
  });
  // Keep the queue alive even when a run fails: the next run retries.
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Starts the engine and downloads the model blob ahead of the first request
 * (used when Natural Language Tool Calling is enabled, so the first tool
 * call does not pay the download cost). Runs are serialized with
 * {@link needleRun}: a prewarm in flight is simply joined by any concurrent
 * run, which then skips the already-completed load.
 */
export function needlePrewarm(onStatus?: (message: string) => void): Promise<void> {
  const run = queue.then(async () => {
    trackDownload(onStatus);
    try {
      await ensureEngineLoaded(onStatus);
    } finally {
      onProgress = null;
    }
  });
  // Keep the queue alive even when the prewarm fails: the next run retries.
  queue = run.catch(() => undefined);
  return run;
}