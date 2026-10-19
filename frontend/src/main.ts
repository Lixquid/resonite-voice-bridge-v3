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
import { applyStaticTranslations, setLanguage, t } from './i18n';
import './style.css';
import { needlePrewarm, needleRun, type NeedleCall } from './needle';
import {
  setTranslationDirection,
  translateText,
  type TranslationDirection as EngineDirection,
} from './translate';

// --- Types ---------------------------------------------------------------------

type WsState = 'closed' | 'connecting' | 'open';
type FrameKind = 'partial' | 'final' | 'pause' | 'sys' | 'error' | 'loading' | 'cmd' | 'tool';
type ArchKey = 'tiny' | 'small' | 'medium';
/** Base URLs for the models that are not bundled with the app. */
type ModelUrls = Record<Exclude<ArchKey, 'tiny'>, string>;
/** Keys of the binding's ModelArch enum, e.g. `SmallStreaming`. */
type ArchName = keyof MoonshineModule['ModelArch'];
/** A word to replace in outgoing voice text, and what to replace it with. */
interface WordReplacement {
  target: string;
  replacement: string;
}
/**
 * One of the streams Stream Configuration can emit: the default wire text,
 * the model's raw output, or its fully normalized form.
 */
type StreamKey = 'default' | 'original' | 'normalized';
/**
 * How a frame's text is prepared for the wire: `default` follows the Remove
 * Punctuation toggle, `raw` sends the text untouched, and `normalize` always
 * strips punctuation regardless of the toggle.
 */
type SanitizeMode = 'default' | 'raw' | 'normalize';
/**
 * The Translation Stream setting: `off` disables translation entirely (no
 * model is loaded and nothing is queued); the other values pick the OPUS-MT
 * direction and with it the prefixed stream the output goes out on.
 */
type TranslationSetting = 'off' | EngineDirection;
/**
 * One of the welcome card's mutually exclusive choices: the three large
 * buttons each apply a settings preset, "all" shows everything.
 */
type WelcomeChoice = 'transcription' | 'en-jp' | 'jp-en' | 'all';

// --- Constants -------------------------------------------------------------------

const DEFAULT_WS_URL = 'ws://localhost:6789';
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
/** Event frames sent when the word replacement toggle changes. */
const REPLACEMENT_ENABLED_FRAME = '[replacementEnabled]';
const REPLACEMENT_DISABLED_FRAME = '[replacementDisabled]';
/** Event frames sent when the natural language tool calling toggle changes. */
const NL_TOOLS_ENABLED_FRAME = '[naturalLanguageToolsEnabled]';
const NL_TOOLS_DISABLED_FRAME = '[naturalLanguageToolsDisabled]';
/** Event frames sent when translation (the Translation Stream) turns on or off. */
const TRANSLATION_ENABLED_FRAME = '[translationEnabled]';
const TRANSLATION_DISABLED_FRAME = '[translationDisabled]';
/** Prefixes marking frames from the extra streams of Stream Configuration. */
const ORIGINAL_STREAM_PREFIX = '[stream.orig]';
const NORMALIZED_STREAM_PREFIX = '[stream.norm]';
/**
 * Prefixes marking frames from the Translation Stream: the direction decides
 * which one applies — EN → JP output goes to `[stream.trans.JP]`, JP → EN
 * output to `[stream.trans.EN]`.
 */
const TRANSLATION_JP_STREAM_PREFIX = '[stream.trans.JP]';
const TRANSLATION_EN_STREAM_PREFIX = '[stream.trans.EN]';
/** Frame prefix marking a natural-language tool call (see needle.ts). */
const TOOL_SEP_FRAME = '[tool.sep]';
/** ASCII group/record separators framing tool call keys and pairs. */
const TOOL_GROUP_SEP = '\x1D';
const TOOL_RECORD_SEP = '\x1E';
/** Starter tool definition block shown (and sent) when nothing is saved. */
const DEFAULT_TOOL_DEFINITIONS = JSON.stringify(
  [
    {
      name: 'spawn',
      description: 'Spawn an item in front of the user.',
      parameters: {
        type: 'object',
        properties: {
          ITEM: { type: 'string', description: 'The item to spawn, e.g. dev_tool.' },
        },
        required: ['ITEM'],
      },
    },
  ],
  null,
  2,
);
/** All event frames — sanitize is bypassed so these markers stay intact. */
const EVENT_FRAMES = new Set([
  SPEECH_ENDED_FRAME,
  ENABLED_FRAME,
  DISABLED_FRAME,
  REMOVE_PUNCTUATION_ENABLED_FRAME,
  REMOVE_PUNCTUATION_DISABLED_FRAME,
  OUTPUT_STREAMING_ENABLED_FRAME,
  OUTPUT_STREAMING_DISABLED_FRAME,
  REPLACEMENT_ENABLED_FRAME,
  REPLACEMENT_DISABLED_FRAME,
  NL_TOOLS_ENABLED_FRAME,
  NL_TOOLS_DISABLED_FRAME,
  TRANSLATION_ENABLED_FRAME,
  TRANSLATION_DISABLED_FRAME,
]);
/** Persisted flag: send event frames (e.g. {@link SPEECH_ENDED_FRAME})? Default on. */
const SEND_EVENTS_KEY = 'sendEvents';
/** Persisted flag: lowercase + strip non-alphanumerics from sent frames. */
const SANITIZE_KEY = 'sanitizeFrames';
/** Persisted flag: send partial frames as text is recognized? Default on. */
const STREAMED_OUTPUT_KEY = 'streamedOutput';
/** Persisted flag: honor commands arriving over the relay? Default on. */
const ENABLE_COMMANDS_KEY = 'enableCommands';
/** Persisted flag: swap words per the replacement list before sending? */
const WORD_REPLACEMENT_KEY = 'wordReplacement';
/** Persisted flag: emit the extra original/normalized streams? */
const STREAM_CONFIG_KEY = 'streamConfig';
/** Persisted flags for the individual streams of Stream Configuration. */
const STREAM_DEFAULT_KEY = 'streamDefault';
const STREAM_ORIGINAL_KEY = 'streamOriginal';
const STREAM_NORMALIZED_KEY = 'streamNormalized';
/** Persisted flag: emit the Translation Stream? */
const STREAM_TRANSLATION_KEY = 'streamTranslation';
/** Persisted translation direction: 'off', {@link EngineDirection}, or invalid. */
const TRANSLATION_DIRECTION_KEY = 'translationDirection';
/** How long to wait after the last partial update before translating it. */
const TRANSLATION_PARTIAL_DEBOUNCE_MS = 500;
/** Persisted JSON list of {@link WordReplacement} entries. */
const WORD_REPLACEMENTS_KEY = 'wordReplacements';
/** Persisted flag: run wake-word text through the Needle 3 engine? */
const NL_TOOLS_KEY = 'nlTools';
/** Persisted wake word gating tool processing. */
const NL_WAKE_WORD_KEY = 'nlWakeWord';
/** Persisted needle3 tool definition JSON block. */
const NL_TOOLS_TEXT_KEY = 'nlToolsText';
/** Persisted JSON block of disabled tool definitions. */
const NL_DISABLED_TOOLS_TEXT_KEY = 'nlDisabledToolsText';
/** Persisted tool-call confidence threshold (0-1). */
const NL_CONFIDENCE_KEY = 'nlConfidence';
/** Fallback confidence threshold when the persisted value is unusable. */
const DEFAULT_CONFIDENCE = 0.5;
/** Persisted key of the last used model size ({@link ArchKey}). */
const MODEL_KEY = 'modelArch';
/** Persisted base URLs for the models not shipped with the app. */
const MODEL_URL_KEY = 'modelUrls';
/** Persisted welcome card choice ({@link WelcomeChoice}). */
const WELCOME_KEY = 'welcomeChoice';

/**
 * Default download locations for the models that do not ship with the app:
 * both are served by the desktop client itself, which downloads them into a
 * cache folder on first start and serves them from there — the frontend
 * never touches an external service. The settings dialog can still override
 * these with any other base URL.
 */
const DEFAULT_MODEL_URLS: ModelUrls = {
  small: '/models/small_streaming',
  medium: '/models/medium_streaming',
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

// --- Word Replacement panel ---------------------------------------------------

/** Reads the persisted replacement entries, tolerating malformed storage. */
function loadReplacements(): WordReplacement[] {
  try {
    const saved = JSON.parse(readStorage(WORD_REPLACEMENTS_KEY) ?? '[]');
    if (!Array.isArray(saved)) return [];
    return saved.map((entry) => ({
      target: String(entry?.target ?? ''),
      replacement: String(entry?.replacement ?? ''),
    }));
  } catch {
    return [];
  }
}

/** Persists the current replacement entries. */
function saveReplacements(entries: WordReplacement[]): void {
  writeStorage(WORD_REPLACEMENTS_KEY, JSON.stringify(entries));
}

/** Reads the entries back out of the panel, so unsaved edits are live. */
function collectReplacements(): WordReplacement[] {
  return [...els.wrList.querySelectorAll<HTMLDivElement>('.wr-row')].map((row) => ({
    target: row.querySelector<HTMLInputElement>('.wr-target')!.value,
    replacement: row.querySelector<HTMLInputElement>('.wr-replacement')!.value,
  }));
}

/** Persists the panel contents whenever an entry is edited or removed. */
function onReplacementsChanged(): void {
  saveReplacements(collectReplacements());
}

/** Builds one editable entry row (target → replacement, with a delete x). */
function buildReplacementRow(entry: WordReplacement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'wr-row';

  const target = document.createElement('input');
  target.type = 'text';
  target.className = 'wr-target';
  target.placeholder = t('nl.placeholder.target');
  target.setAttribute('aria-label', t('nl.placeholder.target'));
  target.value = entry.target;

  const arrow = document.createElement('span');
  arrow.className = 'wr-arrow';
  arrow.textContent = t('nl.arrow');
  arrow.setAttribute('aria-hidden', 'true');

  const replacement = document.createElement('input');
  replacement.type = 'text';
  replacement.className = 'wr-replacement';
  replacement.placeholder = t('nl.placeholder.replacement');
  replacement.setAttribute('aria-label', t('nl.placeholder.replacement'));
  replacement.value = entry.replacement;

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'wr-remove';
  remove.textContent = t('nl.remove');
  remove.setAttribute('aria-label', t('nl.deleteEntry'));
  remove.title = t('nl.deleteEntry');
  remove.addEventListener('click', () => {
    row.remove();
    onReplacementsChanged();
  });

  // Every keystroke persists, so the list survives a reload mid-edit.
  target.addEventListener('input', onReplacementsChanged);
  replacement.addEventListener('input', onReplacementsChanged);

  row.append(target, arrow, replacement, remove);
  return row;
}

/** Rebuilds the entry list from localStorage. */
function renderReplacements(): void {
  els.wrList.replaceChildren(...loadReplacements().map(buildReplacementRow));
}

/**
 * Reacts to the Stream Configuration toggle: when it turns off, the prefixed
 * streams' deduplication state is cleared so a re-enable mid-sentence cannot
 * suppress their next frame. Visibility itself is declarative — derived from
 * state in {@link updateVisibility} — so nothing is hidden here.
 */
function onStreamConfigToggled(): void {
  if (!els.streamConfig.checked) {
    lastSent.original = '';
    lastSent.normalized = '';
  }
  updateVisibility();
}

/** Reads the persisted translation direction, tolerating unknown values. */
function loadTranslationDirection(): TranslationSetting {
  const saved = readStorage(TRANSLATION_DIRECTION_KEY) as TranslationSetting | null;
  return saved === 'en-jp' || saved === 'jp-en' || saved === 'off' ? saved : 'off';
}

/** True when translation is both enabled and pointed at a direction. */
function translationActive(): boolean {
  return els.streamTranslation.checked && els.translationDirection.value !== 'off';
}

/** The engine direction matching the current setting (only when active). */
function translationEngineDirection(): EngineDirection | null {
  return translationActive() ? (els.translationDirection.value as EngineDirection) : null;
}

/** The wire prefix for the current direction (only when active). */
function translationStreamPrefix(): string | null {
  const dir = els.translationDirection.value;
  if (!translationActive()) return null;
  return dir === 'en-jp' ? TRANSLATION_JP_STREAM_PREFIX : TRANSLATION_EN_STREAM_PREFIX;
}

/** Sets the Translation panel status line (model downloads, errors). */
function setTranslationStatus(text: string): void {
  els.translationStatus.textContent = text;
  if (text) logEvent(text, 'loading');
}

/**
 * Applies the current translation setting: shows or hides the panel, loads
 * or releases the engine (lazy — nothing runs while disabled or off), and
 * sends the enabled/disabled event frame whenever the effective state
 * changes. `announce` is false during startup restore, where state changes
 * must not emit frames.
 */
function applyTranslationState(announce = true): void {
  lastSentTranslation = '';
  cancelPartialTranslation();
  setTranslationDirection(translationEngineDirection(), translationHandlers);
  const active = translationActive();
  if (announce && active !== translationWasActive) {
    sendEvent(active ? TRANSLATION_ENABLED_FRAME : TRANSLATION_DISABLED_FRAME);
  }
  translationWasActive = active;
}

/** Change handler for the Translation Stream toggle. */
function onTranslationToggled(): void {
  applyTranslationState();
  updateVisibility();
}

/**
 * Progress and log plumbing for the translation engine: progress goes to the
 * panel's status line, errors and diagnostics to the event log.
 */
const translationHandlers = {
  onStatus: setTranslationStatus,
  onLog: (message: string, isError?: boolean) => logEvent(message, isError ? 'error' : 'sys'),
};

/**
 * Downloads the Needle 3 engine and model in the background so the first
 * Natural Language Tool Calling request does not pay the download cost.
 * Failures are logged; the next request (or prewarm) retries the load.
 */
function prewarmNeedle(): void {
  void needlePrewarm(setNlStatus).catch((err) => {
    setNlStatus('');
    logEvent(t('needle.log.error', { message: (err as Error).message }), 'error');
  });
}

/**
 * Prewarms the Needle 3 model whenever Natural Language Tool Calling is on
 * and its card is visible (see {@link showEverything}) — including on page
 * load, when the setting was already enabled.
 */
function prewarmNlTools(): void {
  if (els.nlTools.checked && showEverything()) prewarmNeedle();
}

/** Change handler for the Natural Language Tool Calling toggle. */
function onNlToolsChanged(): void {
  prewarmNlTools();
  updateVisibility();
}

/** Sets the Natural Language Tools panel status line (progress, errors). */
function setNlStatus(text: string): void {
  els.nlStatus.textContent = text;
  if (text) logEvent(text, 'loading');
}

// --- Welcome card ----------------------------------------------------------------

/** Reads the persisted welcome choice; null when nothing (valid) is saved. */
function loadWelcomeChoice(): WelcomeChoice | null {
  const saved = readStorage(WELCOME_KEY);
  return saved === 'transcription' || saved === 'en-jp' || saved === 'jp-en' || saved === 'all'
    ? saved
    : null;
}

/**
 * True when the welcome card's "Show me everything" choice is the active
 * one. Card visibility is derived from this flag plus the settings
 * checkboxes in {@link updateVisibility} — the single, declarative source of
 * truth; no event handler sets `hidden` on the cards itself.
 */
function showEverything(): boolean {
  return loadWelcomeChoice() === 'all';
}

/**
 * Computes card visibility from current state — the persisted welcome choice
 * plus the settings checkboxes — with no stateful hiding anywhere:
 *
 * - Settings card: the checkboxes and the Advanced Settings dropdown are
 *   visible only under "Show me everything"; the voice recognition model
 *   chips stay visible always.
 * - Word Replacement: the setting on AND "Show me everything".
 * - Stream Configuration: the setting on AND "Show me everything".
 * - Translation: the Stream Configuration setting on AND the Translation
 *   Stream on AND "Show me everything".
 * - Natural Language Tools: the setting on AND "Show me everything".
 *
 * Runs after every state change that can affect visibility: a welcome
 * choice (via {@link applyWelcomeChoice}) and each toggle's change event.
 */
function updateVisibility(): void {
  const everything = showEverything();
  for (const el of els.settingsPanel.querySelectorAll<HTMLElement>('label.opt, details.adv')) {
    el.hidden = !everything;
  }
  els.wrPanel.hidden = !(everything && els.wordReplacement.checked);
  els.streamPanel.hidden = !(everything && els.streamConfig.checked);
  els.translationPanel.hidden =
    !(everything && els.streamConfig.checked && els.streamTranslation.checked);
  els.nlToolsPanel.hidden = !(everything && els.nlTools.checked);
}

/**
 * Sets a checkbox to a value, persists the preference, and fires the change
 * callback (which sends the corresponding event frame). A no-op when the
 * state already matches, so re-selecting a preset does not spam the relay.
 */
function setCheckbox(
  input: HTMLInputElement,
  checked: boolean,
  key: string,
  onChange?: () => void,
): void {
  if (input.checked === checked) return;
  input.checked = checked;
  writeStorage(key, String(checked));
  onChange?.();
}

/**
 * Applies a welcome choice: each preset button writes its toggle
 * configuration, "all" leaves the settings untouched. `announce` is false
 * during startup restore, where state changes must not emit event frames.
 * Card visibility is recomputed declaratively at the end (and the Needle 3
 * engine prewarmed if Natural Language Tool Calling just became visible).
 */
function applyWelcomeChoice(choice: WelcomeChoice, announce: boolean): void {
  if (choice !== 'all') {
    setCheckbox(
      els.sendEvents,
      choice !== 'transcription',
      SEND_EVENTS_KEY,
    );
    setCheckbox(
      els.sanitize,
      false,
      SANITIZE_KEY,
      announce ? onRemovePunctuationToggled : undefined,
    );
    setCheckbox(
      els.streamedOutput,
      true,
      STREAMED_OUTPUT_KEY,
      announce ? onOutputStreamingToggled : undefined,
    );
    setCheckbox(els.enableCommands, false, ENABLE_COMMANDS_KEY);
    setCheckbox(
      els.wordReplacement,
      false,
      WORD_REPLACEMENT_KEY,
      announce ? onWordReplacementToggled : undefined,
    );
    setCheckbox(els.streamConfig, choice !== 'transcription', STREAM_CONFIG_KEY);
    setCheckbox(els.nlTools, false, NL_TOOLS_KEY, announce ? onNlToolsToggled : undefined);
    if (choice !== 'transcription') {
      // Translation preset: Default and Translation streams only.
      setCheckbox(els.streamDefault, true, STREAM_DEFAULT_KEY);
      setCheckbox(els.streamOriginal, false, STREAM_ORIGINAL_KEY);
      setCheckbox(els.streamNormalized, false, STREAM_NORMALIZED_KEY);
      setCheckbox(els.streamTranslation, true, STREAM_TRANSLATION_KEY);
      els.translationDirection.value = choice;
      writeStorage(TRANSLATION_DIRECTION_KEY, choice);
    }
  }
  applyTranslationState(announce);
  updateVisibility();
}

/** Marks the active welcome button (`.is-active` + aria-pressed). */
function renderWelcomeSelection(choice: WelcomeChoice | null): void {
  const buttons = [
    ...els.welcomeButtons.querySelectorAll<HTMLButtonElement>('.welcome-btn'),
    els.welcomeAll,
  ];
  for (const btn of buttons) {
    const active = choice !== null && btn.dataset.welcome === choice;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', String(active));
  }
}

/** Selects a welcome choice: persists it, applies its preset, updates the UI. */
function selectWelcome(choice: WelcomeChoice): void {
  writeStorage(WELCOME_KEY, choice);
  renderWelcomeSelection(choice);
  applyWelcomeChoice(choice, true);
  prewarmNlTools();
}

/** Binds a text input or textarea to a persisted string preference. */
function bindText(input: HTMLInputElement | HTMLTextAreaElement, key: string): void {
  const saved = readStorage(key);
  if (saved !== null) input.value = saved;
  input.addEventListener('input', () => writeStorage(key, input.value));
}

/** Reads the confidence threshold input, clamped to 0-1 (default when invalid). */
function nlConfidenceThreshold(): number {
  const parsed = Number.parseFloat(els.nlConfidence.value);
  if (!Number.isFinite(parsed)) return DEFAULT_CONFIDENCE;
  return Math.min(1, Math.max(0, parsed));
}

// --- Disabled tools ------------------------------------------------------------

/** One entry of the tool definition arrays (OpenAI-style function schema). */
interface ToolDef {
  name?: unknown;
  [key: string]: unknown;
}

/** The tool's `name` as a string, or '' for malformed entries. */
function toolName(tool: ToolDef): string {
  return typeof tool.name === 'string' ? tool.name : '';
}

/**
 * Parses a tool definition JSON array out of a textarea. Returns `null` (and
 * logs an error to the STATUS panel) when the text is not a JSON array, since
 * tools cannot be moved in or out of malformed content.
 */
function parseTools(text: string, label: string): ToolDef[] | null {
  try {
    const parsed = JSON.parse(text || '[]') as unknown;
    if (!Array.isArray(parsed)) throw new Error('not a JSON array');
    return parsed as ToolDef[];
  } catch (err) {
    logEvent(t('nl.error.parseFailed', { label, message: (err as Error).message }), 'error');
    return null;
  }
}

/** Writes a tool array back into a textarea, persists it, and saves any pending value. */
function saveTools(input: HTMLTextAreaElement, key: string, tools: ToolDef[]): void {
  input.value = JSON.stringify(tools, null, 2);
  writeStorage(key, input.value);
}

/** Shows the Disabled Tools field only while it holds any content. */
function updateDisabledToolsVisibility(): void {
  els.nlDisabledToolsField.hidden = els.nlDisabledToolsText.value.trim() === '';
}

/**
 * Moves the disabled tool named `name` back into the live tools. When no
 * disabled tool has that name, an error is logged and nothing changes.
 */
function enableNlTool(name: string): void {
  const disabled = parseTools(els.nlDisabledToolsText.value, 'disabled');
  const live = parseTools(els.nlToolsText.value, 'live');
  if (!disabled || !live) return;
  const index = disabled.findIndex((tool) => toolName(tool) === name);
  if (index < 0) {
    logEvent(t('nl.error.disabledToolNotFound', { name }), 'error');
    return;
  }
  const [tool] = disabled.splice(index, 1);
  live.push(tool);
  saveTools(els.nlToolsText, NL_TOOLS_TEXT_KEY, live);
  saveTools(els.nlDisabledToolsText, NL_DISABLED_TOOLS_TEXT_KEY, disabled);
  updateDisabledToolsVisibility();
  logEvent(t('nl.log.enabledTool', { name }));
}

/**
 * Moves the live tool named `name` into the disabled tools. When no live tool
 * has that name, an error is logged and nothing changes.
 */
function disableNlTool(name: string): void {
  const disabled = parseTools(els.nlDisabledToolsText.value, 'disabled');
  const live = parseTools(els.nlToolsText.value, 'live');
  if (!disabled || !live) return;
  const index = live.findIndex((tool) => toolName(tool) === name);
  if (index < 0) {
    logEvent(t('nl.error.liveToolNotFound', { name }), 'error');
    return;
  }
  const [tool] = live.splice(index, 1);
  disabled.push(tool);
  saveTools(els.nlToolsText, NL_TOOLS_TEXT_KEY, live);
  saveTools(els.nlDisabledToolsText, NL_DISABLED_TOOLS_TEXT_KEY, disabled);
  updateDisabledToolsVisibility();
  logEvent(t('nl.log.disabledTool', { name }));
}

/**
 * Moves every tool named in `names` from the disabled tools to the live ones,
 * and every live tool not named there to the disabled ones — leaving only the
 * mentioned tools live. Names present in neither list are ignored.
 */
function enableOnlyNlTools(names: string[]): void {
  const disabled = parseTools(els.nlDisabledToolsText.value, 'disabled');
  const live = parseTools(els.nlToolsText.value, 'live');
  if (!disabled || !live) return;
  const wanted = new Set(names);
  const disabledKeep: ToolDef[] = [];
  const enabled: ToolDef[] = [];
  for (const tool of disabled) {
    (wanted.delete(toolName(tool)) ? enabled : disabledKeep).push(tool);
  }
  const liveKeep: ToolDef[] = [];
  const disabledNow: ToolDef[] = [];
  for (const tool of live) {
    (wanted.has(toolName(tool)) ? liveKeep : disabledNow).push(tool);
  }
  saveTools(els.nlToolsText, NL_TOOLS_TEXT_KEY, [...liveKeep, ...enabled]);
  saveTools(els.nlDisabledToolsText, NL_DISABLED_TOOLS_TEXT_KEY, [...disabledKeep, ...disabledNow]);
  updateDisabledToolsVisibility();
  logEvent(t('nl.log.enabledOnly', { names: names.join(', ') }));
}

/** Formats one tool call as `name(arg1, arg2)` for the frame log. */
function describeNeedleCall(call: NeedleCall): string {
  const args = Object.entries(call.arguments ?? {}).map(([key, value]) => {
    const shown = typeof value === 'string' ? value : JSON.stringify(value) ?? 'null';
    return `${key}=${shown}`;
  });
  return `${call.name}(${args.join(', ')})`;
}

/**
 * Emits one tool call frame: `[tool.sep]NAME<GS>KEY=VALUE<RS>KEY2=VALUE`.
 * String argument values go out raw; other types are JSON-encoded.
 */
function emitToolCall(call: NeedleCall): void {
  const pairs = Object.entries(call.arguments ?? {})
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value) ?? 'null'}`)
    .join(TOOL_RECORD_SEP);
  sendFrame('tool', `${TOOL_SEP_FRAME}${call.name}${TOOL_GROUP_SEP}${pairs}`);
}

/**
 * Runs the wake-worded text through the needle3 engine and emits (or logs)
 * the resulting tool calls. The engine loads on first use; runs against the
 * engine are serialized inside needle.ts.
 */
async function runNlTools(query: string): Promise<void> {
  const tools = els.nlToolsText.value;
  try {
    JSON.parse(tools);
  } catch (err) {
    logEvent(
      `Natural Language Tools: tool definitions are not valid JSON — ${(err as Error).message}`,
      'error',
    );
    return;
  }
  const threshold = nlConfidenceThreshold();
  try {
    const result = await needleRun(tools, query, setNlStatus);
    setNlStatus('');
    const described = result.calls.map(describeNeedleCall).join('; ') || 'nothing';
    if (!result.calls.length) {
      logEvent(t('needle.log.noToolCalls', { confidence: result.confidence.toFixed(2) }));
      return;
    }
    if (!(result.confidence >= threshold)) {
      logEvent(
        t('needle.log.belowThreshold', {
          confidence: result.confidence.toFixed(2),
          threshold: threshold.toFixed(2),
          described,
        }),
      );
      return;
    }
    for (const call of result.calls) emitToolCall(call);
  } catch (err) {
    setNlStatus('');
    logEvent(t('needle.log.error', { message: (err as Error).message }), 'error');
  }
}

/**
 * Strips punctuation from `text` so wake-word matching works on words only:
 * "Hey, Bridge, do this thing." normalizes to "hey bridge do this thing",
 * which matches a wake word of "hey bridge". Letters and numbers are kept;
 * everything else becomes a space (never a join, so "hey,bridge" stays two
 * words), runs of which collapse to one.
 */
function normalizeForWakeWord(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Called with each final line: when Natural Language Tool Calling is on and
 * the punctuation-stripped line starts with the wake word, the remainder is
 * processed by the Needle 3 engine. Lines that don't start with the wake word
 * are ignored.
 */
function maybeRunTools(text: string): void {
  if (!els.nlTools.checked) return;
  const wake = normalizeForWakeWord(els.nlWakeWord.value);
  if (!wake) return;
  // Normalize char by char, remembering where each normalized character came
  // from in the original string, so the query keeps its real punctuation.
  let normalized = '';
  const map: number[] = []; // map[normalized index] = original index
  let pendingSpace = false;
  let pos = 0;
  for (const ch of text.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      for (let k = 0; k < ch.length; k++) {
        normalized += ch[k];
        map.push(pos);
      }
      pendingSpace = false;
    } else if (!pendingSpace) {
      normalized += ' ';
      map.push(pos);
      pendingSpace = true;
    }
    pos += ch.length;
  }
  const lead = normalized.length - normalized.trimStart().length;
  const trimmed = normalized.slice(lead);
  const trimmedMap = map.slice(lead);
  if (!trimmed.startsWith(wake)) return;
  // The wake word must end at a word boundary: end of line or a separator.
  const after = wake.length;
  if (after < trimmed.length && trimmed[after] !== ' ') return;
  if (after >= trimmed.length) return; // nothing left after the wake word
  // Skip the separator run that followed the wake word in the original text.
  const isWordChar = (s: string, i: number): boolean =>
    /[\p{L}\p{N}]/u.test(String.fromCodePoint(s.codePointAt(i)!));
  let cut = trimmedMap[after];
  while (cut < text.length && !isWordChar(text, cut)) cut++;
  const query = text.slice(cut).trim();
  if (query) void runNlTools(query);
}

// --- DOM ------------------------------------------------------------------------

/** Looks up a required element, failing fast when the markup and script drift apart. */
function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(t('error.missingElement', { id }));
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
  wordReplacement: byId<HTMLInputElement>('wordReplacement'),
  streamConfig: byId<HTMLInputElement>('streamConfig'),
  streamPanel: byId<HTMLElement>('streamPanel'),
  nlTools: byId<HTMLInputElement>('nlTools'),
  nlToolsPanel: byId<HTMLElement>('nlToolsPanel'),
  nlWakeWord: byId<HTMLInputElement>('nlWakeWord'),
  nlToolsText: byId<HTMLTextAreaElement>('nlToolsText'),
  nlDisabledToolsField: byId<HTMLElement>('nlDisabledToolsField'),
  nlDisabledToolsText: byId<HTMLTextAreaElement>('nlDisabledToolsText'),
  nlConfidence: byId<HTMLInputElement>('nlConfidence'),
  nlStatus: byId<HTMLElement>('nlStatus'),
  streamDefault: byId<HTMLInputElement>('streamDefault'),
  streamOriginal: byId<HTMLInputElement>('streamOriginal'),
  streamNormalized: byId<HTMLInputElement>('streamNormalized'),
  streamTranslation: byId<HTMLInputElement>('streamTranslation'),
  translationPanel: byId<HTMLElement>('translationPanel'),
  translationDirection: byId<HTMLSelectElement>('translationDirection'),
  translationStatus: byId<HTMLElement>('translationStatus'),
  welcomeButtons: byId<HTMLElement>('welcomeButtons'),
  welcomeAll: byId<HTMLButtonElement>('welcomeAll'),
  settingsPanel: byId<HTMLElement>('settingsPanel'),
  wrPanel: byId<HTMLElement>('wrPanel'),
  wrList: byId<HTMLElement>('wrList'),
  wrAdd: byId<HTMLButtonElement>('wrAdd'),
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
  localeButton: byId<HTMLButtonElement>('localeButton'),
  localeMenu: byId<HTMLElement>('localeMenu'),
  localeFlag: byId<HTMLElement>('localeFlag'),
};

// The settings gear is only shown when the localStorage flag
// `showSuperAdvancedSettings` is set to the string "true".
els.settings.hidden = localStorage.getItem('showSuperAdvancedSettings') !== 'true';

// --- Locale selector -------------------------------------------------------------

/** Locales the selector supports: English and Japanese. */
type Locale = 'en' | 'jp';
const LOCALES: readonly Locale[] = ['en', 'jp'];
/** Flag emoji per locale, shown in the header button. */
const LOCALE_FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  jp: '🇯🇵',
};
/** The currently active locale. */
let locale: Locale = (() => {
  const stored = localStorage.getItem('appLocale');
  if (stored && (LOCALES as readonly string[]).includes(stored)) return stored as Locale;
  // Fall back to the document language, then to English.
  return document.documentElement.lang === 'jp' ? 'jp' : 'en';
})();

// Point the i18n helper at the active locale before any t() call renders text.
setLanguage(locale);
// Fill in the static HTML strings (data-i18n / data-i18n-html attributes).
applyStaticTranslations();

/** The locale key behind the current mic label (see {@link setMicLabel}). */
let micLabelKey = 'mic.label.ready';
/** Whether the mic button currently advertises starting or stopping. */
let micAriaState: 'start' | 'stop' = 'start';

/** Sets the mic label, remembering the key so a language switch can re-apply it. */
function setMicLabel(key: string): void {
  micLabelKey = key;
  els.micLabel.textContent = t(key);
}

/** Sets the mic button's aria-label, tracking it for the same reason. */
function setMicAria(state: 'start' | 'stop'): void {
  micAriaState = state;
  els.mic.setAttribute('aria-label', t(`mic.aria.${state}`));
}

/**
 * Re-renders the strings that are already on screen after a language switch.
 * Everything rendered later goes through t() at render time and picks the new
 * language up automatically.
 */
function rerenderLocalizedText(): void {
  applyStaticTranslations();
  setWsState(wsState);
  mountArchChips();
  renderReplacements();
  setMicLabel(micLabelKey);
  setMicAria(micAriaState);
}

/** Renders the active locale into the button flag and menu selection. */
function renderLocale(): void {
  els.localeFlag.innerHTML = LOCALE_FLAGS[locale];
  for (const item of els.localeMenu.querySelectorAll<HTMLButtonElement>('.locale-item')) {
    item.setAttribute('aria-selected', String(item.dataset.locale === locale));
  }
}

/** Sets the active locale, persists it, and updates the UI. */
function setLocale(next: Locale): void {
  if (next === locale) {
    closeLocaleMenu();
    return;
  }
  locale = next;
  localStorage.setItem('appLocale', next);
  document.documentElement.lang = next;
  setLanguage(next);
  rerenderLocalizedText();
  renderLocale();
  closeLocaleMenu();
}

function closeLocaleMenu(): void {
  if (els.localeMenu.matches(':popover-open')) els.localeMenu.hidePopover();
}

// The invoker button toggles the popover natively (popovertarget). Only the
// item selection needs a listener here.
els.localeMenu.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLButtonElement>('.locale-item');
  if (item) setLocale(item.dataset.locale as Locale);
});

// Keep aria-expanded in sync with the popover's open state — it covers both
// invoker toggling and native light-dismiss (outside click, Escape).

// Browsers without CSS anchor positioning center popovers in the viewport;
// position the menu under the button manually in that case.
const supportsAnchorPositioning = CSS.supports('anchor-name: --test');

function positionLocaleMenu(): void {
  const btn = els.localeButton.getBoundingClientRect();
  const menu = els.localeMenu.getBoundingClientRect();
  const left = Math.min(
    Math.max(8, btn.right - menu.width),
    window.innerWidth - menu.width - 8,
  );
  els.localeMenu.style.margin = '0';
  els.localeMenu.style.left = `${left}px`;
  els.localeMenu.style.top = `${btn.bottom + 6}px`;
}

els.localeMenu.addEventListener('toggle', () => {
  const open = els.localeMenu.matches(':popover-open');
  els.localeButton.setAttribute('aria-expanded', String(open));
  if (open && !supportsAnchorPositioning) positionLocaleMenu();
});

window.addEventListener('resize', () => {
  if (els.localeMenu.matches(':popover-open') && !supportsAnchorPositioning) {
    positionLocaleMenu();
  }
});

// Initial render: reflect the persisted (or default) locale.
renderLocale();

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
    state === 'open'
      ? t('ws.button.disconnect')
      : state === 'connecting'
        ? t('ws.button.cancel')
        : t('ws.button.connect');
  // Heading suffix, e.g. "WEBSOCKET CONNECTION — CONNECTED", colored by state.
  els.wsState.className = `ws-state ws-state--${state}`;
  els.wsState.textContent =
    state === 'open'
      ? t('ws.state.connected')
      : state === 'connecting'
        ? t('ws.state.connecting')
        : t('ws.state.disconnected');
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
  els.wsState.textContent = t('ws.state.retrying');
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
  logEvent(t('log.wsConnecting', { url }));
  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    setWsState('closed');
    markWsError();
    logEvent(t('log.wsInvalidUrl', { message: (err as Error).message }), 'error');
    return;
  }
  ws = socket;
  socket.onopen = () => {
    if (ws !== socket) return;
    setWsState('open');
    wasConnected = true;
    logEvent(t('log.wsConnected', { url }));
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
      if (wasConnected) logEvent(t('log.wsDisconnected'));
      else logEvent(t('log.wsConnectCancelled'), 'error');
    } else {
      markWsError();
      logEvent(t('log.wsFailed'), 'error');
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
  msg.textContent = kind === 'pause' ? t('log.pauseNotSent') : text;
  row.append(time, msg);
  els.frames.append(row);
  // Tool calls stand apart from the transcript: mark each one with a
  // separator line underneath.
  if (kind === 'tool') logSeparator();
  while (els.frames.childElementCount > FRAME_LOG_LIMIT) els.frames.firstElementChild?.remove();
  els.frames.scrollTop = els.frames.scrollHeight;
}

/** Logs a lifecycle event (WebSocket, model, binding) to the STATUS panel. */
function logEvent(text: string, kind: 'sys' | 'error' | 'loading' = 'sys'): void {
  logFrame(kind, text);
}

function logSeparator(): void {
  const sep = document.createElement('div');
  sep.className = 'sep';
  els.frames.append(sep);
}

/**
 * Escapes a string for literal use inside a RegExp.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Copies the case shape of a matched word onto its replacement: an
 * all-uppercase match comes back all-uppercase, a capitalized match comes
 * back capitalized, and an exact-case match keeps the replacement as typed.
 */
function matchCase(source: string, replacement: string): string {
  if (!replacement) return replacement;
  if (source === replacement) return replacement;
  const letters = source.replace(/[^\p{L}]/gu, '');
  if (letters && letters === letters.toUpperCase()) return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(source)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/**
 * Swaps every whole-word occurrence of a target for its replacement,
 * case-insensitively but case-preserving (see {@link matchCase}). Runs only
 * while the "Word Replacement" toggle is on; blank targets are skipped.
 */
function applyWordReplacements(text: string): string {
  if (!els.wordReplacement.checked) return text;
  const entries = collectReplacements().filter((e) => e.target.trim());
  if (!entries.length) return text;
  let result = text;
  for (const { target, replacement } of entries) {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(target.trim())}(?![\\p{L}\\p{N}])`,
      'giu',
    );
    result = result.replace(pattern, (matched) => matchCase(matched, replacement));
  }
  return result;
}

/**
 * Prepares transcribed text for the wire: when the sanitize option is on,
 * lowercases it, removes every non-alphanumeric character, and keeps spaces
 * as the only whitespace — other whitespace (tabs, newlines) is dropped, and
 * runs of spaces collapse to one with none at the edges. Unicode-aware, so
 * accented letters and digits survive. Word replacement runs first so the
 * replacements are sanitized like the rest of the text. Event control frames
 * such as `[speechEnded]` are exempt — stripping their punctuation would
 * destroy the markers — and diagnostics are never replaced.
 *
 * The mode overrides the punctuation handling: `raw` skips every
 * transformation (the Original Stream), `normalize` always strips punctuation
 * regardless of the toggle (the Normalized Stream), and `default` follows the
 * Remove Punctuation setting as usual.
 */
function sanitizeForWire(
  text: string,
  kind: FrameKind = 'final',
  mode: SanitizeMode = 'default',
): string {
  if (EVENT_FRAMES.has(text)) return text;
  let out = kind === 'sys' || mode === 'raw' ? text : applyWordReplacements(text);
  const removePunctuation =
    mode === 'normalize' ? true : mode === 'raw' ? false : els.sanitize.checked;
  if (!removePunctuation) return out;
  return out
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/**
 * Options for {@link sendFrame}: how the text is sanitized, and an optional
 * prefix (e.g. `[stream.orig]`) prepended after sanitizing, so the marker
 * itself is never mangled by punctuation removal.
 */
interface SendOptions {
  mode?: SanitizeMode;
  prefix?: string;
}

/**
 * Sends one text frame to the WebSocket server, sanitized per the toggle (or
 * the given mode). Queues while the socket is down (and asks for a
 * reconnect), so transcription never stalls on the connection.
 */
function sendFrame(kind: FrameKind, rawText: string, options: SendOptions = {}): void {
  const { mode = 'default', prefix = '' } = options;
  // Tool call frames carry control characters that must go out verbatim.
  const text = kind === 'tool' ? prefix + rawText : prefix + sanitizeForWire(rawText, kind, mode);
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
}

// Labels are looked up through t() when the chips are mounted, so a language
// switch re-renders them (see mountArchChips).
const ARCHES: Arch[] = [
  { key: 'tiny', name: 'TinyStreaming' },
  { key: 'small', name: 'SmallStreaming' },
  { key: 'medium', name: 'MediumStreaming' },
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
/**
 * False while a `disable` command has suppressed transcription output: the
 * microphone and transcriber keep running, but nothing goes on the wire
 * until an `enable` command (or a fresh start) lifts the suppression.
 */
let sending = true;
/**
 * Last partial sent per stream (the prefixed wire text), so frames are only
 * pushed when a stream's output actually grows.
 */
const lastSent: Record<StreamKey, string> = { default: '', original: '', normalized: '' };
/**
 * Last partial sent on the Translation Stream (prefixed wire text), so
 * translated interim results are only pushed when they actually change.
 * Kept apart from {@link lastSent}: the translation is different text, not a
 * sanitized copy of the transcript.
 */
let lastSentTranslation = '';
/** The translation effective state last announced with an event frame. */
let translationWasActive = false;
/** Timer holding back the interim translation until the partial settles. */
let partialTranslationTimer: ReturnType<typeof setTimeout> | null = null;

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
 * Sends one piece of recognized text on a single stream, skipping streams
 * whose sanitized text came out empty (e.g. the normalized copy of a grunt),
 * and deduplicating partials on what actually goes on the wire, so "Hello,"
 * followed by "Hello" does not send the sanitized "hello" twice.
 */
function emitStream(
  key: StreamKey,
  kind: 'partial' | 'final',
  text: string,
  mode: SanitizeMode,
  prefix: string,
): void {
  const content = sanitizeForWire(text, kind, mode);
  if (!content) return;
  const wire = prefix + content;
  if (kind === 'partial' && wire === lastSent[key]) return;
  lastSent[key] = wire;
  sendFrame(kind, text, { mode, prefix });
}

/**
 * Emits one piece of recognized text on every enabled stream. With Stream
 * Configuration off, only the Default Stream is sent, regardless of the panel
 * checkboxes — the prefixed streams never go out. With it on, each of the
 * three streams is sent independently.
 */
function emitStreams(kind: 'partial' | 'final', text: string): void {
  if (!els.streamConfig.checked) {
    emitStream('default', kind, text, 'default', '');
    return;
  }
  if (els.streamDefault.checked) emitStream('default', kind, text, 'default', '');
  if (els.streamOriginal.checked) {
    emitStream('original', kind, text, 'raw', ORIGINAL_STREAM_PREFIX);
  }
  if (els.streamNormalized.checked) {
    emitStream('normalized', kind, text, 'normalize', NORMALIZED_STREAM_PREFIX);
  }
}

/**
 * Cancels the pending interim translation, if any: the timer holds back the
 * latest partial while the sentence is still growing, and a final line (or a
 * settings change) makes translating it pointless.
 */
function cancelPartialTranslation(): void {
  if (partialTranslationTimer === null) return;
  clearTimeout(partialTranslationTimer);
  partialTranslationTimer = null;
}

/**
 * Waits for the partial to settle, then translates the latest interim text.
 * The debounce (see {@link TRANSLATION_PARTIAL_DEBOUNCE_MS}) keeps the
 * translation engine from chasing every partial update; superseded requests
 * are discarded inside the translation module.
 */
function schedulePartialTranslation(text: string): void {
  if (partialTranslationTimer !== null) clearTimeout(partialTranslationTimer);
  partialTranslationTimer = setTimeout(() => {
    partialTranslationTimer = null;
    void submitTranslation(text, 'partial');
  }, TRANSLATION_PARTIAL_DEBOUNCE_MS);
}

/**
 * Translates one piece of text (partial or final) and emits the result on
 * the Translation Stream — `[stream.trans.JP]` for EN → JP and
 * `[stream.trans.EN]` for JP → EN. Null results (superseded, dropped, or
 * failed) are silently ignored; failures were already logged by the engine.
 * Direction changes while a request is in flight are detected here so the
 * old direction's output cannot land on the new one's stream.
 */
async function submitTranslation(text: string, kind: 'partial' | 'final'): Promise<void> {
  const dir = translationEngineDirection();
  const prefix = translationStreamPrefix();
  if (!dir || !prefix) return;
  const result = await translateText(text, kind);
  if (result === null) return;
  if (!sending || dir !== translationEngineDirection()) return; // muted or re-targeted
  emitTranslation(kind, prefix, result);
}

/**
 * Sends one translated text on the Translation Stream. Translations go out
 * raw (like the Original Stream): the text is already in the target language
 * and never run through word replacement or punctuation removal. Partials
 * are deduplicated against the last wire text actually sent.
 */
function emitTranslation(kind: 'partial' | 'final', prefix: string, text: string): void {
  const wire = prefix + text;
  if (kind === 'partial' && wire === lastSentTranslation) return;
  lastSentTranslation = wire;
  sendFrame(kind, text, { mode: 'raw', prefix });
}

/**
 * Called with the in-progress text of the sentence currently being spoken:
 * sends the continually expanding sentence over the WebSocket.
 */
function onPartial(text: string): void {
  els.live.textContent = sending ? text : '';
  if (!sending || !els.streamedOutput.checked) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  emitStreams('partial', trimmed);
  if (translationActive()) schedulePartialTranslation(trimmed);
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
  for (const key of Object.keys(lastSent) as StreamKey[]) lastSent[key] = '';
  lastSentTranslation = '';
  cancelPartialTranslation();
  if (!sending) {
    // Muted: the model still hears the line, but nothing is sent.
    logFrame('pause', '');
    logSeparator();
    return;
  }
  const text = line.text.trim();
  if (text) emitStreams('final', text);
  // Translation and tool processing run on top of the normal output.
  if (text && translationActive()) void submitTranslation(text, 'final');
  maybeRunTools(text);
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
 * Enables or disables transcription output without touching the microphone:
 * when disabled, the transcriber keeps running but no frames go on the wire,
 * so an `enable` command can resume sending with no user interaction on the
 * page. Sends the `[enabled]`/`[disabled]` event frame on change; a no-op
 * when the state already matches, so redundant commands do not spam the
 * relay with event frames.
 */
function setSending(enabled: boolean): void {
  if (sending === enabled) return;
  sending = enabled;
  if (!enabled) {
    els.live.textContent = '';
    for (const key of Object.keys(lastSent) as StreamKey[]) lastSent[key] = '';
    lastSentTranslation = '';
    cancelPartialTranslation();
  }
  setMicLabel(enabled ? 'mic.label.listening' : 'mic.label.muted');
  setStatus(
    enabled ? t('status.transcribing') : t('status.muted'),
    enabled ? 'ready' : 'info',
  );
  if (enabled) onMicEnabled();
  else onMicDisabled();
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

/**
 * Sends the `[replacementEnabled]` / `[replacementDisabled]` event frame
 * whenever the word replacement toggle changes.
 */
function onWordReplacementToggled(): void {
  sendEvent(els.wordReplacement.checked ? REPLACEMENT_ENABLED_FRAME : REPLACEMENT_DISABLED_FRAME);
}

/**
 * Sends the `[naturalLanguageToolsEnabled]` / `[naturalLanguageToolsDisabled]`
 * event frame whenever the natural language tool calling toggle changes.
 */
function onNlToolsToggled(): void {
  sendEvent(els.nlTools.checked ? NL_TOOLS_ENABLED_FRAME : NL_TOOLS_DISABLED_FRAME);
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
    logEvent(t('log.commandIgnored', { command }));
    return;
  }
  logFrame('cmd', command);
  if (!runCommand(command)) {
    logEvent(t('error.unknownCommand', { command }), 'error');
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

/**
 * Parses a `translationDirection` command argument into a setting value;
 * returns null for anything else.
 */
function parseTranslationDirection(arg: string): TranslationSetting | null {
  const value = arg.toUpperCase();
  return value === 'EN_JP' ? 'en-jp' : value === 'JP_EN' ? 'jp-en' : value === 'OFF' ? 'off' : null;
}

/** Runs one relay command; returns whether it was recognized. */
function runCommand(command: string): boolean {
  // Commands that take arguments use COMMAND=ARGS, e.g. tool enable/disable.
  const equals = command.indexOf('=');
  if (equals > 0) {
    const name = command.slice(0, equals);
    const arg = command.slice(equals + 1).trim();
    switch (name) {
      case 'translationDirection': {
        const value = parseTranslationDirection(arg);
        if (!value) {
          logEvent(t('error.invalidTranslationDirection', { arg }), 'error');
          return true;
        }
        els.translationDirection.value = value;
        writeStorage(TRANSLATION_DIRECTION_KEY, value);
        applyTranslationState();
        return true;
      }
      case 'naturalLanguageToolsEnableTool':
        if (arg) enableNlTool(arg);
        return true;
      case 'naturalLanguageToolsDisableTool':
        if (arg) disableNlTool(arg);
        return true;
      case 'naturalLanguageToolsEnableOnlyTools':
        enableOnlyNlTools(
          arg
            .split(',')
            .map((tool) => tool.trim())
            .filter(Boolean),
        );
        return true;
    }
  }
  switch (command) {
    case 'toggle':
      if (running) void stopListening();
      else void startListening();
      return true;
    case 'enable':
      if (!running) void startListening();
      else setSending(true);
      return true;
    case 'disable':
      // The microphone stays live; only the transcription output is muted.
      if (running) setSending(false);
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
    case 'replacementToggle':
      setToggle(
        els.wordReplacement,
        !els.wordReplacement.checked,
        WORD_REPLACEMENT_KEY,
        onWordReplacementToggled,
      );
      return true;
    case 'replacementEnable':
      setToggle(els.wordReplacement, true, WORD_REPLACEMENT_KEY, onWordReplacementToggled);
      return true;
    case 'replacementDisable':
      setToggle(els.wordReplacement, false, WORD_REPLACEMENT_KEY, onWordReplacementToggled);
      return true;
    case 'naturalLanguageToolsToggle':
      setToggle(els.nlTools, !els.nlTools.checked, NL_TOOLS_KEY, onNlToolsToggled);
      return true;
    case 'naturalLanguageToolsEnable':
      setToggle(els.nlTools, true, NL_TOOLS_KEY, onNlToolsToggled);
      return true;
    case 'naturalLanguageToolsDisable':
      setToggle(els.nlTools, false, NL_TOOLS_KEY, onNlToolsToggled);
      return true;
    case 'translationToggle':
      setToggle(
        els.streamTranslation,
        !els.streamTranslation.checked,
        STREAM_TRANSLATION_KEY,
        onTranslationToggled,
      );
      return true;
    case 'translationEnable':
      setToggle(els.streamTranslation, true, STREAM_TRANSLATION_KEY, onTranslationToggled);
      return true;
    case 'translationDisable':
      setToggle(els.streamTranslation, false, STREAM_TRANSLATION_KEY, onTranslationToggled);
      return true;
    default:
      return false;
  }
}

/**
 * Local and remote base URLs for a model's files: the tiny model ships with
 * the app; the others are first looked for on the same server (`/models/…`,
 * served from the desktop client's cache folder) and then fetched from the
 * URL configured in the settings dialog (which defaults to that same cache
 * path, so an explicit override is only needed for custom hosting).
 */
function modelSources(key: ArchKey): { local: string; remote?: string } {
  if (key === 'tiny') return { local: '/models/tiny_streaming' };
  return { local: `/models/${key}_streaming`, remote: loadModelUrls()[key] };
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HEAD-probes one local model file, reporting whether the server actually has
 * it. The probe checks the content type because SPA dev servers answer 200
 * with index.html for unknown paths rather than a 404.
 */
async function probeLocalFile(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    if (!response.ok) return false;
    const type = response.headers.get('content-type') ?? '';
    return !type.includes('text/html');
  } catch {
    return false;
  }
}

/**
 * Model probing retry budget: the desktop client downloads the models into
 * its cache in the background after startup (see systray/modelcache.go), so
 * a missing file usually means "not downloaded yet" rather than "will never
 * be served". Probing re-runs until every file is found; a round that finds
 * no new file counts against the budget, and any progress resets it — so a
 * slow download is waited out for as long as it is actually moving.
 */
const PROBE_INTERVAL_MS = 2_000;
const PROBE_MAX_STALLED_ROUNDS = 30; // ~1 minute of probing without any new file

/**
 * Decides where each model file comes from: probes the local /models/ path
 * first (streaming models only, retrying while the server is still
 * downloading), falling back to the configured base URL for any file the
 * server never gets. Mixing is fine — the loader just wants a URL per
 * canonical filename.
 */
async function resolveModelUrls(key: ArchKey): Promise<Record<string, string>> {
  const { local, remote } = modelSources(key);
  const localUrls = Object.fromEntries(MODEL_FILES.map((name) => [name, `${local}/${name}`]));
  if (!remote) return localUrls; // bundled model: all local

  // Probe every file on the local path, re-probing the misses until they all
  // show up or the retry budget runs out. The first round runs immediately;
  // every later round waits one interval, so a fully-cached model is served
  // with zero added latency.
  const missing = new Set<string>(MODEL_FILES);
  let found = 0;
  let stalls = 0; // consecutive rounds that discovered no new file
  while (missing.size > 0 && stalls <= PROBE_MAX_STALLED_ROUNDS) {
    if (stalls > 0 || found > 0) await sleep(PROBE_INTERVAL_MS);
    const before = found;
    for (const name of [...missing]) {
      if (await probeLocalFile(`${local}/${name}`)) missing.delete(name);
    }
    found = MODEL_FILES.length - missing.size;
    if (missing.size === 0) break;
    if (found > before) {
      stalls = 0;
      logEvent(t('log.modelProbeFound', { key, found, total: MODEL_FILES.length }));
      setStatus(
        t('status.waitingForModelFiles', { key, found, total: MODEL_FILES.length }),
        'info',
      );
    } else {
      stalls++;
    }
  }

  const result = { ...localUrls };
  missing.forEach((name) => {
    result[name] = `${remote}/${name}`;
  });
  const localCount = MODEL_FILES.length - missing.size;
  if (localCount === MODEL_FILES.length) {
    logEvent(t('log.modelFromLocal', { key, local }));
  } else if (localCount === 0) {
    logEvent(t('log.modelFromRemote', { key, remote }));
  } else {
    logEvent(
      t('log.modelMixed', {
        key,
        localCount,
        total: MODEL_FILES.length,
        local,
        remote,
      }),
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
  setStatus(t('status.modelLoading', { key: arch.key }));
  logEvent(t('log.modelLoading', { key: arch.key }));
  setProgress(null);
  const instance = buildMic(arch);
  instance.modelsFrom(await resolveModelUrls(arch.key));
  try {
    await instance.load();
  } catch (err) {
    logEvent(t('log.modelLoadFailed', { key: arch.key, message: (err as Error).message }), 'error');
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
  logEvent(t('log.modelLoaded', { key: arch.key }));
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
  setMicLabel('mic.label.ready');
  setStatus(t('status.modelReady'), 'ready');
}

/** Microphone access refused by the user (or previously denied). */
function showPermissionDeniedState(): void {
  setMicLabel('mic.label.failed');
  setStatus(t('error.micDenied'), 'error');
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
  setMicLabel('mic.label.waitingPermission');
  setStatus(t('status.authorizePermission'), 'info');
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
    setStatus(t('error.modelLoadFailed', { message: err.message }), 'error');
  });
}

/** Loads the Moonshine binding; only failures are logged. */
async function loadBinding(): Promise<MoonshineModule> {
  const url = loadModuleUrlPreference();
  try {
    return await loadMoonshine();
  } catch (err) {
    logEvent(t('error.bindingLoadFailed', { url, message: (err as Error).message }), 'error');
    throw err;
  }
}

async function startListening(): Promise<void> {
  els.mic.disabled = true;
  setMicLabel('mic.label.starting');
  try {
    await micReady; // the model may still be downloading on first press
    if (!mic) await loadModel();
    await ensureMicPermission();
    await mic!.start();
    running = true;
    sending = true; // a fresh start always sends
    document.body.dataset.state = 'listening';
    setMicAria('stop');
    setMicLabel('mic.label.listening');
    setStatus(t('status.transcribing'), 'ready');
    onMicEnabled();
  } catch (err) {
    if (isMicPermissionError(err)) {
      showPermissionDeniedState();
    } else {
      setMicLabel('mic.label.ready');
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
  sending = true; // reset silently — the [disabled] frame below covers the stop
  els.live.textContent = '';
  document.body.dataset.state = 'idle';
  setMicAria('start');
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
  els.archChips.replaceChildren();
  for (const arch of ARCHES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${arch.key === selectedArch ? ' is-active' : ''}`;
    chip.dataset.arch = arch.key;
    chip.textContent = t(`arch.${arch.key}.label`);
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
bindCheckbox(els.wordReplacement, WORD_REPLACEMENT_KEY);
bindCheckbox(els.streamConfig, STREAM_CONFIG_KEY);
bindCheckbox(els.streamDefault, STREAM_DEFAULT_KEY);
bindCheckbox(els.streamOriginal, STREAM_ORIGINAL_KEY);
bindCheckbox(els.streamNormalized, STREAM_NORMALIZED_KEY);
bindCheckbox(els.streamTranslation, STREAM_TRANSLATION_KEY, onTranslationToggled);
// Translation direction: persisted and applied on change — the same path the
// relay commands take (set the value, persist, re-apply the engine state).
els.translationDirection.addEventListener('change', () => {
  writeStorage(TRANSLATION_DIRECTION_KEY, els.translationDirection.value);
  applyTranslationState();
});
els.wordReplacement.addEventListener('change', updateVisibility);
els.streamConfig.addEventListener('change', onStreamConfigToggled);
// Natural Language Tool Calling: the toggle shows the panel; each field
// persists as it is edited. The starter tool block is only used when
// nothing has been saved yet.
if (readStorage(NL_TOOLS_TEXT_KEY) === null) els.nlToolsText.value = DEFAULT_TOOL_DEFINITIONS;
bindCheckbox(els.nlTools, NL_TOOLS_KEY, onNlToolsToggled);
els.nlTools.addEventListener('change', onNlToolsChanged);
bindText(els.nlWakeWord, NL_WAKE_WORD_KEY);
bindText(els.nlToolsText, NL_TOOLS_TEXT_KEY);
bindText(els.nlConfidence, NL_CONFIDENCE_KEY);
// Disabled Tools: persists like the other fields, but the field is only
// visible when it holds content — on page load, or once a command puts
// something into it (updates run after every command-driven write too).
const savedDisabledTools = readStorage(NL_DISABLED_TOOLS_TEXT_KEY);
if (savedDisabledTools !== null) els.nlDisabledToolsText.value = savedDisabledTools;
els.nlDisabledToolsText.addEventListener('input', () => {
  writeStorage(NL_DISABLED_TOOLS_TEXT_KEY, els.nlDisabledToolsText.value);
  updateDisabledToolsVisibility();
});
updateDisabledToolsVisibility();
els.wrAdd.addEventListener('click', () => {
  els.wrList.append(buildReplacementRow({ target: '', replacement: '' }));
  onReplacementsChanged();
  els.wrList.lastElementChild?.querySelector<HTMLInputElement>('.wr-target')?.focus();
});
renderReplacements();
// Translation Stream: restores the saved direction and applies the saved
// state silently — startup must not emit event frames. When active, the
// model for the chosen direction is preloaded right away; when off, no
// model is initialized and nothing is queued (see TRANSLATION.txt).
els.translationDirection.value = loadTranslationDirection();
applyTranslationState(false);
// Welcome card: clicking one button deselects the others; the large buttons
// apply their presets, "Show me everything" restores the full UI.
els.welcomeButtons.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.welcome-btn');
  if (btn) selectWelcome(btn.dataset.welcome as WelcomeChoice);
});
els.welcomeAll.addEventListener('click', () => selectWelcome('all'));
// The persisted choice is restored — applying its preset silently, since
// startup must not emit event frames — and the advanced UI is hidden
// accordingly while a preset button is active.
const savedWelcomeChoice = loadWelcomeChoice();
if (savedWelcomeChoice) applyWelcomeChoice(savedWelcomeChoice, false);
renderWelcomeSelection(savedWelcomeChoice);
// Card visibility is declarative: derived once here from the persisted
// welcome choice and the restored checkbox states, and re-derived after
// every change via the handlers above.
updateVisibility();
prewarmNlTools();

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
  toast.textContent = t('toast.copied');
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
    setMicLabel('mic.label.failed');
    setStatus(t('error.bindingFailed'), 'error');
    return;
  }
  selectedArch = loadArchPreference();
  mountArchChips();
  warmStart();
  connect(); // first relay attempt; retries every 10 s until stopped
})();