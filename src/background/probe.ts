// Read-only probes evaluated in an isolated world, so pages cannot observe them.
// The document-start probe records what page scripts saw first; the verify
// expression reads the live values. Neither modifies any page-visible API.

import { hostFromUrl } from '../shared/domain.js';
import { t } from '../shared/i18n.js';
import type { FrameVerification, LocaleSnapshot, VerifyResult } from '../shared/messages.js';

export const PROBE_WORLD = '__localeJacketProbe';

/** Self-contained: it is serialized into CDP expressions and passed to chrome.scripting. */
export function localeSnapshot(): LocaleSnapshot {
  const ro = (C: new () => { resolvedOptions(): { locale: string } }) => {
    try {
      return new C().resolvedOptions().locale;
    } catch {
      return 'n/a';
    }
  };
  return {
    language: navigator.language,
    languages: Array.from(navigator.languages || []),
    dateLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    numberLocale: Intl.NumberFormat().resolvedOptions().locale,
    collatorLocale: Intl.Collator().resolvedOptions().locale,
    pluralRulesLocale: ro(Intl.PluralRules),
    relativeTimeLocale: ro(Intl.RelativeTimeFormat),
    listFormatLocale: ro(Intl.ListFormat),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

export interface PageLocale {
  url: string;
  language: string;
  dateLocale: string;
}

/** Self-contained (passed to chrome.scripting): the document's URL and the values a shared process can change. */
export function pageLocale(): PageLocale {
  return { url: location.href, language: navigator.language, dateLocale: Intl.DateTimeFormat().resolvedOptions().locale };
}

/** Read pageLocale() in the tab's main frame through an isolated-world content script (no debugger needed). */
export async function readPageLocale(tabId: number): Promise<PageLocale | null> {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: pageLocale });
  return r?.result ?? null;
}

const SNAPSHOT_FN = localeSnapshot.toString();

export const PROBE_SOURCE = `(() => { try { if (!globalThis.__ljProbe) globalThis.__ljProbe = (${SNAPSHOT_FN})(); } catch (e) {} })();`;

export const VERIFY_EXPRESSION = `(() => ({ url: location.href, start: globalThis.__ljProbe || null, live: (${SNAPSHOT_FN})() }))()`;

/**
 * Read the live values without the debugger (tabs with no session), through an
 * isolated-world content script. There are no document-start values in this case.
 */
export async function verifyWithScripting(tabId: number, expectedLocale: string | null): Promise<VerifyResult> {
  let results: chrome.scripting.InjectionResult<LocaleSnapshot>[];
  let urls: Map<number, string>;
  try {
    const [r, all] = await Promise.all([
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: 'ISOLATED', func: localeSnapshot }),
      chrome.webNavigation.getAllFrames({ tabId }),
    ]);
    results = r;
    urls = new Map((all ?? []).map((f) => [f.frameId, f.url]));
  } catch (e) {
    return { ok: false, attached: false, source: 'script', frames: [], error: (e as Error).message };
  }
  const mainHost = hostFromUrl(urls.get(0) ?? '');
  const frames: FrameVerification[] = [];
  for (const r of results) {
    const url = urls.get(r.frameId) ?? '';
    const isMain = r.frameId === 0;
    const host = hostFromUrl(url);
    // The page and its frames on other hosts (the debugger path lists cross-site frames).
    if (!r.result || (!isMain && (!host || host === mainHost || frames.some((f) => f.url === url)))) continue;
    frames.push({ kind: isMain ? 'main' : 'iframe', url, start: null, live: r.result, expectedLocale: isMain ? expectedLocale : null, error: null });
  }
  frames.sort((a, b) => (a.kind === 'main' ? -1 : b.kind === 'main' ? 1 : 0));
  const ok = frames.length > 0 && frames.every((f) => !f.expectedLocale || f.live?.dateLocale === f.expectedLocale);
  return { ok, attached: false, source: 'script', frames, error: frames.length ? null : t('bg.verify.unreadable') };
}

