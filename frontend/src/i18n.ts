/**
 * Minimal i18n helper: reads the application strings from `locale.en.json`
 * and `locale.jp.json` and substitutes `{name}` placeholders. The JSON files
 * are imported directly, so Vite bundles them with the app — no runtime fetch
 * is needed.
 */
import localeEn from '../locale.en.json';
import localeJp from '../locale.jp.json';

/** Languages the app supports. */
export type Language = 'en' | 'jp';

/** Flattens a nested locale object into dot-separated `a.b.c` keys. */
function flatten(
  source: Record<string, unknown>,
  prefix = '',
  target: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(source)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      flatten(value as Record<string, unknown>, path, target);
    } else if (typeof value === 'string') {
      target[path] = value;
    }
  }
  return target;
}

/** One flattened string table per supported language. */
const TABLES: Record<Language, Record<string, string>> = {
  en: flatten(localeEn as unknown as Record<string, unknown>),
  jp: flatten(localeJp as unknown as Record<string, unknown>),
};

/** The currently active language. English until setLanguage() says otherwise. */
let language: Language = 'en';

/** Sets the active language; every subsequent t() call uses its strings. */
export function setLanguage(next: Language): void {
  language = next;
}

/** The currently active language. */
export function getLanguage(): Language {
  return language;
}

/** Formats one localized string, replacing `{placeholder}` occurrences. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = TABLES[language][key] ?? TABLES.en[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Applies the static UI strings (`ui.*` keys) to the document. Elements marked
 * with `data-i18n="key"` get their text content replaced; elements marked with
 * `data-i18n-html="key"` get their inner HTML replaced (used for strings that
 * contain markup such as <code> or HTML entities like &quot;). Elements marked
 * with `data-i18n-placeholder="key"` get their `placeholder` attribute replaced
 * and elements marked with `data-i18n-aria="key"` get their `aria-label`
 * attribute replaced.
 * Call once at startup and again after every setLanguage() to re-render.
 */
export function applyStaticTranslations(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-html]')) {
    el.innerHTML = t(el.dataset.i18nHtml as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-placeholder]')) {
    el.setAttribute('placeholder', t(el.dataset.i18nPlaceholder as string));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as string));
  }
}

/**
 * Strings needed inside the Web Workers (needle.ts and translate.ts build
 * their worker sources as strings). Serialized into the worker source, where
 * a tiny `fmt` helper substitutes the `{name}` placeholders at runtime.
 * Read when a worker is created, so it reflects the language active at that
 * moment.
 */
export function getWorkerLocale(): {
  needle: { error: { downloadFailed: string; modelLoadFailed: string } };
  translation: { log: { workerError: string; unhandledRejection: string } };
} {
  return {
    needle: {
      error: {
        downloadFailed: t('needle.error.downloadFailed', { reason: '{reason}', url: '{url}' }),
        modelLoadFailed: t('needle.error.modelLoadFailed'),
      },
    },
    translation: {
      log: {
        workerError: t('translation.log.workerError', { message: '{message}' }),
        unhandledRejection: t('translation.log.unhandledRejection', { message: '{message}' }),
      },
    },
  };
}
