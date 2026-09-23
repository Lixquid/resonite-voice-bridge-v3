import {
  DEFAULT_MODULE_URL,
  loadMoonshine,
  loadModuleUrlPreference,
  resetMoonshine,
  saveModuleUrl,
  type MicTranscriber,
  type MoonshineModule,
  type TranscriptLine,
} from './moonshine';
import './style.css';

// --- Types ---------------------------------------------------------------------

type WsState = 'closed' | 'connecting' | 'open';
type FrameKind = 'partial' | 'final' | 'pause' | 'sys' | 'error' | 'cmd';
type ArchKey = 'tiny' | 'small' | 'medium';
/** Base URLs for the models that are not bundled with the app. */
type ModelUrls = Record<Exclude<ArchKey, 'tiny'>, string>;
/** Keys of the binding's ModelArch enum, e.g. `SmallStreaming`. */
type ArchName = keyof MoonshineModule['ModelArch'];

// --- Constants -------------------------------------------------------------------

const DEFAULT_WS_URL = 'ws://localhost:9999';
const QUEUE_LIMIT = 500;
/** Maximum rows kept in the on-page frame log. */
const FRAME_LOG_LIMIT = 500;
/** How often to retry the relay while it is down and the user wants it. */
const RECONNECT_INTERVAL_MS = 10_000;
/** Text frame sent when the model detects the end of speech, if enabled. */
const SPEECH_ENDED_FRAME = '[speechEnded]';
/** Event frames sent when the microphone is turned on or off. */
const ENABLED_FRAME = '[enabled]';
const DISABLED_FRAME = '[disabled]';
/** Event frames sent when the punctuation removal toggle changes. */
const REMOVE_PUNCTUATION_ENABLED_FRAME = '[removePunctuationEnabled]';
const REMOVE_PUNCTUATION_DISABLED_FRAME = '[removePunctuationDisabled]';
/** Event frames sent when the output streaming toggle changes. */
const OUTPUT_STREAMING_ENABLED_FRAME = '[outputStreamingEnabled]';
const OUTPUT_STREAMING_DISABLED_FRAME = '[outputStreamingDisabled]';
/** All event frames — sanitize is bypassed so these markers stay intact. */
const EVENT_FRAMES = new Set([
  SPEECH_ENDED_FRAME,
  ENABLED_FRAME,
  DISABLED_FRAME,
  REMOVE_PUNCTUATION_ENABLED_FRAME,
  REMOVE_PUNCTUATION_DISABLED_FRAME,
  OUTPUT_STREAMING_ENABLED_FRAME,
  OUTPUT_STREAMING_DISABLED_FRAME,
]);
/** Persisted flag: send event frames (e.g. {@link SPEECH_ENDED_FRAME})? Default on. */
const SEND_EVENTS_KEY = 'sendEvents';
/** Persisted flag: lowercase + strip non-alphanumerics from sent frames. */
const SANITIZE_KEY = 'sanitizeFrames';
/** Persisted flag: send partial frames as text is recognized? Default on. */
const STREAMED_OUTPUT_KEY = 'streamedOutput';
/** Persisted flag: honor commands arriving over the relay? Default on. */
const ENABLE_COMMANDS_KEY = 'enableCommands';
/** Persisted key of the last used model size ({@link ArchKey}). */
const MODEL_KEY = 'modelArch';
/** Persisted base URLs for the models not shipped with the app. */
const MODEL_URL_KEY = 'modelUrls';
/** Default download location for the small and medium models. */
const CDN_BASE = 'https://download.moonshine.ai/model';
const CDN_REV = 'quantized_26_07_30';

const DEFAULT_MODEL_URLS: ModelUrls = {
  small: `${CDN_BASE}/small-streaming-en/${CDN_REV}`,
  medium: `${CDN_BASE}/medium-streaming-en/${CDN_REV}`,
};

// --- localStorage helpers -----------------------------------------------------

/**
 * localStorage wrappers that degrade gracefully: private mode and disabled
 * storage throw, and the app treats that as "no preference" everywhere.
 */

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing to do — the value still applies for this session.
  }
}

/** Binds a checkbox to a persisted `true`/`false` preference. */
function bindCheckbox(input: HTMLInputElement, key: string, onChange?: () => void): void {
  const saved = readStorage(key);
  if (saved !== null) input.checked = saved === 'true';
  input.addEventListener('change', () => {
    writeStorage(key, String(input.checked));
    onChange?.();
  });
}

// --- Model URL preferences -------------------------------------------------------

/** Base URLs for non-bundled models, as persisted in localStorage. */
function loadModelUrls(): ModelUrls {
  try {
    const saved = JSON.parse(readStorage(MODEL_URL_KEY) ?? '{}') as Partial<ModelUrls>;
    return {
      small: saved.small?.trim() || DEFAULT_MODEL_URLS.small,
      medium: saved.medium?.trim() || DEFAULT_MODEL_URLS.medium,
    };
  } catch {
    return { ...DEFAULT_MODEL_URLS };
  }
}

function saveModelUrls(urls: ModelUrls): void {
  writeStorage(MODEL_URL_KEY, JSON.stringify(urls));
}

// --- DOM ------------------------------------------------------------------------

/** Looks up a required element, failing fast when the markup and script drift apart. */
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} — index.html and main.ts are out of sync.`);
  return el as T;
}

const els = {
  wsDot: byId<HTMLSpanElement>('wsDot'),
  wsUrl: byId<HTMLInputElement>('wsUrl'),
  wsToggle: byId<HTMLButtonElement>('wsToggle'),
  mic: byId<HTMLButtonElement>('mic'),
  wsState: byId<HTMLElement>('wsState'),
  sendEvents: byId<HTMLInputElement>('sendEvents'),
  sanitize: byId<HTMLInputElement>('sanitize'),
  streamedOutput: byId<HTMLInputElement>('streamedOutput'),
  enableCommands: byId<HTMLInputElement>('enableCommands'),
  settings: byId<HTMLButtonElement>('settings'),
  settingsDialog: byId<HTMLDialogElement>('settingsDialog'),
  settingsSave: byId<HTMLButtonElement>('settingsSave'),
  settingsCancel: byId<HTMLButtonElement>('settingsCancel'),
  settingsReset: byId<HTMLButtonElement>('settingsReset'),
  smallUrl: byId<HTMLInputElement>('smallUrl'),
  mediumUrl: byId<HTMLInputElement>('mediumUrl'),
  moduleUrl: byId<HTMLInputElement>('moduleUrl'),
  micLabel: byId<HTMLElement>('micLabel'),
  sttStatus: byId<HTMLParagraphElement>('sttStatus'),
  progress: byId<HTMLElement>('progress'),
  archChips: byId<HTMLElement>('archChips'),
  live: byId<HTMLElement>('live'),
  frames: byId<HTMLElement>('frames'),
};

// --- WebSocket relay -------------------------------------------------------------

let ws: WebSocket | null = null;
let wsState: WsState = 'closed';
let wasConnected = false;
/** Set when the user pressed Disconnect; suppresses auto-reconnect. */
let userStopped = false;
/** Set when connect() was called while a socket was already up; honored on close. */
let reconnectOnClose = false;
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

/** True when the app itself may bring the relay back up. */
function mayReconnect(): boolean {
  return wsState === 'closed' && !userStopped;
}

/** Renders the "— retrying" suffix in the error color after a failure. */
function markWsError(): void {
  if (!mayReconnect()) return;
  els.wsDot.classList.add('dot--error');
  els.wsState.className = 'ws-state ws-state--error';
  els.wsState.textContent = '— retrying every 10 s';
}

function connect(): void {
  if (wsState !== 'closed') {
    // Already up or dialing: close the current socket and redial it once the
    // close completes (e.g. the user pressed Enter with a new URL).
    reconnectOnClose = true;
    ws?.close();
    return;
  }
  userStopped = false;
  const url = currentWsUrl();
  setWsState('connecting');
  logEvent(`WebSocket: connecting to ${url}…`);
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    setWsState('closed');
    markWsError();
    logEvent(`WebSocket: invalid URL — ${(err as Error).message}`, 'error');
    return;
  }
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    setWsState('open');
    wasConnected = true;
    logEvent(`WebSocket: connected to ${url}`);
    flushPending();
  };
  socket.onmessage = (event) => {
    onCommand(String(event.data));
  };
  socket.onerror = () => {
    // onclose always follows; the failure is reported there.
  };
  socket.onclose = () => {
    if (ws !== socket) return; // superseded by a newer connection attempt
    ws = null;
    setWsState('closed');
    if (reconnectOnClose) {
      reconnectOnClose = false;
      connect();
      return;
    }
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
  reconnectOnClose = false;
  ws?.close();
}

function flushPending(): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (pending.length) ws.send(pending.shift()!);
}

// --- Frame log --------------------------------------------------------------------

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

function logSeparator(): void {
  const sep = document.createElement('div');
  sep.className = 'sep';
  els.frames.append(sep);
}

/**
 * Prepares transcribed text for the wire: when the sanitize option is on,
 * lowercases it, removes every non-alphanumeric character, and keeps spaces
 * as the only whitespace — other whitespace (tabs, newlines) is dropped, and
 * runs of spaces collapse to one with none at the edges. Unicode-aware, so
 * accented letters and digits survive. Event control frames such as
 * `[speechEnded]` are exempt — stripping their punctuation would destroy the
 * markers.
 */
function sanitizeForWire(text: string): string {
  if (EVENT_FRAMES.has(text)) return text;
  if (!els.sanitize.checked) return text;
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Sends one text frame to the WebSocket server, sanitized per the toggle.
 * Queues while the socket is down (and asks for a reconnect), so
 * transcription never stalls on the connection.
 */
function sendFrame(kind: FrameKind, rawText: string): void {
  const text = sanitizeForWire(rawText);
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

// --- Transcription -----------------------------------------------------------------

interface Arch {
  key: ArchKey;
  name: ArchName;
  label: string;
}

const ARCHES: Arch[] = [
  { key: 'tiny', name: 'TinyStreaming', label: 'Tiny · fastest' },
  { key: 'small', name: 'SmallStreaming', label: 'Small · balanced' },
  { key: 'medium', name: 'MediumStreaming', label: 'Medium · most accurate' },
];

/** Default model size when nothing (valid) is persisted. */
const DEFAULT_ARCH: ArchKey = 'small';

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

let Moonshine: MoonshineModule;
let selectedArch: ArchKey = DEFAULT_ARCH;
let mic: MicTranscriber | null = null;
let micReady: Promise<void> | null = null;
let loadGeneration = 0;
let running = false;
/** Last partial sent, so frames are only pushed when the sentence grows. */
let lastSent = '';

/** Reads the persisted model size, falling back to the default if unknown. */
function loadArchPreference(): ArchKey {
  const saved = readStorage(MODEL_KEY) as ArchKey | null;
  return saved && ARCHES.some((a) => a.key === saved) ? saved : DEFAULT_ARCH;
}

function setStatus(text: string, kind?: 'error' | 'ready' | 'info'): void {
  els.sttStatus.textContent = text;
  els.sttStatus.dataset.kind = kind ?? '';
}

function setProgress(fraction: number | null): void {
  const determinate = fraction !== null && fraction >= 0 && fraction < 1;
  els.progress.classList.toggle('is-active', fraction !== null && fraction < 1);
  els.progress.classList.toggle('is-indeterminate', !determinate);
  if (determinate) {
    els.progress.querySelector<HTMLElement>('.progress__bar')!.style.width = `${Math.round(
      (fraction as number) * 100,
    )}%`;
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
  const wire = sanitizeForWire(trimmed);
  if (wire && wire !== lastSent) {
    lastSent = wire;
    sendFrame('partial', trimmed);
  }
}

/**
 * Sends an event control frame (e.g. `[speechEnded]`) when the "Send Events"
 * toggle is on; silently suppressed otherwise. Sent as a `final` frame so
 * sanitize never mangles the marker. Returns whether the frame was sent.
 */
function sendEvent(frame: string): boolean {
  if (!els.sendEvents.checked) return false;
  sendFrame('final', frame);
  return true;
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
  if (!sendEvent(SPEECH_ENDED_FRAME)) logFrame('pause', '');
  logSeparator();
}

/** Sends the `[enabled]` event frame after the microphone has been enabled. */
function onMicEnabled(): void {
  sendEvent(ENABLED_FRAME);
}

/** Sends the `[disabled]` event frame after the microphone has been disabled. */
function onMicDisabled(): void {
  sendEvent(DISABLED_FRAME);
}

/**
 * Sends the `[removePunctuationEnabled]` / `[removePunctuationDisabled]`
 * event frame whenever the punctuation removal toggle changes.
 */
function onRemovePunctuationToggled(): void {
  sendEvent(
    els.sanitize.checked ? REMOVE_PUNCTUATION_ENABLED_FRAME : REMOVE_PUNCTUATION_DISABLED_FRAME,
  );
}

/**
 * Sends the `[outputStreamingEnabled]` / `[outputStreamingDisabled]` event
 * frame whenever the output streaming toggle changes.
 */
function onOutputStreamingToggled(): void {
  sendEvent(
    els.streamedOutput.checked ? OUTPUT_STREAMING_ENABLED_FRAME : OUTPUT_STREAMING_DISABLED_FRAME,
  );
}

// --- Commands -----------------------------------------------------------------------

/**
 * A command received over the WebSocket relay (see COMMANDS.md). Only honored
 * while the "Enable Commands" setting is on; anything else arriving on the
 * socket is ignored with a note in the log.
 */
function onCommand(rawCommand: string): void {
  const command = rawCommand.trim();
  if (!command) return;
  if (!els.enableCommands.checked) {
    logEvent(`Command ignored (commands disabled): ${command}`);
    return;
  }
  logFrame('cmd', command);
  if (!runCommand(command)) {
    logEvent(`Unknown command: ${command}`, 'error');
  }
}

/**
 * Applies a setting toggle from a command: updates the checkbox, persists the
 * preference, and fires the change callback (which sends the corresponding
 * event frame). A no-op when the state already matches, so redundant
 * commands do not spam the relay with event frames.
 */
function setToggle(
  input: HTMLInputElement,
  checked: boolean,
  key: string,
  onChange: () => void,
): void {
  if (input.checked === checked) return;
  input.checked = checked;
  writeStorage(key, String(checked));
  onChange();
}

/** Runs one relay command; returns whether it was recognized. */
function runCommand(command: string): boolean {
  switch (command) {
    case 'toggle':
      if (running) void stopListening();
      else void startListening();
      return true;
    case 'enable':
      if (!running) void startListening();
      return true;
    case 'disable':
      if (running) void stopListening();
      return true;
    case 'removePunctuationToggle':
      setToggle(els.sanitize, !els.sanitize.checked, SANITIZE_KEY, onRemovePunctuationToggled);
      return true;
    case 'removePunctuationEnable':
      setToggle(els.sanitize, true, SANITIZE_KEY, onRemovePunctuationToggled);
      return true;
    case 'removePunctuationDisable':
      setToggle(els.sanitize, false, SANITIZE_KEY, onRemovePunctuationToggled);
      return true;
    case 'outputStreamingToggle':
      setToggle(
        els.streamedOutput,
        !els.streamedOutput.checked,
        STREAMED_OUTPUT_KEY,
        onOutputStreamingToggled,
      );
      return true;
    case 'outputStreamingEnable':
      setToggle(els.streamedOutput, true, STREAMED_OUTPUT_KEY, onOutputStreamingToggled);
      return true;
    case 'outputStreamingDisable':
      setToggle(els.streamedOutput, false, STREAMED_OUTPUT_KEY, onOutputStreamingToggled);
      return true;
    default:
      return false;
  }
}

/**
 * Local and remote base URLs for a model's files: the tiny model ships with
 * the app; the others are first looked for on the same server (`/models/…`,
 * present when vendored) and then fetched from the URL configured in the
 * settings dialog.
 */
function modelSources(key: ArchKey): { local: string; remote?: string } {
  if (key === 'tiny') return { local: '/models/tiny_streaming' };
  return { local: `/models/${key}_streaming`, remote: loadModelUrls()[key] };
}

/**
 * Decides where each model file comes from: probes the local /models/ path
 * first (streaming models only), falling back to the configured base URL for
 * any file the server does not have. Mixing is fine — the loader just wants a
 * URL per canonical filename.
 */
async function resolveModelUrls(key: ArchKey): Promise<Record<string, string>> {
  const { local, remote } = modelSources(key);
  const localUrls = Object.fromEntries(MODEL_FILES.map((name) => [name, `${local}/${name}`]));
  if (!remote) return localUrls; // bundled model: all local

  // Probe each file on the local path; use the remote base for misses. The
  // probe checks the content type because SPA dev servers answer 200 with
  // index.html for unknown paths rather than a 404.
  const probes = await Promise.all(
    MODEL_FILES.map(async (name) => {
      try {
        const response = await fetch(`${local}/${name}`, { method: 'HEAD' });
        if (!response.ok) return false;
        const type = response.headers.get('content-type') ?? '';
        return !type.includes('text/html');
      } catch {
        return false;
      }
    }),
  );
  const result = { ...localUrls };
  MODEL_FILES.forEach((name, i) => {
    if (!probes[i]) result[name] = `${remote}/${name}`;
  });
  const localCount = probes.filter(Boolean).length;
  if (localCount === MODEL_FILES.length) {
    logEvent(`Model ${key}: loading from ${local} (all files local).`);
  } else if (localCount === 0) {
    logEvent(`Model ${key}: not on server — loading from ${remote}.`);
  } else {
    logEvent(
      `Model ${key}: ${localCount}/${MODEL_FILES.length} files from ${local}, ` +
        `rest from ${remote}.`,
    );
  }
  return result;
}

function buildMic(arch: Arch): MicTranscriber {
  return new Moonshine.MicTranscriber()
    .modelArch(Moonshine.ModelArch[arch.name])
    .onText(onPartial)
    .onLine(onLine)
    .onError((error) => setStatus(error.message, 'error'))
    .onProgress((fraction) => setProgress(fraction));
}

async function loadModel(): Promise<void> {
  const generation = ++loadGeneration; // a newer selection supersedes this load
  const arch = ARCHES.find((a) => a.key === selectedArch)!;
  setStatus(`Loading the ${arch.key} model…`);
  logEvent(`Model ${arch.key}: loading…`);
  setProgress(null);
  const instance = buildMic(arch);
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
  if (!running) showReadyState();
  logEvent(`Model ${arch.key}: loaded successfully.`);
}

// --- Microphone states ---------------------------------------------------------

/** An error whose {@link Error.name} marks it as a microphone permission denial. */
function micPermissionError(): Error {
  const err = new Error('The microphone permission was denied');
  err.name = 'NotAllowedError';
  return err;
}

/** True when the error is a microphone permission denial. */
function isMicPermissionError(err: unknown): boolean {
  const name = (err as DOMException | null)?.name;
  return name === 'NotAllowedError' || name === 'SecurityError';
}

/** Model loaded and idle: the mic can be pressed again. */
function showReadyState(): void {
  els.micLabel.textContent = 'Ready';
  setStatus('Model ready - press the mic to start sending', 'ready');
}

/** Microphone access refused by the user (or previously denied). */
function showPermissionDeniedState(): void {
  els.micLabel.textContent = 'Failed';
  setStatus('The microphone permission was denied', 'error');
}

/** The current permission state, falling back to 'prompt' when unqueryable. */
async function currentMicPermission(): Promise<PermissionState> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state;
  } catch {
    return 'prompt'; // The Permissions API may not support 'microphone' here.
  }
}

/**
 * Ensures microphone access is granted before starting the transcriber.
 * Drives the "Waiting for Microphone Permission..." state while the browser
 * dialog is open, and resolves to a {@link micPermissionError} when denied.
 */
async function ensureMicPermission(): Promise<void> {
  const state = await currentMicPermission();
  if (state === 'denied') throw micPermissionError();
  if (state !== 'prompt') return; // already granted
  els.micLabel.textContent = 'Waiting for Microphone Permission...';
  setStatus('Authorize the permission dialog to start sending', 'info');
  try {
    // Triggers the browser's permission dialog; the stream is released right
    // away — the transcriber opens its own once permission is granted.
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (err) {
    if (isMicPermissionError(err)) throw micPermissionError();
    throw err;
  }
}

/** Warm-starts the model download as soon as the page loads. */
function warmStart(): void {
  micReady = loadModel().catch((err: Error) => {
    setStatus(`Model load failed: ${err.message}`, 'error');
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
    await ensureMicPermission();
    await mic!.start();
    running = true;
    document.body.dataset.state = 'listening';
    els.mic.setAttribute('aria-label', 'Stop listening');
    els.micLabel.textContent = 'Listening';
    setStatus('Transcribing', 'ready');
    onMicEnabled();
  } catch (err) {
    if (isMicPermissionError(err)) {
      showPermissionDeniedState();
    } else {
      els.micLabel.textContent = 'Ready';
      setStatus((err as Error).message, 'error');
    }
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
  showReadyState();
  els.mic.disabled = false;
  onMicDisabled();
}

els.mic.addEventListener('click', () => {
  if (running) void stopListening();
  else void startListening();
});

// --- Model size chips ------------------------------------------------------------

async function selectArch(key: ArchKey): Promise<void> {
  if (key === selectedArch) return;
  selectedArch = key;
  writeStorage(MODEL_KEY, key);
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

// Restores the persisted toggle preferences (checkbox defaults come from the markup).
bindCheckbox(els.sendEvents, SEND_EVENTS_KEY);
bindCheckbox(els.sanitize, SANITIZE_KEY, onRemovePunctuationToggled);
bindCheckbox(els.streamedOutput, STREAMED_OUTPUT_KEY, onOutputStreamingToggled);
bindCheckbox(els.enableCommands, ENABLE_COMMANDS_KEY);

// --- Settings dialog -----------------------------------------------------------------

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

// --- WebSocket controls ----------------------------------------------------------------

els.wsToggle.addEventListener('click', () => {
  if (wsState === 'closed') connect();
  else disconnect(true);
});

els.wsUrl.addEventListener('keydown', (event) => {
  // Reconnect (or redial, if currently connected) with the edited URL.
  if (event.key === 'Enter') connect();
});

// Retries the relay periodically unless the user explicitly disconnected.
setInterval(() => {
  if (mayReconnect()) connect();
}, RECONNECT_INTERVAL_MS);

// --- Documentation copy buttons ----------------------------------------------------------

/** Shows a transient "Copied!" toast after a copy action. */
function showToast(): void {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = 'Copied!';
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

document.querySelectorAll<HTMLButtonElement>('.doc-event-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    void navigator.clipboard.writeText(btn.getAttribute('data-event') ?? '');
    showToast();
  });
});

// --- Startup --------------------------------------------------------------------------------

void (async () => {
  try {
    Moonshine = await loadBinding();
  } catch {
    // loadBinding already logged the details to the STATUS panel; make the
    // failure visible in the mic area instead of dying silently.
    els.micLabel.textContent = 'Failed';
    setStatus('The Moonshine binding failed to load', 'error');
    return;
  }
  selectedArch = loadArchPreference();
  mountArchChips();
  warmStart();
  connect(); // first relay attempt; retries every 10 s until stopped
})();