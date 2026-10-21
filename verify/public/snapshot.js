// Collects every locale-related value a website can observe from JavaScript.
// Shared by the verification page, its iframes and its workers.
// Works in window and worker scopes (no DOM access).
(function (global) {
  function snapshot() {
    const r = {};
    const get = (key, fn) => {
      try {
        r[key] = fn();
      } catch (e) {
        r[key] = 'ERR: ' + (e && e.message ? e.message : String(e));
      }
    };
    const ro = (ctor, ...args) => new ctor(...args).resolvedOptions().locale;
    get('language', () => navigator.language);
    get('languages', () => Array.from(navigator.languages || []));
    get('dateLocale', () => Intl.DateTimeFormat().resolvedOptions().locale);
    get('numberLocale', () => Intl.NumberFormat().resolvedOptions().locale);
    get('collatorLocale', () => Intl.Collator().resolvedOptions().locale);
    get('pluralRulesLocale', () => ro(Intl.PluralRules));
    get('relativeTimeLocale', () => ro(Intl.RelativeTimeFormat));
    get('listFormatLocale', () => ro(Intl.ListFormat));
    get('segmenterLocale', () => ro(Intl.Segmenter));
    get('displayNamesLocale', () => ro(Intl.DisplayNames, undefined, { type: 'region' }));
    get('durationFormatLocale', () => (typeof Intl.DurationFormat === 'function' ? ro(Intl.DurationFormat) : 'n/a'));
    get('timeZone', () => Intl.DateTimeFormat().resolvedOptions().timeZone);
    get('timezoneOffset', () => new Date(Date.UTC(2024, 0, 15, 12)).getTimezoneOffset());
    get('dateString', () => new Date(Date.UTC(2024, 0, 15, 12)).toLocaleDateString());
    get('numberString', () => (1234567.891).toLocaleString());
    get('userAgent', () => navigator.userAgent);
    get('uaBrands', () =>
      navigator.userAgentData
        ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version).join(', ')
        : 'n/a',
    );
    return r;
  }
  global.__ljSnapshot = snapshot;
})(typeof self !== 'undefined' ? self : globalThis);
