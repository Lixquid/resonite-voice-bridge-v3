import {
  loadMoonshine,
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
/** Persisted flag: send {@link SPEECH_ENDED_FRAME} on pause? Default on. */
const SPEECH_ENDED_KEY = 'sendSpeechEnded';
/** Persisted flag: lowercase + strip non-alphanumerics from sent frames. */
const SANITIZE_KEY = 'sanitizeFrames';
/** Persisted key of the last used model size ({@link ArchKey}). */
const MODEL_KEY = 'modelArch';

const els = {
  wsDot: document.getElementById('wsDot') as HTMLSpanElement,
  wsUrl: document.getElementById('wsUrl') as HTMLInputElement,
  wsToggle: document.getElementById('wsToggle') as HTMLButtonElement,
  mic: document.getElementById('mic') as HTMLButtonElement,
  wsState: document.getElementById('wsState') as HTMLElement,
  speechEnded: document.getElementById('speechEnded') as HTMLInputElement,
  sanitize: document.getElementById('sanitize') as HTMLInputElement,
  micLabel: document.getElementById('micLabel') as HTMLElement,
  sttStatus: document.getElementById('sttStatus') as HTMLParagraphElement,
  progress: document.getElementById('progress') as HTMLElement,
  archChips: document.getElementById('archChips') as HTMLElement,
  live: document.getElementById('live') as HTMLElement,
  frames: document.getElementById('frames') as HTMLElement,
};

// --- WebSocket relay ---------------------------------------------------------

type WsState = 'closed' | 'connecting' | 'open';
type FrameKind = 'partial' | 'final' | 'pause' | 'sys';

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
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setWsState('closed');
    markWsError();
    console.error(`Invalid WebSocket URL: ${(err as Error).message}`);
    return;
  }
  ws.onopen = () => {
    setWsState('open');
    wasConnected = true;
    flushPending();
  };
  ws.onerror = () => {
    // onclose always follows; the closed-state render handles the message.
  };
  ws.onclose = () => {
    ws = null;
    setWsState('closed');
    markWsError();
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

/**
 * Canonical filenames of a streaming model, mapped onto the local copies
 * served from /models/<arch>/. Passed to `modelsFrom()`, which fetches them
 * into memory (caching via the browser Cache API) and feeds the in-memory
 * loader — so no CDN is ever contacted.
 */
function localModelUrls(key: ArchKey): Record<string, string> {
  const base = `/models/${key}_streaming`;
  const names = [
    'frontend.ort',
    'encoder.ort',
    'adapter.ort',
    'cross_kv.ort',
    'decoder_kv.ort',
    'streaming_config.json',
    'tokenizer.bin',
  ];
  return Object.fromEntries(names.map((name) => [name, `${base}/${name}`]));
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
  if (els.speechEnded.checked) {
    sendFrame('final', SPEECH_ENDED_FRAME);
  } else {
    logFrame('pause', '');
  }
  logSeparator();
}

function buildMic(archName: string, key: ArchKey): MicTranscriber {
  const arch = (Moonshine.ModelArch as unknown as Record<string, number>)[archName];
  return new Moonshine.MicTranscriber()
    .modelArch(arch)
    .modelsFrom(localModelUrls(key))
    .onText(onPartial)
    .onLine(onLine)
    .onError((error: Error) => sttStatus(error.message, 'error'))
    .onProgress((fraction: number, _file: string) => setProgress(fraction));
}

async function loadModel(): Promise<void> {
  const generation = ++loadGeneration; // a newer selection supersedes this load
  const arch = ARCHES.find((a) => a.key === selectedArch)!;
  sttStatus(`Loading the ${arch.key} model…`);
  setProgress(null);
  const instance = buildMic(arch.name, arch.key);
  await instance.load();
  if (generation !== loadGeneration) {
    instance.close();
    return;
  }
  mic = instance;
  setProgress(1);
  els.mic.disabled = false;
  sttStatus('Model ready — press the mic and start talking.', 'ready');
}

/** Warm-starts the model download as soon as the page loads. */
function warmStart(): void {
  micReady = loadModel().catch((err: Error) => {
    sttStatus(`Model load failed: ${err.message}`, 'error');
  });
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

// Restores the persisted `[speechEnded]` preference (default: on).
try {
  const saved = localStorage.getItem(SPEECH_ENDED_KEY);
  if (saved !== null) els.speechEnded.checked = saved === 'true';
} catch {
  // Private mode or storage disabled: the default (on) simply applies.
}

els.speechEnded.addEventListener('change', () => {
  try {
    localStorage.setItem(SPEECH_ENDED_KEY, String(els.speechEnded.checked));
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
  Moonshine = await loadMoonshine();
  selectedArch = loadArchPreference();
  mountArchChips();
  warmStart();
  connect(); // first relay attempt; retries every 10 s until stopped
})();