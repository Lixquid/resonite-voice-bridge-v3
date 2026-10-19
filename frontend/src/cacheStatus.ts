/**
 * Download status of the desktop client's model cache, reported by its
 * `GET /cache/status` endpoint (see systray/modelcache.go), plus the toast
 * UI that surfaces it.
 *
 * The fetch sites for cache-backed assets (streaming models, the Needle 3
 * engine, the translation engine) register "interest" in the capabilities
 * their files belong to (see noteCacheActivity). While any interest is held,
 * the watcher polls the status endpoint once per interval and shows one
 * progress toast per capability group that is currently downloading — with
 * a bar fed by the backend's live byte counts. When a group's downloads
 * finish (every file cached), the toast is replaced by a transient success
 * toast; the caller's own retry logic (model probe loop, Needle fetch
 * retries, Transformers.js retryLoad) re-attempts the fetch, which resolves
 * as soon as the backend serves the freshly downloaded file.
 */

import { t } from './i18n';

/** The download status of one cached file (mirrors the backend's JSON). */
export interface CacheFileStatus {
  path: string;
  url: string;
  cached: boolean;
  size: number;
  downloading: boolean;
  received: number;
  total: number;
}

/** The download status of one capability group (mirrors the backend's JSON). */
export interface CacheGroupStatus {
  id: string;
  files: CacheFileStatus[];
  cachedFiles: number;
  totalFiles: number;
  downloadingFiles: number;
  receivedBytes: number;
  totalBytes: number;
  ready: boolean;
}

/** The whole /cache/status response (mirrors the backend's JSON). */
export interface CacheStatusReport {
  files: CacheFileStatus[];
  groups: CacheGroupStatus[];
}

/** URL of the desktop client's cache status endpoint. */
const CACHE_STATUS_URL = `${window.location.origin}/cache/status`;

/** How often the watcher re-reads the status endpoint. */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long after a group's last observed download activity its toast stays
 * open when nothing is downloading: consecutive files of one group download
 * back to back, and each poll might land exactly in the gap between two of
 * them — the grace period papers over that gap instead of flickering the
 * toast off and on.
 */
const TOAST_GRACE_MS = 2_500;

/** Fetches the cache status report; null when the endpoint is unreachable. */
export async function fetchCacheStatus(): Promise<CacheStatusReport | null> {
  try {
    const response = await fetch(CACHE_STATUS_URL, { cache: 'no-store' });
    if (!response.ok) return null;
    return (await response.json()) as CacheStatusReport;
  } catch {
    return null;
  }
}

// --- Toast UI -----------------------------------------------------------------

/** Localized label of one capability group id. */
function capabilityLabel(id: string): string {
  const key = CACHE_CAPABILITY_KEYS[id];
  return key ? t(key) : id;
}

/** The i18n keys of the capability group labels, by group id. */
const CACHE_CAPABILITY_KEYS: Record<string, string> = {
  'shared': 'cache.capability.shared',
  'english-stt': 'cache.capability.englishStt',
  'japanese-stt': 'cache.capability.japaneseStt',
  'tool-calling': 'cache.capability.toolCalling',
  'translate-en-ja': 'cache.capability.translateEnJa',
  'translate-ja-en': 'cache.capability.translateJaEn',
};

/** Formats a byte count for the toast meta line. */
function mb(bytes: number): string {
  return (bytes / 1048576).toFixed(1);
}

/** The container all cache toasts stack in (created once). */
let toastContainer: HTMLElement | null = null;

function ensureToastContainer(): HTMLElement {
  if (!toastContainer || !toastContainer.isConnected) {
    toastContainer = document.createElement('div');
    toastContainer.className = 'cache-toasts';
    document.body.append(toastContainer);
  }
  return toastContainer;
}

/** One live progress toast: title, meta line, and a fillable bar. */
interface CacheToast {
  root: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  meta: HTMLElement;
}

/** The open progress toast per capability group id. */
const toasts = new Map<string, CacheToast>();

/** When the group's toast last saw a download in flight (epoch ms). */
const lastActive = new Map<string, number>();

/** Shows (or updates) the progress toast of one downloading group. */
function showProgressToast(group: CacheGroupStatus): void {
  let toast = toasts.get(group.id);
  if (!toast) {
    const root = document.createElement('div');
    root.className = 'cache-toast';
    const title = document.createElement('div');
    title.className = 'cache-toast__title';
    title.textContent = capabilityLabel(group.id);
    const meta = document.createElement('div');
    meta.className = 'cache-toast__meta';
    const bar = document.createElement('div');
    bar.className = 'cache-toast__bar';
    const fill = document.createElement('div');
    fill.className = 'cache-toast__fill';
    bar.append(fill);
    root.append(title, meta, bar);
    ensureToastContainer().append(root);
    toast = { root, bar, meta, fill };
    toasts.set(group.id, toast);
  }
  const label = capabilityLabel(group.id);
  if (group.totalBytes > 0) {
    toast.meta.textContent = t('cache.downloading', {
      label,
      received: mb(group.receivedBytes),
      total: mb(group.totalBytes),
      cachedFiles: group.cachedFiles,
      totalFiles: group.totalFiles,
    });
    toast.bar.classList.remove('is-indeterminate');
    toast.fill.style.width = `${Math.min(
      100,
      (group.receivedBytes / group.totalBytes) * 100,
    ).toFixed(1)}%`;
  } else {
    // No size known yet (the backend has not declared any total): pulse.
    toast.meta.textContent = t('cache.preparing', { label });
    toast.bar.classList.add('is-indeterminate');
  }
}

/** Removes the progress toast of one group without any fanfare. */
function removeProgressToast(id: string): void {
  toasts.get(id)?.root.remove();
  toasts.delete(id);
}

/** Shows the transient "download complete" toast of one group. */
function showSuccessToast(id: string): void {
  const root = document.createElement('div');
  root.className = 'cache-toast cache-toast--success';
  root.textContent = t('cache.success', { label: capabilityLabel(id) });
  ensureToastContainer().append(root);
  // Fades out via CSS animation, then leaves the DOM.
  setTimeout(() => root.remove(), 3_200);
}

/** Removes every open progress toast (watch stopping, interest released). */
function removeAllProgressToasts(): void {
  for (const id of [...toasts.keys()]) removeProgressToast(id);
  lastActive.clear();
}

// --- Watcher ------------------------------------------------------------------

/** Capability ids some fetch attempt is currently interested in. */
const interested = new Set<string>();

/** Whether the poll loop is running. */
let watching = false;

/**
 * Records that fetches of files backed by the listed capability groups are
 * in flight. While any interest is held, the status endpoint is polled and
 * a progress toast is shown for every group that is downloading. Callers
 * release the interest with {@link releaseCacheActivity} when their fetch
 * attempt finishes.
 */
export function noteCacheActivity(ids: string[]): void {
  for (const id of ids) interested.add(id);
  if (!watching) {
    watching = true;
    void watchLoop();
  }
}

/**
 * Releases the interest taken by {@link noteCacheActivity}. When the last
 * interest goes, one final status read runs first — so a download that just
 * completed still gets its success toast — and then any toasts left over are
 * cleaned up: nothing is downloading for this page anymore.
 */
export function releaseCacheActivity(ids: string[]): void {
  for (const id of ids) interested.delete(id);
  if (interested.size === 0) {
    void finishWatch();
  }
}

/** The watcher: polls the status endpoint while any interest is held. */
async function watchLoop(): Promise<void> {
  while (interested.size > 0) {
    const report = await fetchCacheStatus();
    if (report) updateToasts(report);
    await sleep(POLL_INTERVAL_MS);
  }
  watching = false;
  removeAllProgressToasts();
}

/** The final status read before the watcher stops (see releaseCacheActivity). */
async function finishWatch(): Promise<void> {
  const report = await fetchCacheStatus();
  if (report) updateToasts(report, true);
  removeAllProgressToasts();
}

/** Applies one status report to the toast UI. */
function updateToasts(report: CacheStatusReport, final = false): void {
  for (const group of report.groups) {
    if (group.downloadingFiles > 0) {
      lastActive.set(group.id, Date.now());
      showProgressToast(group);
      continue;
    }
    if (!toasts.has(group.id)) continue;
    // Nothing downloading for this group. Within the grace period the toast
    // stays open — consecutive file downloads leave a brief gap. Afterwards
    // the toast closes: with a success fanfare when every file of the group
    // is cached, silently when the download failed (the caller's retries
    // re-attempt and a fresh toast follows).
    if (!final && Date.now() - (lastActive.get(group.id) ?? 0) < TOAST_GRACE_MS) continue;
    removeProgressToast(group.id);
    if (group.ready) showSuccessToast(group.id);
  }
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
