/**
 * Minimal i18n helper: reads the application strings from `locale.en.json`
 * and substitutes `{name}` placeholders. The JSON file is imported directly,
 * so Vite bundles it with the app — no runtime fetch is needed.
 */
import locale from '../locale.en.json';

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

const STRINGS = flatten(locale as unknown as Record<string, unknown>);

/** Formats one localized string, replacing `{placeholder}` occurrences. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = STRINGS[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/**
 * Strings needed inside the Web Workers (needle.ts and translate.ts build
 * their worker sources as strings). Serialized into the worker source, where
 * a tiny `fmt` helper substitutes the `{name}` placeholders at runtime.
 */
export const workerLocale = {
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
