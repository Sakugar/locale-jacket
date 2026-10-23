# Changelog

All notable changes to Locale Jacket are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/Sakugar/locale-jacket/compare/v1.3.0...HEAD
[1.3.0]: https://github.com/Sakugar/locale-jacket/compare/v1.2.2...v1.3.0
[1.2.2]: https://github.com/Sakugar/locale-jacket/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/Sakugar/locale-jacket/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/Sakugar/locale-jacket/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/Sakugar/locale-jacket/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Sakugar/locale-jacket/releases/tag/v1.0.0
