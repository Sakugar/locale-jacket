// Read-only probes evaluated in an isolated world, so pages cannot observe them.
// The document-start probe records what page scripts saw first; the verify
// expression reads the live values. Neither modifies any page-visible API.

export const PROBE_WORLD = '__localeJacketProbe';

const SNAPSHOT_FN = `function () {
  const ro = (C, ...a) => { try { return new C(...a).resolvedOptions().locale; } catch (e) { return 'n/a'; } };
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
}`;

export const PROBE_SOURCE = `(() => { try { if (!globalThis.__ljProbe) globalThis.__ljProbe = (${SNAPSHOT_FN})(); } catch (e) {} })();`;

export const VERIFY_EXPRESSION = `(() => ({ url: location.href, start: globalThis.__ljProbe || null, live: (${SNAPSHOT_FN})() }))()`;
