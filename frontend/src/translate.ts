/**
 * Browser-side English ↔ Japanese translation for the Translation Stream.
 *
 * Runs the OPUS-MT / Marian models (Xenova/opus-mt-en-jap and
 * Xenova/opus-mt-ja-en) through Transformers.js on top of ONNX Runtime Web,
 * entirely inside a dedicated module Worker so the decode never blocks the
 * transcription UI. Everything is loaded from the desktop client, which
 * downloads the pinned Transformers.js build and both models into its cache
 * folder and serves them at /translation/ — no external service is ever
 * contacted from the frontend (remote model loading is disabled outright).
 *
 * Requests are queued on the host side: interim (partial) requests are
 * debounced by the caller and supersede each other, while final requests are
 * always kept. Results that are stale by the time they finish — the text
 * moved on, or the direction was switched — resolve as null instead of being
 * emitted, so the previous direction can never overwrite current output.
 */

/** The translation directions the models cover. */
export type TranslationDirection = 'en-ja' | 'ja-en';

/**
 * Base URL of the translation assets on the desktop client. Served layout:
 *
 *   /translation/lib/transformers.min.js               (Transformers.js)
 *   /translation/lib/ort-wasm-simd-threaded.jsep.*     (ONNX Runtime Web)
 *   /translation/models/<model-id>/<files>             (OPUS-MT models)
 *
 * The URL must be absolute: the worker is created from a blob URL, where
 * origin-relative paths do not resolve against the page.
 */
import { getWorkerLocale, t } from './i18n';

const TRANSLATION_BASE = `${window.location.origin}/translation`;

/**
 * The OPUS-MT model directory (under {@link TRANSLATION_BASE}/models) per
 * direction. EN → JP uses Helsinki-NLP's Tatoeba model (conversational
 * training data) instead of the bible-domain `opus-mt-en-jap`, whose output
 * quality on everyday phrases is markedly worse; both are Apache-2.0.
 */
const MODEL_IDS: Record<TranslationDirection, string> = {
  'en-ja': 'opus-tatoeba-en-ja',
  'ja-en': 'opus-mt-ja-en',
};

/** Generation token cap: live captions are short phrases; bounds worst-case latency. */
const MAX_NEW_TOKENS = 128;

/** Maximum queued requests: anything older is dropped instead of piling up. */
const QUEUE_LIMIT = 10;

/** Human-readable label for a direction, used in status messages. */
function directionLabel(dir: TranslationDirection): string {
  return dir === 'en-ja' ? t('translation.label.en-ja') : t('translation.label.ja-en');
}

/**
 * The worker source, kept as a plain string so it never touches the bundler
 * (same approach as the Needle 3 engine in needle.ts). A module Worker is
 * used because Transformers.js is an ES module that is imported at runtime
 * from the desktop client. The worker loads the library once, keeps one
 * pipeline per direction cached, and serializes all operations on a promise
 * chain so concurrent requests cannot double-load a model.
 */
function workerSource(): string {
  return `
const L = ${JSON.stringify(getWorkerLocale().translation)};
function fmt(s, p) { for (var k in p) { s = s.split("{" + k + "}").join(p[k]); } return s; }
const DIRECTIONS = { 'en-ja': 'opus-tatoeba-en-ja', 'ja-en': 'opus-mt-ja-en' };
let lib = null;
const pipes = new Map();
const loads = new Map();

// The desktop client downloads the translation assets into its cache on
// demand, when the frontend first requests them (see systray/modelcache.go),
// so a failed request usually means the download itself hiccuped. Retrying a
// few times with a pause between attempts absorbs that instead of failing the
// whole stream.
const LOAD_ATTEMPTS = 5;
const LOAD_RETRY_DELAY_MS = 3000;

async function retryLoad(fn) {
  let lastErr = null;
  for (let attempt = 1; attempt <= LOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, LOAD_RETRY_DELAY_MS));
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function getLib(base) {
  if (lib) return lib;
  const mod = await retryLoad(() => import(base + '/lib/transformers.min.js'));
  // Everything must come from the desktop client: no Hugging Face or CDN
  // access is allowed at inference time.
  mod.env.allowLocalModels = true;
  mod.env.allowRemoteModels = false;
  mod.env.localModelPath = base + '/models/';
  mod.env.backends.onnx.wasm.wasmPaths = base + '/lib/';
  mod.env.backends.onnx.wasm.numThreads = 1; // DIAGNOSTIC: single-threaded WASM
  lib = mod;
  return mod;
}

async function getPipe(dir, base) {
  const cached = pipes.get(dir);
  if (cached) return cached;
  const inFlight = loads.get(dir);
  if (inFlight) return inFlight;
  const promise = (async () => {
    const mod = await getLib(base);
    const pipe = await retryLoad(() => mod.pipeline('translation', DIRECTIONS[dir], {
      dtype: 'q8',
      progress_callback: (p) => self.postMessage({
        type: 'progress', dir: dir, status: p.status, file: p.file,
        loaded: p.loaded, total: p.total,
      }),
    }));
    pipes.set(dir, pipe);
    loads.delete(dir);
    return pipe;
  })();
  loads.set(dir, promise);
  promise.catch(() => loads.delete(dir)); // a failed load may be retried
  return promise;
}

let chain = Promise.resolve();
// Diagnostics: surface uncaught worker failures (with stacks) to the host.
self.addEventListener('error', (e) => self.postMessage({ type: 'workerlog', message: fmt(L.log.workerError, { message: ((e && e.error && (e.error.stack || e.error.message)) || e.message || 'unknown') }) }));
self.addEventListener('unhandledrejection', (e) => self.postMessage({ type: 'workerlog', message: fmt(L.log.unhandledRejection, { message: ((e.reason && (e.reason.stack || e.reason.message)) || e.reason) }) }));
self.onmessage = (event) => {
  const message = event.data;
  chain = chain.then(async () => {
    try {
      if (message.type === 'load') {
        await getPipe(message.dir, message.base);
        self.postMessage({ id: message.id, result: true });
      } else if (message.type === 'translate') {
        const pipe = await getPipe(message.dir, message.base);
        const output = await pipe(message.text, { max_new_tokens: ${MAX_NEW_TOKENS} });
        const text = Array.isArray(output)
          ? output[0] && output[0].translation_text
          : output && output.translation_text;
        self.postMessage({ id: message.id, result: typeof text === 'string' ? text : '' });
      }
    } catch (err) {
      self.postMessage({ id: message.id, error: String((err && (err.stack || err.message)) || err) });
    }
  });
};
`;
}

/** Progress and logging callbacks, supplied once by the application. */
export interface TranslationHandlers {
  /** Receives status-line text ('' clears the line). */
  onStatus(message: string): void;
  /** Receives diagnostics for the event log; `isError` marks failures. */
  onLog(message: string, isError?: boolean): void;
}

/** One queued request: a model load, or one text to translate. */
interface TranslationJob {
  kind: 'load' | 'partial' | 'final';
  /** Monotonic submission order, used to detect stale partials. */
  seq: number;
  dir: TranslationDirection;
  text: string;
  resolve: (translation: string | null) => void;
}

let handlers: TranslationHandlers | null = null;
let worker: Worker | null = null;
let currentDir: TranslationDirection | null = null;
let rpcSeq = 0;
const rpcPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** Status reporter for the operation currently in flight (see {@link pump}). */
let onProgress: ((message: string) => void) | null = null;
/** Minimum delay between download status emissions, so the log stays readable. */
const DOWNLOAD_STATUS_INTERVAL_MS = 3000;
/** Timestamp of the last emitted download status, for throttling. */
let lastDownloadStatus = 0;
/** Error whose message marks an intentional release (not worth logging). */
const RELEASED = t('translation.error.released');

const queue: TranslationJob[] = [];
let processing = false;
let seqCounter = 0;
/** Seq of the most recent submission: partials older than this are stale. */
let newestSeq = 0;

/**
 * Applies the translation direction: `null` releases the engine (worker
 * terminated, all pending requests dropped); a direction lazily loads its
 * model through the queue, reporting download progress via `handlers`.
 * Changing direction never lets results from the old direction through:
 * queued jobs carry their direction and are discarded on mismatch.
 */
export function setTranslationDirection(
  dir: TranslationDirection | null,
  h: TranslationHandlers,
): void {
  handlers = h;
  if (dir === currentDir) return;
  currentDir = dir;
  if (!dir) {
    releaseTranslation();
    return;
  }
  void enqueue({ kind: 'load', dir });
}

/**
 * Queues one text for translation. Partials supersede each other (only the
 * newest interim request survives) and may resolve null when a newer request
 * or a final line has already taken over; finals are always kept. Errors
 * resolve null and are reported through the log handler — translation never
 * interrupts transcription.
 */
export function translateText(
  text: string,
  kind: 'partial' | 'final',
): Promise<string | null> {
  if (!currentDir || !text.trim()) return Promise.resolve(null);
  return enqueue({ kind, dir: currentDir, text });
}

/**
 * Ensures the model for the current direction is loaded (downloaded through
 * the desktop client if needed) without translating anything, so the first
 * live request does not pay the initialization cost.
 */
export function prewarmTranslation(): void {
  if (!currentDir) return;
  void enqueue({ kind: 'load', dir: currentDir });
}

/** Queues a job, applying supersession and the queue cap. */
function enqueue(
  job: Pick<TranslationJob, 'kind' | 'dir'> & { text?: string },
): Promise<string | null> {
  return new Promise((resolve) => {
    const queued: TranslationJob = { seq: ++seqCounter, text: '', resolve, ...job };
    newestSeq = queued.seq;
    // A newer partial or a final line makes every queued partial obsolete.
    if (queued.kind !== 'load') {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].kind === 'partial') {
          queue[i].resolve(null);
          queue.splice(i, 1);
        }
      }
    }
    queue.push(queued);
    // Unbounded queues are never allowed: drop the oldest pending request.
    while (queue.length > QUEUE_LIMIT) {
      const dropped = queue.shift()!;
      dropped.resolve(null);
      handlers?.onLog(t('translation.log.queueOverflow'), true);
    }
    pump();
  });
}

/** Runs the queue serially: one request at a time, discarding stale results. */
async function pump(): Promise<void> {
  if (processing) return;
  const job = queue.shift();
  if (!job) {
    handlers?.onStatus('');
    return;
  }
  processing = true;
  try {
    if (job.dir !== currentDir) {
      job.resolve(null); // the direction changed while this was queued
      return;
    }
    ensureWorker();
    onProgress = (message) => handlers?.onStatus(message);
    // Shown immediately: the desktop client may download for a while before
    // the first byte reaches the browser (and with it, the first event).
    onProgress(t('translation.status.preparing', { label: directionLabel(job.dir) }));
    if (job.kind === 'load') {
      await rpc({ type: 'load', dir: job.dir, base: TRANSLATION_BASE });
      job.resolve(null);
      return;
    }
    const text = (await rpc({
      type: 'translate',
      dir: job.dir,
      base: TRANSLATION_BASE,
      text: job.text,
    })) as string;
    // A partial that finished after a newer submission is stale: discard it.
    const stale = job.kind === 'partial' && job.seq < newestSeq;
    job.resolve(stale || !text ? null : text);
  } catch (err) {
    job.resolve(null);
    if ((err as Error).message !== RELEASED) {
      handlers?.onLog(t('translation.log.error', { message: (err as Error).message }), true);
    }
  } finally {
    processing = false;
    onProgress = null;
    void pump();
  }
}

/** Terminates the engine: pending requests resolve null, nothing is logged. */
function releaseTranslation(): void {
  for (const job of queue.splice(0)) job.resolve(null);
  worker?.terminate();
  worker = null;
  for (const pending of rpcPending.values()) pending.reject(new Error(RELEASED));
  rpcPending.clear();
  handlers?.onStatus('');
}

/** Starts the module worker over the serialized RPC protocol. */
function ensureWorker(): void {
  if (worker) return;
  worker = new Worker(
    URL.createObjectURL(new Blob([workerSource()], { type: 'text/javascript' })),
    { type: 'module' },
  );
  worker.onmessage = (event: MessageEvent) => {
    const m = event.data as {
      id?: number;
      type?: string;
      dir?: TranslationDirection;
      status?: string;
      message?: string;
      file?: string;
      loaded?: number;
      total?: number;
      result?: unknown;
      error?: string;
    };
    if (m.type === 'workerlog') {
      handlers?.onLog(m.message ?? t('translation.log.unknownWorkerError'), true);
      return;
    }
    if (m.type === 'progress') {
      const now = Date.now();
      if (now - lastDownloadStatus < DOWNLOAD_STATUS_INTERVAL_MS) return;
      lastDownloadStatus = now;
      const dir = m.dir === 'ja-en' ? 'ja-en' : 'en-ja';
      const label = directionLabel(dir);
      if (typeof m.total === 'number' && m.total > 0 && typeof m.loaded === 'number') {
        onProgress?.(
          t('translation.status.downloading', {
            label,
            loaded: (m.loaded / 1048576).toFixed(1),
            total: (m.total / 1048576).toFixed(1),
          }),
        );
      } else {
        onProgress?.(
          t('translation.status.loading', { label, file: m.file ?? 'model' }),
        );
      }
      return;
    }
    if (m.id === undefined) return;
    const pending = rpcPending.get(m.id);
    if (!pending) return;
    rpcPending.delete(m.id);
    if (m.error) pending.reject(new Error(m.error));
    else pending.resolve(m.result);
  };
  worker.onerror = (event) => {
    const error = new Error((event as ErrorEvent).message || t('translation.error.workerFailed'));
    for (const pending of rpcPending.values()) pending.reject(error);
    rpcPending.clear();
    // The worker is unusable after an uncaught error: drop it so the next
    // request starts a fresh one instead of hanging forever.
    worker?.terminate();
    worker = null;
  };
}

/** Sends one RPC to the worker and resolves with its result. */
function rpc(payload: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!worker) {
      reject(new Error(t('translation.error.notRunning')));
      return;
    }
    const id = ++rpcSeq;
    rpcPending.set(id, { resolve, reject });
    worker.postMessage({ id, ...payload });
  });
}
