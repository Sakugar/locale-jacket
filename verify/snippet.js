// Locale verification snippet: paste into the DevTools console on any website.
// Note: opening DevTools on a spoofed tab is fine; DevTools ▸ Sensors ▸ Locale is the
// only DevTools feature that conflicts (both want the same process-wide override).
(() => {
  const ro = (C, ...a) => { try { return new C(...a).resolvedOptions().locale; } catch (e) { return 'n/a'; } };
  const r = {
    language: navigator.language,
    languages: navigator.languages.join(', '),
    dateLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    numberLocale: Intl.NumberFormat().resolvedOptions().locale,
    collatorLocale: Intl.Collator().resolvedOptions().locale,
    pluralRulesLocale: ro(Intl.PluralRules),
    relativeTimeLocale: ro(Intl.RelativeTimeFormat),
    listFormatLocale: ro(Intl.ListFormat),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sampleDate: new Date(Date.UTC(2024, 0, 15, 12)).toLocaleString(),
    sampleNumber: (1234567.891).toLocaleString(),
  };
  console.table(r);
  // The Accept-Language this page's requests carry (same-origin echo is not available on
  // arbitrary sites, so show what navigator.languages implies; Chrome derives the header from it).
  const q = navigator.languages.map((l, i) => (i === 0 ? l : `${l};q=${Math.max(0.1, 1 - i / 10).toFixed(1)}`)).join(',');
  console.log('Expected Accept-Language:', q);
  return r;
})();
