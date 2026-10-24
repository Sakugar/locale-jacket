# Changelog

All notable changes to Locale Jacket are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

Security follow-up to 1.3.1.

### Security
- **The regex check from 1.3.1 could be bypassed.** Inline modifier groups such as `(?i:a+)+$` were misread, and chains of repetitions outside a repeated group (`.*.*.*.*!`, eight `\w{0,9}` in a row) were never checked. Such a `DOMAIN-REGEX` rule or GeoSite `regexp:` entry, from a subscription or a data set, could still stall every spoofed tab for seconds to minutes. The check is rewritten:
  - Regex syntax it does not fully understand is refused.
  - A repeated group must be unambiguous: it may not be able to match the same text in more than one way.
  - Every pattern gets a worked-out upper bound on its matching work for a 253-character hostname (the longest there is), and is refused above a budget of about 40 ms on the browser's slowest, first run.
  - Refused patterns are handled as in 1.3.1 (rejected with a reason, or skipped and listed). Common hostname patterns are still accepted, and the default GeoSite data still loses only the one entry refused in 1.3.1.
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

[Unreleased]: https://github.com/Sakugar/locale-jacket/compare/v1.3.2...HEAD
[1.3.2]: https://github.com/Sakugar/locale-jacket/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/Sakugar/locale-jacket/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/Sakugar/locale-jacket/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/Sakugar/locale-jacket/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Sakugar/locale-jacket/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Sakugar/locale-jacket/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Sakugar/locale-jacket/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Sakugar/locale-jacket/releases/tag/v1.0.0
