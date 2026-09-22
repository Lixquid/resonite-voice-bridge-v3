import {
  loadMoonshine,
  moduleUrl,
  type MicTranscriber,
  type MoonshineModule,
  type TranscriptLine,
} from './moonshine';

const DEFAULT_WS_URL = 'ws://localhost:9999';
const QUEUE_LIMIT = 500;
/** How often to retry the relay while it is down and the user wants it. */
const RECONNECT_INTERVAL_MS = 10_000;

const els = {
  wsDot: document.getElementById('wsDot') as HTMLSpanElement,
  wsUrl: document.getElementById('wsUrl') as HTMLInputElement,
  wsToggle: document.getElementById('wsToggle') as HTMLButtonElement,
  wsStatus: document.getElementById('wsStatus') as HTMLParagraphElement,
  mic: document.getElementById('mic') as HTMLButtonElement,
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
}

function wsStatus(text: string, kind?: 'error'): void {
  els.wsStatus.textContent = text;
  els.wsStatus.dataset.kind = kind ?? '';
}

function connect(): void {
  if (wsState !== 'closed') {
    ws?.close();
    return;
  }
  userStopped = false;
  const url = els.wsUrl.value.trim() || DEFAULT_WS_URL;
  setWsState('connecting');
  wsStatus(`Connecting to ${url}…`);
  try {
    ws = new WebSocket(url);
  } catch (err) {
    setWsState('closed');
    wsStatus(`Invalid WebSocket URL: ${(err as Error).message}`, 'error');
    return;
  }
  ws.onopen = () => {
    setWsState('open');
    wasConnected = true;
    wsStatus(`Connected to ${url}.`);
    flushPending();
  };
  ws.onerror = () => {
    if (wsState === 'connecting') wsStatus(`Could not connect to ${url}.`, 'error');
  };
  ws.onclose = () => {
    ws = null;
    setWsState('closed');
    if (userStopped) {
      if (wasConnected) wsStatus('Disconnected.');
    } else {
      wsStatus('Relay down — retrying every 10 seconds…', 'error');
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
  msg.textContent = kind === 'pause' ? '⏸ pause' : text;
  row.append(time, msg);
  els.frames.append(row);
  while (els.frames.childElementCount > 300) els.frames.firstElementChild?.remove();
  els.frames.scrollTop = els.frames.scrollHeight;
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
 * Sends one text frame to the WebSocket server. Queues while the socket is
 * down (and asks for a reconnect), so transcription never stalls on the
 * connection.
 */
function sendFrame(kind: FrameKind, text: string): void {
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

let Moonshine: MoonshineModule;
let selectedArch: ArchKey = 'small';
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
  if (trimmed && trimmed !== lastSent) {
    lastSent = trimmed;
    sendFrame('partial', trimmed);
  }
}

/**
 * Called once per finished line — when the model detects speech has stopped.
 * Sends the final sentence, notes the end of speech in the log (nothing is
 * sent for it), and resets so the next phrase starts from fresh.
 */
function onLine(line: TranscriptLine): void {
  els.live.textContent = '';
  lastSent = '';
  const text = line.text.trim();
  if (text) sendFrame('final', text);
  logFrame('pause', '');
  logSeparator();
}

function buildMic(archName: string): MicTranscriber {
  const arch = (Moonshine.ModelArch as unknown as Record<string, number>)[archName];
  return new Moonshine.MicTranscriber()
    .modelArch(arch)
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
  const instance = buildMic(arch.name);
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
    sttStatus('Transcribing — speak freely; frames stream as each sentence grows.', 'ready');
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
  if (moduleUrl().startsWith('http')) {
    console.info(`Loading Moonshine binding from ${moduleUrl()}`);
  }
  Moonshine = await loadMoonshine();
  mountArchChips();
  warmStart();
  connect(); // first relay attempt; retries every 10 s until stopped
})();