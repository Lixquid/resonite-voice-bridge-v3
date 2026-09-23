import {
  loadMoonshine,
  loadModuleUrlPreference,
  resetMoonshine,
  saveModuleUrl,
  type MicTranscriber,
  type MoonshineModule,
  type TranscriptLine,
} from './moonshine';

const DEFAULT_WS_URL = 'ws://localhost:9999';
const QUEUE_LIMIT = 500;
/** Maximum rows kept in the on-page frame log. */
const FRAME_LOG_LIMIT = 500;
/** How often to retry the relay while it is down and the user wants it. */
const RECONNECT_INTERVAL_MS = 10_000;
/** Text frame sent when the model detects the end of speech, if enabled. */
const SPEECH_ENDED_FRAME = '[speechEnded]';
/** Persisted flag: send event frames (e.g. {@link SPEECH_ENDED_FRAME})? Default on. */
const SEND_EVENTS_KEY = 'sendEvents';
/** Persisted flag: lowercase + strip non-alphanumerics from sent frames. */
const SANITIZE_KEY = 'sanitizeFrames';
/** Persisted flag: send partial frames as text is recognized? Default on. */
const STREAMED_OUTPUT_KEY = 'streamedOutput';
/** Persisted key of the last used model size ({@link ArchKey}). */
const MODEL_KEY = 'modelArch';
/** Persisted base URLs for the models not shipped with the app. */
const MODEL_URL_KEY = 'modelUrls';
/** Default download location for the small and medium models. */
const CDN_BASE = 'https://download.moonshine.ai/model';
const CDN_REV = 'quantized_26_07_30';

const DEFAULT_MODEL_URLS: Record<Exclude<ArchKey, 'tiny'>, string> = {
  small: `${CDN_BASE}/small-streaming-en/${CDN_REV}`,
  medium: `${CDN_BASE}/medium-streaming-en/${CDN_REV}`,
};
/** Shown in the dialog when resetting the binding URL field. */
const DEFAULT_MODULE_URL = '/wasm/dist/index.js';

/** Base URLs for non-bundled models, as persisted in localStorage. */
function loadModelUrls(): Record<Exclude<ArchKey, 'tiny'>, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(MODEL_URL_KEY) ?? '{}') as Partial<
      Record<Exclude<ArchKey, 'tiny'>, string>
    >;
    return {
      small: saved.small?.trim() || DEFAULT_MODEL_URLS.small,
      medium: saved.medium?.trim() || DEFAULT_MODEL_URLS.medium,
    };
  } catch {
    return { ...DEFAULT_MODEL_URLS };
  }
}

function saveModelUrls(urls: Record<Exclude<ArchKey, 'tiny'>, string>): void {
  try {
    localStorage.setItem(MODEL_URL_KEY, JSON.stringify(urls));
  } catch {
    // Nothing to do — the values still apply for this session.
  }
}

const els = {
  wsDot: document.getElementById('wsDot') as HTMLSpanElement,
  wsUrl: document.getElementById('wsUrl') as HTMLInputElement,
  wsToggle: document.getElementById('wsToggle') as HTMLButtonElement,
  mic: document.getElementById('mic') as HTMLButtonElement,
  wsState: document.getElementById('wsState') as HTMLElement,
  sendEvents: document.getElementById('sendEvents') as HTMLInputElement,
  sanitize: document.getElementById('sanitize') as HTMLInputElement,
  streamedOutput: document.getElementById('streamedOutput') as HTMLInputElement,
  settings: document.getElementById('settings') as HTMLButtonElement,
  settingsDialog: document.getElementById('settingsDialog') as HTMLDialogElement,
  settingsSave: document.getElementById('settingsSave') as HTMLButtonElement,
  settingsCancel: document.getElementById('settingsCancel') as HTMLButtonElement,
  settingsReset: document.getElementById('settingsReset') as HTMLButtonElement,
  smallUrl: document.getElementById('smallUrl') as HTMLInputElement,
  mediumUrl: document.getElementById('mediumUrl') as HTMLInputElement,
  moduleUrl: document.getElementById('moduleUrl') as HTMLInputElement,
  micLabel: document.getElementById('micLabel') as HTMLElement,
  sttStatus: document.getElementById('sttStatus') as HTMLParagraphElement,
  progress: document.getElementById('progress') as HTMLElement,
  archChips: document.getElementById('archChips') as HTMLElement,
  live: document.getElementById('live') as HTMLElement,
  frames: document.getElementById('frames') as HTMLElement,
};

// --- WebSocket relay ---------------------------------------------------------

type WsState = 'closed' | 'connecting' | 'open';
type FrameKind = 'partial' | 'final' | 'pause' | 'sys' | 'error';

let ws: WebSocket | null = null;
let wsState: WsState = 'closed';
let wasConnected = false;
/** Set when the user pressed Disconnect; suppresses auto-reconnect. */
let userStopped = false;
/** Frames captured while the socket is down, flushed once it opens. */
const pending: string[] = [];

function setWsState(state: WsState): void {
  wsState = state;
  els.wsDot.className = `dot${
    state === 'open' ? ' dot--open' : state === 'connecting' ? ' dot--connecting' : ''
  }`;
  els.wsToggle.textContent =
    state === 'open' ? 'Disconnect' : state === 'connecting' ? 'Cancel' : 'Connect';
  // Heading suffix, e.g. "WEBSOCKET CONNECTION — CONNECTED", colored by state.
  els.wsState.className = `ws-state ws-state--${state}`;
  els.wsState.textContent =
    state === 'open'
      ? '— connected'
      : state === 'connecting'
        ? '— connecting…'
        : '— disconnected';
}

/** The URL text box, or the default when blank. */
function currentWsUrl(): string {
  return els.wsUrl.value.trim() || DEFAULT_WS_URL;
}

/** True when the last connect attempt failed or the socket dropped on its own. */
function hadError(): boolean {
  return wsState === 'closed' && !userStopped;
}

/** Renders the "— disconnected" suffix in the error color after a failure. */
function markWsError(): void {
  if (!hadError()) return;
  els.wsState.className = 'ws-state ws-state--error';
  els.wsState.textContent = '— retrying every 10 s';
}

function connect(): void {
  if (wsState !== 'closed') {
    ws?.close();
    return;
  }
  userStopped = false;
  const url = currentWsUrl();
  setWsState('connecting');
  logEvent(`WebSocket: connecting to ${url}…`);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setWsState('closed');
    markWsError();
    logEvent(`WebSocket: invalid URL — ${(err as Error).message}`, 'error');
    return;
  }
  ws.onopen = () => {
    setWsState('open');
    wasConnected = true;
    logEvent(`WebSocket: connected to ${url}`);
    flushPending();
  };
  ws.onerror = () => {
    // onclose always follows; the failure is reported there.
  };
  ws.onclose = () => {
    ws = null;
    setWsState('closed');
    if (userStopped) {
      if (wasConnected) logEvent('WebSocket: disconnected (by user).');
      else logEvent('WebSocket: connect cancelled.', 'error');
    } else {
      markWsError();
      logEvent('WebSocket: connection failed or dropped — retrying every 10 s.', 'error');
    }
  };
}

/** Closes the socket; marks whether this was the user's choice. */
function disconnect(byUser = true): void {
  if (byUser) userStopped = true;
  ws?.close();
  ws = null;
}

function flushPending(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (pending.length) ws.send(pending.shift()!);
}

function logFrame(kind: FrameKind, text: string): void {
  const row = document.createElement('div');
  row.className = `frame frame--${kind}`;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString([], { hour12: false });
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = kind === 'pause' ? '⏸ pause (not sent)' : text;
  row.append(time, msg);
  els.frames.append(row);
  while (els.frames.childElementCount > FRAME_LOG_LIMIT) els.frames.firstElementChild?.remove();
  els.frames.scrollTop = els.frames.scrollHeight;
}

/** Logs a lifecycle event (WebSocket, model, binding) to the STATUS panel. */
function logEvent(text: string, kind: 'sys' | 'error' = 'sys'): void {
  logFrame(kind, text);
}

/**
 * Prepares transcribed text for the wire: when the sanitize option is on,
 * lowercases it, removes every non-alphanumeric character, and keeps spaces
 * as the only whitespace — other whitespace (tabs, newlines) is dropped, and
 * runs of spaces collapse to one with none at the edges. Unicode-aware, so
 * accented letters and digits survive. The `[speechEnded]` control frame is
 * exempt — stripping its punctuation would destroy the marker.
 */
function sanitizeForWire(text: string, kind: FrameKind): string {
  if (kind === 'final' && text === SPEECH_ENDED_FRAME) return text;
  if (!els.sanitize.checked) return text;
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

function logSeparator(): void {
  const sep = document.createElement('div');
  sep.className = 'sep';
  els.frames.append(sep);
}

/** True when the app itself may bring the relay back up. */
function mayReconnect(): boolean {
  return wsState === 'closed' && !userStopped;
}

/**
 * Sends one text frame to the WebSocket server, sanitized per the toggle.
 * Queues while the socket is down (and asks for a reconnect), so
 * transcription never stalls on the connection.
 */
function sendFrame(kind: FrameKind, rawText: string): void {
  const text = sanitizeForWire(rawText, kind);
  if (!text) return;
  if (kind === 'sys') {
    // Local diagnostics only — never queued or sent.
    logFrame(kind, text);
    if (mayReconnect()) connect();
    return;
  }
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(text);
    logFrame(kind, text);
    return;
  }
  pending.push(text);
  if (pending.length > QUEUE_LIMIT) pending.shift();
  logFrame(kind, text);
  if (mayReconnect()) connect();
}

// --- Transcription -----------------------------------------------------------

type ArchKey = 'tiny' | 'small' | 'medium';

const ARCHES: { key: ArchKey; name: string; label: string }[] = [
  { key: 'tiny', name: 'TinyStreaming', label: 'Tiny · fastest' },
  { key: 'small', name: 'SmallStreaming', label: 'Small · balanced' },
  { key: 'medium', name: 'MediumStreaming', label: 'Medium · most accurate' },
];

/** Canonical filenames every streaming model needs. */
const MODEL_FILES = [
  'frontend.ort',
  'encoder.ort',
  'adapter.ort',
  'cross_kv.ort',
  'decoder_kv.ort',
  'streaming_config.json',
  'tokenizer.bin',
] as const;

/**
 * Maps a model's canonical filenames onto candidate base URLs, tried in
 * order. The tiny model ships with the app; the others are first looked for
 * on the same server (`/models/…`, present when vendored) and then fetched
 * from the base URL configured in the settings dialog.
 */
function modelUrlCandidates(key: ArchKey): string[] {
  const bases: string[] = [];
  if (key === 'tiny') {
    bases.push('/models/tiny_streaming');
  } else {
    bases.push(`/models/${key}_streaming`);
    bases.push(loadModelUrls()[key]);
  }
  return bases;
}

let Moonshine: MoonshineModule;
let selectedArch: ArchKey = 'small';

/** Reads the persisted model size, falling back to 'small' if unknown. */
function loadArchPreference(): ArchKey {
  try {
    const saved = localStorage.getItem(MODEL_KEY) as ArchKey | null;
    if (saved && ARCHES.some((a) => a.key === saved)) return saved;
  } catch {
    // Private mode or storage disabled: the default (small) simply applies.
  }
  return 'small';
}
let mic: MicTranscriber | null = null;
let micReady: Promise<void> | null = null;
let loadGeneration = 0;
let running = false;
/** Last partial sent, so frames are only pushed when the sentence grows. */
let lastSent = '';

function sttStatus(text: string, kind?: 'error' | 'ready'): void {
  els.sttStatus.textContent = text;
  els.sttStatus.dataset.kind = kind ?? '';
}

function setProgress(fraction: number | null): void {
  els.progress.classList.toggle('is-active', fraction !== null);
  els.progress.classList.toggle('is-indeterminate', fraction === null || fraction < 0);
  if (fraction !== null && fraction >= 0) {
    els.progress.querySelector<HTMLElement>('.progress__bar')!.style.width = `${Math.round(
      fraction * 100,
    )}%`;
  }
  if (fraction !== null && fraction >= 1) {
    els.progress.classList.remove('is-active');
  }
}

/**
 * Called with the in-progress text of the sentence currently being spoken:
 * sends the continually expanding sentence over the WebSocket.
 */
function onPartial(text: string): void {
  els.live.textContent = text;
  if (!els.streamedOutput.checked) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  // Deduplicate on what actually goes on the wire, so "Hello," followed by
  // "Hello" does not send the sanitized "hello" twice.
  const wire = sanitizeForWire(trimmed, 'partial');
  if (wire && wire !== lastSent) {
    lastSent = wire;
    sendFrame('partial', trimmed);
  }
}

/**
 * Called once per finished line — when the model detects speech has stopped.
 * Sends the final sentence, optionally the `[speechEnded]` marker frame, and
 * resets so the next phrase starts from fresh. The pause row in the log notes
 * whether the marker was sent or suppressed.
 */
function onLine(line: TranscriptLine): void {
  els.live.textContent = '';
  lastSent = '';
  const text = line.text.trim();
  if (text) sendFrame('final', text);
  if (els.sendEvents.checked) {
    sendFrame('final', SPEECH_ENDED_FRAME);
  } else {
    logFrame('pause', '');
  }
  logSeparator();
}

/**
 * Decides where each model file comes from: probes the local /models/ path
 * first (streaming models only), falling back to the configured base URL for
 * any file the server does not have. Mixing is fine — the loader just wants a
 * URL per canonical filename.
 */
async function resolveModelUrls(key: ArchKey): Promise<Record<string, string>> {
  const bases = modelUrlCandidates(key);
  const localBase = bases[0];
  const result: Record<string, string> = {};
  for (const name of MODEL_FILES) {
    result[name] = `${bases[bases.length - 1]}/${name}`;
  }
  if (bases.length === 1) return result; // bundled model: all local

  // Probe each file on the local path; use the remote base for misses. The
  // probe checks the content type because SPA dev servers answer 200 with
  // index.html for unknown paths rather than a 404.
  const probes = await Promise.all(
    MODEL_FILES.map(async (name) => {
      try {
        const response = await fetch(`${localBase}/${name}`, { method: 'HEAD' });
        if (!response.ok) return false;
        const type = response.headers.get('content-type') ?? '';
        return !type.includes('text/html');
      } catch {
        return false;
      }
    }),
  );
  const remoteBase = bases[1];
  MODEL_FILES.forEach((name, i) => {
    if (!probes[i]) result[name] = `${remoteBase}/${name}`;
  });
  const localCount = probes.filter(Boolean).length;
  if (localCount === MODEL_FILES.length) {
    logEvent(`Model ${key}: loading from ${localBase} (all files local).`);
  } else if (localCount === 0) {
    logEvent(`Model ${key}: not on server — loading from ${remoteBase}.`);
  } else {
    logEvent(
      `Model ${key}: ${localCount}/${MODEL_FILES.length} files from ${localBase}, ` +
        `rest from ${remoteBase}.`,
    );
  }
  return result;
}

function buildMic(archName: string, key: ArchKey): MicTranscriber {
  const arch = (Moonshine.ModelArch as unknown as Record<string, number>)[archName];
  const instance = new Moonshine.MicTranscriber()
    .modelArch(arch)
    .onText(onPartial)
    .onLine(onLine)
    .onError((error: Error) => sttStatus(error.message, 'error'))
    .onProgress((fraction: number, _file: string) => setProgress(fraction));
  // modelsFrom() is applied once the URL map is resolved, right before load().
  return instance;
}

async function loadModel(): Promise<void> {
  const generation = ++loadGeneration; // a newer selection supersedes this load
  const arch = ARCHES.find((a) => a.key === selectedArch)!;
  sttStatus(`Loading the ${arch.key} model…`);
  logEvent(`Model ${arch.key}: loading…`);
  setProgress(null);
  const instance = buildMic(arch.name, arch.key);
  instance.modelsFrom(await resolveModelUrls(arch.key));
  try {
    await instance.load();
  } catch (err) {
    logEvent(`Model ${arch.key}: load failed — ${(err as Error).message}`, 'error');
    throw err;
  }
  if (generation !== loadGeneration) {
    instance.close();
    return;
  }
  mic = instance;
  setProgress(1);
  els.mic.disabled = false;
  logEvent(`Model ${arch.key}: loaded successfully.`);
  sttStatus('Model ready — press the mic and start talking.', 'ready');
}

/** Warm-starts the model download as soon as the page loads. */
function warmStart(): void {
  micReady = loadModel().catch((err: Error) => {
    sttStatus(`Model load failed: ${err.message}`, 'error');
  });
}

/** Loads the Moonshine binding; only failures are logged. */
async function loadBinding(): Promise<MoonshineModule> {
  const url = loadModuleUrlPreference();
  try {
    return await loadMoonshine();
  } catch (err) {
    logEvent(`Binding: failed to load from ${url} — ${(err as Error).message}`, 'error');
    throw err;
  }
}

async function startListening(): Promise<void> {
  els.mic.disabled = true;
  els.micLabel.textContent = 'Starting…';
  try {
    await micReady; // the model may still be downloading on first press
    if (!mic) await loadModel();
    await mic!.start();
    running = true;
    document.body.dataset.state = 'listening';
    els.mic.setAttribute('aria-label', 'Stop listening');
    els.micLabel.textContent = 'Listening';
    sttStatus('Transcribing', 'ready');
  } catch (err) {
    els.micLabel.textContent = 'Start listening';
    sttStatus((err as Error).message, 'error');
  } finally {
    els.mic.disabled = false;
  }
}

async function stopListening(): Promise<void> {
  els.mic.disabled = true;
  await mic?.stop(); // flushes any in-progress line through onLine()
  running = false;
  els.live.textContent = '';
  document.body.dataset.state = 'idle';
  els.mic.setAttribute('aria-label', 'Start listening');
  els.micLabel.textContent = 'Start listening';
  sttStatus('Stopped. The connection stays open for the next session.', 'ready');
  els.mic.disabled = false;
}

els.mic.addEventListener('click', () => {
  if (running) void stopListening();
  else void startListening();
});

// --- Model size chips ----------------------------------------------------------

async function selectArch(key: ArchKey): Promise<void> {
  if (key === selectedArch) return;
  selectedArch = key;
  try {
    localStorage.setItem(MODEL_KEY, key);
  } catch {
    // Nothing to do — the selection still applies for this session.
  }
  for (const chip of els.archChips.children) {
    chip.classList.toggle('is-active', (chip as HTMLElement).dataset.arch === key);
  }
  if (running) await stopListening();
  mic?.close();
  mic = null;
  warmStart();
}

function mountArchChips(): void {
  for (const arch of ARCHES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${arch.key === selectedArch ? ' is-active' : ''}`;
    chip.dataset.arch = arch.key;
    chip.textContent = arch.label;
    chip.addEventListener('click', () => void selectArch(arch.key));
    els.archChips.append(chip);
  }
}

// --- Settings ----------------------------------------------------------------------

// Restores the persisted "send events" preference (default: on).
try {
  const saved = localStorage.getItem(SEND_EVENTS_KEY);
  if (saved !== null) els.sendEvents.checked = saved === 'true';
} catch {
  // Private mode or storage disabled: the default (on) simply applies.
}

els.sendEvents.addEventListener('change', () => {
  try {
    localStorage.setItem(SEND_EVENTS_KEY, String(els.sendEvents.checked));
  } catch {
    // Nothing to do — the toggle still applies for this session.
  }
});

// Restores the persisted sanitize preference (default: off).
try {
  const saved = localStorage.getItem(SANITIZE_KEY);
  if (saved !== null) els.sanitize.checked = saved === 'true';
} catch {
  // Private mode or storage disabled: the default (off) simply applies.
}

els.sanitize.addEventListener('change', () => {
  try {
    localStorage.setItem(SANITIZE_KEY, String(els.sanitize.checked));
  } catch {
    // Nothing to do — the toggle still applies for this session.
  }
});

// Restores the persisted streamed-output preference (default: on).
try {
  const saved = localStorage.getItem(STREAMED_OUTPUT_KEY);
  if (saved !== null) els.streamedOutput.checked = saved === 'true';
} catch {
  // Private mode or storage disabled: the default (on) simply applies.
}

els.streamedOutput.addEventListener('change', () => {
  try {
    localStorage.setItem(STREAMED_OUTPUT_KEY, String(els.streamedOutput.checked));
  } catch {
    // Nothing to do — the toggle still applies for this session.
  }
});

// --- Settings dialog ---------------------------------------------------------------

function openSettings(): void {
  const urls = loadModelUrls();
  els.smallUrl.value = urls.small;
  els.mediumUrl.value = urls.medium;
  els.moduleUrl.value = loadModuleUrlPreference();
  els.settingsDialog.showModal();
}

els.settings.addEventListener('click', openSettings);

els.settingsSave.addEventListener('click', () => {
  const small = els.smallUrl.value.trim() || DEFAULT_MODEL_URLS.small;
  const medium = els.mediumUrl.value.trim() || DEFAULT_MODEL_URLS.medium;
  saveModelUrls({ small, medium });

  // Re-target the binding if its URL changed; reload everything it affects.
  const moduleUrl = els.moduleUrl.value.trim();
  const bindingChanged = moduleUrl !== loadModuleUrlPreference();
  if (bindingChanged) {
    saveModuleUrl(moduleUrl);
    resetMoonshine();
    mic?.close();
    mic = null;
  }
  els.settingsDialog.close();
  // A pending/running model load may now point somewhere else: reload it.
  if (!running && (mic || bindingChanged)) {
    mic = null;
    warmStart();
  }
});

els.settingsCancel.addEventListener('click', () => els.settingsDialog.close());

els.settingsReset.addEventListener('click', () => {
  els.smallUrl.value = DEFAULT_MODEL_URLS.small;
  els.mediumUrl.value = DEFAULT_MODEL_URLS.medium;
  els.moduleUrl.value = DEFAULT_MODULE_URL;
});

// --- WebSocket controls ----------------------------------------------------------

els.wsToggle.addEventListener('click', () => {
  if (wsState === 'closed') connect();
  else disconnect(true);
});

els.wsUrl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    disconnect(false);
    connect();
  }
});

// Retries the relay periodically unless the user explicitly disconnected.
setInterval(() => {
  if (wsState === 'closed' && !userStopped) connect();
}, RECONNECT_INTERVAL_MS);

// --- Startup ------------------------------------------------------------------------

void (async () => {
  Moonshine = await loadBinding();
  selectedArch = loadArchPreference();
  mountArchChips();
  warmStart();
  connect(); // first relay attempt; retries every 10 s until stopped
})();