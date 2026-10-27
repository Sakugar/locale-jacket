# Changelog

All notable changes to Locale Jacket are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **`npm run e2e:nav-perf`** measures what the extension costs in real Chrome and Edge (`--edge`): page-load time with and without it (unmatched site, spoofed reload, spoofed new tab, cross-site profile switch, page with a cross-site frame and a worker), and its service worker's CPU per navigation and heap with 4 and with 5,000 rules.

### Fixed
- **"Reload needed" stuck on a tab after Chrome showed a prerendered page.** When Chrome prerenders a site before you open it (the address bar does this for sites you visit often, from the new-tab page), the page it shows keeps its own main frame id. The extension kept using the tab's old id, so the navigation gate no longer recognised that tab's page loads and the start-of-page check failed. Every later load in that tab, reloads included, was flagged *This page started loading before its profile could be applied*, and a switch to a site with another profile in that tab was not re-issued with the new profile. The page itself was spoofed. The extension now follows the tab's new main frame. Seen on claude.ai.
- **The 1.4.0 known limitation "Edge: reloading a crashed tab sometimes leaves the page blank" is Edge's own behaviour, not the extension's.** Edge reports a renderer crash 0.7–1.8 s after it happens (now and then only after 20–30 s), and a reload sent before that goes to the dying renderer and is lost with it. This happens with no extension installed. The stress test now reloads only once the crash has been reported, as a user can only press the sad tab's *Reload* then, and passes in Edge every time.

## [1.4.0] - 2026-10-27

### Fixed
- **A link that loads no page left the wrong locale on the current page.** Following a link to a site with another profile when that site answered with no page (`204 No Content`, or a download) left the page you were on reporting the other site's locale (`navigator.language` and every `Intl` constructor) until it was reloaded. The extension ignored every navigation error for 5 seconds after re-issuing a navigation. Now it ignores only the one error its own abort causes, so the failed navigation restores the current page's profile.
- **Closed tabs could stay tracked for good.** A tab closed while the extension was still attaching to it (for example a link opened in a new tab and closed at once) could be brought back by a late event and kept as a failed session in the service worker's memory, about 4 in 10 such tabs. Closed tabs are now remembered and never tracked again.
- **The popup could show the previous page's check under the new page.** Right after a navigation, a check could be read from the old document while the popup already showed the new address. A result now counts only if it was read from the page the popup shows; otherwise it is read again.
- **A deleted data set still showed as "downloaded for" a subscription.** After you deleted a data set that was downloaded automatically for a subscription, Options ▸ Subscriptions kept saying it was downloaded. The line now follows what is installed: a deleted data set says it was deleted and is not downloaded again (download or import it on the Data sets page if you need it), and nothing is said once a file from another address or an imported one replaces it.
- **Corrupt GeoIP or ASN records were silent.** A corrupt record found while looking up an address counted as no match, and nothing said why an IP rule did not match. The first such record in each data set is now logged and shown on that data set's card (Options ▸ Data sets) until the file is replaced, downloaded again or deleted. It still counts as no match.
- **"Check what the page sees" graded against the wrong locale.** The popup's check compared the page with the profile last sent to the tab instead of the rule for the page that is loaded. In the case above it marked the correct locale red and the wrong one green. It now uses the rule for the loaded page, so any mismatch shows in red.
- **A large import could freeze the options page for seconds.** Importing a configuration checked each regular expression with only its own limit, so a file with thousands of patterns that are hard to check kept the page busy (8,000 such patterns: about 6 s). All the regexes of one import now share the same 750 ms budget as a subscription file or a settings load (8,000: about 0.75 s). Your own rules are never dropped because the budget ran out: the patterns it leaves unchecked are imported, the confirmation says how many, and the result names them. They never match until the extension has checked them in the background, and any it refuses are then listed under "Stored settings had problems" on the Sessions & log page. The first-run preset is imported the same way, so it always loads.
- **A refused stored rule was named only by its position.** "Stored rule #12 was invalid and has been skipped" now also shows the rule's type and value (cut short when long), for example `Stored rule #12 (DOMAIN-REGEX,^(a+)+$) was invalid…`.
- **Large subscriptions could fill the extension's storage.** Fetched subscription rules were stored verbatim, each rule repeating its locale profile, id and subscription, so 20 subscriptions of 5,000 rules took about 32 MB and passed the 10 MB `chrome.storage.local` quota (the update was then refused and the old rules kept). They are now stored compactly: each profile once per subscription, ids and the subscription rebuilt when read. The same 20 × 5,000 rules take about 2.9 MB (4.6 MB with long host names). Data saved by an older version is read as before and converted when the service worker next starts; it is not downloaded again because of it.
- **A SYSTEM page could show a spoofed `Intl` locale without a warning.** A page with no profile that shares its renderer process with a spoofed page (for example an OAuth popup to a SYSTEM site opened by a spoofed site on the same site) gets that page's `Intl` locale, because Chrome keeps one per process. The tab said "System locale" with nothing wrong. When another tab spoofs a page that may be same-site, the extension now reads the new page's locale once, through a content script and without the debugger, and shows *Partial* with the locale it found.
- **Workers started by workers kept the real `navigator.language`.** A dedicated worker started by another worker reported the browser's own `navigator.language` and `navigator.languages` (its `Intl` was already right). Workers now get the same treatment as frames: the workers they start are paused until the overrides are in place.
- **A profile switch could add an extra history entry.** When a load that started before the extension attached had to be restarted with the right profile and had already committed, the restart added a second history entry for the same page (in about 1 of 5 runs of a stress test with 10 switches). Such a load is now reloaded in place.

### Changed
- **GeoSite categories load about 3× faster and use a third of the memory.** The first GEOSITE rule that needs a large category in a service-worker life (such as `cn`, 110,000 domains) held the worker, and the pages waiting on it, for about 130 ms. Its domains are now indexed straight from the data set's bytes instead of being decoded into one string each, with the same matches. In a benchmark with the default data set, `cn` loads in about 34 ms instead of 100, and holds 2.1 MB instead of 6.1 MB. Mirroring such a category into the header rules no longer lists its domains just to find that there are too many (about 22 ms → 1 ms).

### Added
- **`npm run test:perf`** runs the performance tests with their time ceilings enforced (`LJ_PERF=1`). `npm test` runs the same code but only reports the times, so a slow or busy machine cannot fail it; where the code counts its own work (the regex check's analysis units), the tests assert on that work instead of time and always run.
- **Stress tests** (`npm run e2e:stress`, `npm run e2e:stress:edge`): restarts, crashes, navigation storms, tabs closed while loading, same-process popups, blob/srcdoc/nested workers, 5,000 rules and hostile stored regexes, in real Chrome and Edge.

### Known limitations
- **Going back to 1.3.3 or older** after running 1.4.0: the older version cannot read the new storage format for subscription rules. It uses no subscription rules until it has fetched each subscription again, at its next update or with *Update all*. Your own rules and settings are not affected.
- **Edge: reloading a crashed tab** sometimes leaves the page blank until it is reloaded again (about 1 in 8 runs of the stress test; seen before this release too, not in Chrome).
- **A SYSTEM page is checked for a shared process once, when it loads.** If a spoofed same-site page joins its renderer process later, the *Partial* warning appears only after the SYSTEM page navigates or the settings change.

## [1.3.3] - 2026-10-24

**Hotfix**: security follow-up to 1.3.1.

### Security
- **The regex check from 1.3.1 could be bypassed.** Inline modifier groups such as `(?i:a+)+$` were misread, and chains of repetitions outside a repeated group (`.*.*.*.*!`, eight `\w{0,9}` in a row) were never checked. Such a `DOMAIN-REGEX` rule or GeoSite `regexp:` entry, from a subscription or a data set, could still stall every spoofed tab for seconds to minutes. The check is rewritten:
  - Regex syntax it does not fully understand is refused.
  - A repeated group must be unambiguous: it may not be able to match the same text in more than one way.
  - Every pattern gets a worked-out upper bound on its matching work for a 253-character hostname (the longest there is), and is refused above a budget of about 40 ms on the browser's slowest, first run.
  - Refused patterns are handled as in 1.3.1 (rejected with a reason, or skipped and listed). Common hostname patterns are still accepted, and the default GeoSite data still loses only the one entry refused in 1.3.1.
- **The new check itself is bounded.** As first rewritten in this release, the check could be made slow instead of the match: a crafted 107-character pattern took 0.3–0.5 s to analyse, so a subscription with thousands of them could block the service worker for many minutes. Now:
  - Every step of the analysis is counted. A pattern that needs more than about 0.6 ms of analysis is refused as *too complex to check* (the crafted pattern above: 0.14 ms).
  - All the regexes of one subscription file, one GeoSite category or one settings load share a budget of about 750 ms. Patterns left over when it is spent are skipped (*too many complex regular expressions in this list*). The outcome depends only on the file: a verdict remembered from an earlier check is charged what it originally cost.
  - Fetched subscription rules record which version of the check accepted them, so they are not checked again each time the service worker wakes. Rules fetched with an older check are fetched again in full at the next automatic update the minimum gap allows (never for a subscription that is switched off or whose updates are off); until then, each of their patterns is checked before it is first used.
  - While a page waits, at most 50 ms per service-worker life goes to checking stored patterns that have not been checked yet. The rest are checked in short slices between other events, and a pattern that has not been checked never runs: it counts as no match until then.
  - Your own `DOMAIN-REGEX` rules are never dropped because a budget ran out. Rules the settings load left unchecked are kept and checked later; one that is refused then never matches and is listed with the other settings problems.
- **MaxMind (`.mmdb`) data sets** are decoded with limits on the number of values, the nesting depth and the bytes of text per record. Pointers to pointers are refused and every read is bounds-checked. Before, a tiny crafted file (a data set can come from an address a subscription names) could keep the service worker busy for seconds to minutes or crash it. A downloaded or imported file must also decode a few sample records; a corrupt record found later counts as no match.
- **Downloads have limits**: an overall time limit, a limit on how long the server may stop sending, and a size cap counted while the data arrives.

  | Download | Size | Overall time | No data for |
  |---|---|---|---|
  | Subscription file | 2 MB | 1 min | 20 s |
  | Data set | 128 MB | 15 min | 1 min |
  | Update check | 5 MB | 30 s | 15 s |

  A server that answered and then stopped sending used to block every later run (including *Update now*). The subscription size limit now counts bytes (it counted characters), and a file sent without a length is no longer read in full before it is checked.

### Fixed
- Turning spoofing off (or leaving a spoofed site) now always detaches the debugger. A session whose command was cut off, for example by a renderer swap, or whose attach timed out could be forgotten while Chrome still held it, so the spoofed locale and the debugging banner stayed.
- Settings saved quickly one after another could be applied out of order. They are now applied one at a time, always with the latest settings.
- One invalid stored setting no longer resets your subscriptions, default action and on/off switch. Only the invalid part is reset, and it is listed with the other settings problems.
- A data set you deleted is no longer downloaded again automatically because a subscription needs it. It is downloaded again once a subscription needs it after none did, or if the address changes.
- When the browser storage is full, saving fetched subscription rules shows an error on the subscription and keeps the previous rules, instead of failing silently with the rules in use and the saved ones out of step.
- First-request header (DNR) rules that Chrome cannot use are skipped and listed, instead of making Chrome reject the whole update. If an update still fails, the old header rules are removed rather than left in force. `DOMAIN-KEYWORD` values are limited to 253 characters.
- The data-set update schedule counts a manual download as a fresh check.
- *Check what the page sees* no longer marks values red while spoofing is off or paused, and gives the right expectation for a tab the extension has not tracked yet.
- Cancelling Chrome's debugging banner stops new attaches at once, so a navigation at that moment cannot bring the banner back. A tab whose debugger is already held by another client now counts towards the attach-failure limit instead of being retried without end.
- Popup: the cards are rebuilt only when what they show changes, not every 1.5 s, so clicks and focus are no longer lost and screen readers no longer repeat the status. A navigation drops the previous page check, and the *Saved* note stays.
- Options: the page-check card on *Test & verify* updates in place, reacts only to the tab you chose, and shows an error instead of staying on *Checking…*. Text typed into the hostname tester, the new-subscription fields and the import box survives settings changes.

### Changed
- **Faster with large rule lists.** Matching looks up `DOMAIN` and `DOMAIN-SUFFIX` rules by the host's labels, finds `DOMAIN-KEYWORD` rules and `DOMAIN-REGEX` rules with a fixed piece of text (3+ characters) through an index, ranks only the rules that match, and remembers each host's hostname-rule matches (`GEOSITE` and IP rules are still evaluated every time). Results are the same as before. Locale and time-zone validation is remembered, and a subscription file over the 5,000-rule limit is refused as soon as its 5,001st valid rule is read (*more than 5000 rules (N entries)*). Measured in Node with 5,000 rules:

  | | Before | After |
  |---|---|---|
  | Matching a host, per navigation | 4.3 ms | 0.009 ms |
  | First match after the service worker wakes | 109 ms | 7 ms |
  | … with 5,000 hostile regexes from an older check | 3.4 s | 61 ms |
  | Loading the settings | 375 ms | 130 ms |
  | Parsing a 2 MB subscription file | 456 ms | 168 ms |
  | Refusing a 20,000-rule file | 1.44 s | 0.14 s |
  | Rule checks on *Options ▸ Rules* | 5.7 s | 38 ms |
  | Analysing the slowest accepted regex | 142–208 ms | 0.47 ms |

- Development:
  - `npm run diff-pack` takes the previous release only from `release/v<version>/locale-jacket-<version>.zip`; loose zips in `release/` are ignored.
  - The release scripts' zip reader checks signatures, sizes and CRC-32 of every entry. The release scripts have unit tests.
  - The verification server (`npm run serve:verify`) listens on the loopback address only.
  - Building needs Node.js 20.15+ or 22.2+ (`engines` in `package.json`).

## [1.3.2] - 2026-10-23

### Fixed
- *Check what the page sees* in the popup, and *Verify* in *Options ▸ Test & verify*, are read again when the tab reloads or navigates, instead of showing the values from before until you click again. The options page also follows tabs being opened and closed and keeps the tab you picked.
- Checking works on every website, also where the extension has no debugger session (sites left at the system language, or a tab not attached yet). Those values are read through `chrome.scripting` in an isolated world; there are no "at start" values in that case.

### Changed
- New permission `scripting`, used only for that check. It adds no warning, because host access is already granted.

## [1.3.1] - 2026-10-23

**Hotfix** for 1.3.0.

### Security
- Regular expressions that could take too long to match are refused. JavaScript regexes backtrack, so a pattern such as `^(a+)+$` can take seconds or longer on some hostnames. The service worker runs them while a page waits for it, so one such pattern stalled every tab. It applies to:
  - `DOMAIN-REGEX` rules you add or import: refused with a reason. A saved rule like that is dropped when the settings load, and the reason is shown with the other settings problems.
  - `DOMAIN-REGEX` rules in subscription files: skipped and listed like other invalid entries. Rules fetched before this release no longer match.
  - `regexp:` entries in GeoSite data sets: skipped (counted as unusable entries). The default data set has one such pattern, `^(.+\.)*zh\.okaapps\.com$`, which took 36 s on a 57-character hostname.
- Refused: repeating a group that contains `|`, or one that can split the same text in more than one way (`(a+)+`, `(.+\.)*`); back-references; more than 4 unbounded repetitions; more than 512 characters. Ordinary patterns such as `^(.+\.)?example\.com$`, `([a-z0-9-]+\.)*` and `(-[a-z0-9]+)*` are still accepted.

## [1.3.0] - 2026-10-23

### Added
- **Rule subscriptions** (*Options ▸ Subscriptions*): rules from JSON or YAML files on the internet, fetched when added and kept up to date (daily by default; weekly, monthly or never).
  - Links to a GitHub file page or a gist are turned into the raw file. A link that returns a web page is refused with an explanation.
  - Updates are conditional (ETag / Last-Modified), with *Update now* and *Update all*.
  - Subscription rules are kept apart from your own and shown read-only. Precedence is your rules, then subscription rules, then your special rules (GEOSITE and IP rules), then subscription special rules; between subscriptions, the higher one wins, and they can be reordered or switched off.
  - Only `rules` is read from a file. Invalid entries are skipped and listed, without rejecting the file.
  - Subscriptions are part of the exported and imported configuration.
- **Data sets for subscriptions:** a missing GeoSite, GeoIP or ASN data set that subscription rules need is downloaded automatically, from the URL the file names (`datasets:`) or the default. It is an option, on by default, and a failed download is retried after an hour.
- Subscription rules show their subscription's name wherever the matched rule is shown (popup, tester, status).

### Changed
- Rule precedence has a new first step, four tiers: your rules › subscription rules › your special rules (GEOSITE, IP-CIDR, IP-CIDR6, IP-ASN, GEOIP) › subscription special rules. Within the subscription tiers, the earlier subscription wins.
- The first-request header rules (DNR) no longer mirror a rule that ranks below an IP rule, since the server address might decide instead. The debugger still applies it.
- *Options ▸ Updates* only tells you that a newer version exists (version, date, link to its release page). The popup tip and the version badge stay.

### Removed
- From the Updates page: the release notes, the download links, the step-by-step update instructions and the *Reload extension* button.

## [1.2.2] - 2026-10-23

### Added
- **The installed version is shown** next to the popup title and at the bottom of the options sidebar.
- **Options ▸ Updates**, which checks for a newer release:
  - It checks only when you click *Check now*, or on browser start and/or daily, weekly or monthly if you turn that on. Automatic checks are off by default and run at most once every 12 hours.
  - It asks only the release address shown on the page (a GitHub "latest release" API URL, editable).
  - When a newer version is found, the popup shows a tip and the *Updates* link shows its number. The page shows the release notes as plain text, links to the diff pack from your version, the zip and the crx, the steps for your kind of install, and a *Reload extension* button.

### Known limitations
- Chrome never updates an unpacked folder, so an unpacked install cannot update itself: the page shows what to download and how to apply it.
- While the GitHub repository is private, GitHub answers 404 to update checks; the page explains this.

## [1.2.1] - 2026-10-23

### Added
- **Loads that start before the debugger can attach are restarted while still in flight.** This covers new tabs opened with a URL, the browser's startup page and the restored tab. The extension stops the load, applies the profile, and loads the page again through the navigation gate. The page renders once, already spoofed, instead of loading and then reloading.
  - Only repeatable loads are restarted: a GET, or the browser's own loads within 10 s of it or the extension starting. Form submissions (POST) are never repeated.
  - It belongs to *Reload once if the profile arrived late* and happens at most once per URL.
- **First-run rules file.** The unpacked build contains `presets/default-rules.yaml`, in the same format as *Import / export*; edit it before loading the folder to start with your own rules. The `.crx` ships without it and generates the example preset itself.
- **Diff packs.** Every release ships `locale-jacket-<previous>-to-<version>.diff.zip`, which holds only the files added or changed since the previous release, with `CHANGES.txt` (SHA-256 per file) and `DELETED.txt`.
- **README in nine more languages,** under `docs/i18n/`.
- **Testing tools.** A startup check page, `verify/public/launch.html`, and `npm run e2e:launch`, which measures what sites see at browser launch and how long page loads take. The verification server accepts `?delay=` to imitate slow sites.

### Changed
- At start-up, the service worker attaches to open tabs as soon as the settings are loaded, before the header-rule, badge and alarm setup (about 40 ms earlier).
- `webRequest` now also observes the method of top-level page loads (memory only), so only safe loads are restarted. The permission text is updated in every language.

### Fixed
- The browser's startup page and the restored tab kept the real locale until they were reloaded by hand. They are now restarted, or reloaded once when they had already loaded.
- If a stopped load had already begun committing into another renderer process, the page could stay unspoofed. It now falls back to the reload.

### Known limitations
- On very fast servers, a page in a new tab or at startup can finish loading before the extension attaches. It is then reloaded once.
- The startup measurements use Chromium with `--load-extension`, which installs the extension afresh on every start. Branded Chrome and Edge cannot load an unpacked extension at startup, so the installed-extension case was approximated by waking a stopped service worker.

## [1.2.0] - 2026-10-21

### Added
- The interface in eight more languages: 繁體中文, 日本語, 한국어, Deutsch, Français, Español, Русский and Português (Brasil).
  - *Auto* follows the browser language.
  - The extension's name and description are translated too.
- Opt-in automatic data-set updates (*Options ▸ Data sets ▸ Automatic updates*):
  - on browser start, or daily, weekly or monthly;
  - a minimum gap (default 24 h, 1–720 h) that counts failed attempts too;
  - conditional requests, so unchanged files are not downloaded again;
  - a *Check now* button and per-data-set results.
- `alarms` permission, used only while a regular update interval is chosen.

### Known limitations
- Detailed input-validation messages and the activity log stay in English.

## [1.1.0] - 2026-10-21

### Added
- Clash-style IP and GEO rules: `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN`, `GEOIP` (including `LAN`), and `no-resolve`.
- Optional GeoSite, GeoIP and ASN data sets, downloaded from an editable URL or imported from disk. They are validated and stored locally.
- IP rules use the address Chrome connected to, kept in memory; no DNS lookups.
- The interface in English and 简体中文.
- `tools/chrome-banner-flag.ps1`, which launches Chrome or Edge without the debugging banner. It hides the banner for all extensions that use the debugger.
- `webRequest` permission, used only to observe server addresses while IP rules exist.

### Known limitations
- The first visit to a host is decided without its server address, and the page may be reloaded once.

## [1.0.0] - 2026-10-21

### Added
- Per-site browser locale through Chrome's own emulation (`Emulation.setLocaleOverride` and an Accept-Language-only `setUserAgentOverride`), with no JavaScript monkey-patching.
  - Optional time zone and geolocation, both off by default.
- Domain rules: `DOMAIN`, `DOMAIN-SUFFIX` and `DOMAIN-KEYWORD`, with `SYSTEM`/`DIRECT` exceptions, a default action, deterministic precedence and IDN support.
- A navigation gate. A navigation that changes profile is aborted before it reaches the server, the profile is applied, and the navigation is re-issued, keeping back/forward and reload intact.
- Cross-site iframes and dedicated workers are configured before their first script. An optional per-frame mode gives each frame its own rule.
- declarativeNetRequest gives the first document request the right `Accept-Language`.
- Popup with tab status and a "what the page sees" check. Options page with the rule editor, hostname tester, tab verification, JSON/YAML import and export, and the session log.

### Known limitations
- Chrome shows its "started debugging this browser" banner while spoofing is active; cancelling it pauses the extension.
- The first page opened from the New Tab Page is reloaded once.
- The `Intl` locale is per renderer process, so a conflicting profile in a shared process is reported as *Partial*.
- Service workers, shared workers and restricted pages are not spoofed. POST navigations that change profile are flagged *Reload needed*.

[Unreleased]: https://github.com/Sakugar/locale-jacket/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/Sakugar/locale-jacket/compare/v1.3.3...v1.4.0
[1.3.3]: https://github.com/Sakugar/locale-jacket/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/Sakugar/locale-jacket/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/Sakugar/locale-jacket/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Sakugar/locale-jacket/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/Sakugar/locale-jacket/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Sakugar/locale-jacket/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Sakugar/locale-jacket/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Sakugar/locale-jacket/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Sakugar/locale-jacket/releases/tag/v1.0.0
