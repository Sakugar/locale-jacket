# Locale Jacket

**English** · [简体中文](docs/i18n/README.zh-CN.md) · [繁體中文](docs/i18n/README.zh-TW.md) · [日本語](docs/i18n/README.ja.md) · [한국어](docs/i18n/README.ko.md) · [Deutsch](docs/i18n/README.de.md) · [Français](docs/i18n/README.fr.md) · [Español](docs/i18n/README.es.md) · [Русский](docs/i18n/README.ru.md) · [Português (Brasil)](docs/i18n/README.pt-BR.md)

A Chrome/Edge (Manifest V3) extension that makes websites see a **different browser locale per site** (for example `en-US` on google.com and `ja-JP` on apple.com) while the browser's own UI language stays unchanged (for example Simplified Chinese).

It automates what **DevTools ▸ Sensors ▸ Locale** does, applying it to every matching tab without opening DevTools. Routing works like Clash, sing-box or Shadowrocket rules: `DOMAIN`, `DOMAIN-SUFFIX`, `DOMAIN-KEYWORD`, `DOMAIN-REGEX`, `GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN` and `GEOIP`, with `SYSTEM`/`DIRECT` exceptions and a default action.

| What a site observes | How it is spoofed | Coverage |
|---|---|---|
| `Intl.*` (DateTimeFormat, NumberFormat, Collator, PluralRules, RelativeTimeFormat, ListFormat, DisplayNames, Segmenter, `toLocaleString` …) | `Emulation.setLocaleOverride` (Chrome's ICU default locale) | Page, same-site frames, cross-site frames, dedicated workers |
| `navigator.language`, `navigator.languages` | `Emulation.setUserAgentOverride` with **only** `acceptLanguage` (the User-Agent string and UA client hints are left untouched) | Page, frames, dedicated workers |
| HTTP `Accept-Language` | The same override, a corrected header on the paused document request, and a `declarativeNetRequest` rule for top-level documents | Documents, subresources, `fetch()`, worker requests |
| Time zone, geolocation | `Emulation.setTimezoneOverride` / `setGeolocationOverride`, **off by default**, per rule | Page and frames |

No JavaScript APIs are monkey-patched. Everything was checked against real Chrome 155 and Edge 155; see [research/FINDINGS.md](research/FINDINGS.md).

<p>
<img src="docs/images/popup.png" width="300" alt="Popup showing the active profile for the current tab">
<img src="docs/images/options-test.png" width="520" alt="Options page: hostname tester and per-API verification">
</p>

## Install

Requirements: Node.js 20+ (only to build), and Chrome or Edge 125 or later (developed and tested on 155).

```sh
npm install
npm run build        # produces dist/
```

**Chrome:** open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and select the `dist/` folder.
**Edge:** open `edge://extensions`, turn on **Developer mode**, click **Load unpacked** and select `dist/`.

Pin the extension so its badge (for example `EN` or `JA`) shows which profile the current tab uses. To use it in private windows, enable **Allow in Incognito** on the extension's details page.

**First-run rules.** On a fresh install the extension reads `presets/default-rules.yaml` from its folder (the example preset, same format as *Import / export*). Edit that file before loading the folder to start with your own rules. It is only read when the browser has no saved Locale Jacket settings; later changes are made in the options page. The `.crx` does not contain this file and generates the same example preset instead.

`npm run package` creates `release/locale-jacket-<version>.zip` for uploading to a store.

`npm run crx` creates a signed `release/locale-jacket-<version>.crx` using Chrome's own packer.
- The signing key is generated on first use in `keys/locale-jacket.pem` (git-ignored) and reused afterwards. It determines the extension ID, so back it up.
- Chrome and Edge only install `.crx` files from outside their stores when an enterprise policy allows it (`ExtensionInstallAllowlist` / `ExtensionInstallForcelist`). For personal use, **Load unpacked** is the way to install.
- The `.crx` is packed from a copy of `dist/` without `presets/`, and the packer refuses to write one that contains it.

`npm run diff-pack` creates `release/locale-jacket-<previous>-to-<version>.diff.zip` with only the files that were added or changed since the previous release (`--from <version|zip>` to choose it). To upgrade an unpacked install, copy its contents over the old folder, delete the files listed in `DELETED.txt` (if present) and reload the extension. `CHANGES.txt` lists every added (A), modified (M) and deleted (D) file with its SHA-256.

### What to expect

- On first install the **example preset** from the specification is active:

  | Rule | Result |
  |---|---|
  | `DOMAIN-SUFFIX,google.com` | `en-US` |
  | `DOMAIN-SUFFIX,openai.com` | `en-US` |
  | `DOMAIN-SUFFIX,apple.com` | `ja-JP` |
  | `DOMAIN-SUFFIX,yahoo.co.jp` | `ja-JP` |
  | `DOMAIN,accounts.google.com` | `SYSTEM` |
  | default | `SYSTEM` |

  Edit or delete these rules freely.
- While any tab is being spoofed, Chrome shows **"Locale Jacket started debugging this browser"**. This is Chrome's security notice for the `chrome.debugger` API. The extension does not hide it. Clicking **Cancel** on it pauses Locale Jacket until you press **Resume** in the popup. If you accept the trade-off, you can hide it yourself; see [Hiding the debugging banner (optional)](#hiding-the-debugging-banner-optional).
- The browser UI language, Chrome's language settings and other extensions are never changed.

### Hiding the debugging banner (optional)

> **Security trade-off.** Chrome shows that banner for *every* extension that uses the `debugger` permission. Hiding it hides it for all of them, not just Locale Jacket. Do this only if you trust every installed extension.

Chrome has no setting, policy or `chrome://flags` entry for this; checked against all 666 flags in Chrome 155 and 213 in Edge 155. The only option is the launch switch `--silent-debugger-extension-api`. Chrome reads it only when its **first** process starts, so every way Chrome can be launched needs it. The extension never sets it.

[`tools/chrome-banner-flag.ps1`](tools/chrome-banner-flag.ps1) (Windows, PowerShell 5.1 or 7) does this for you:

```powershell
pwsh -File tools\chrome-banner-flag.ps1                   # status only: shortcuts, link handler, running browser
pwsh -File tools\chrome-banner-flag.ps1 -Apply            # add the switch (Chrome)
pwsh -File tools\chrome-banner-flag.ps1 -Apply -Browser Both   # Chrome and Edge
pwsh -File tools\chrome-banner-flag.ps1 -Revert           # undo, from the backup
```

**What `-Apply` changes:**
- Adds the switch to every Chrome (or Edge) shortcut on the taskbar, Start menu, desktop and Quick Launch. Existing arguments such as `--profile-directory` are kept.
- Adds it to the per-user http/https link handler (`HKCU\Software\Classes\ChromeHTML\shell\open\command`, or `MSEdgeHTM` for Edge), so links opened from other apps also start the browser with it.
- Saves the original values to `%LOCALAPPDATA%\LocaleJacket\banner-flag-backup.json`, which is what `-Revert` restores.
- Shortcuts for all users (under `%ProgramData%` or the Public desktop) need an elevated PowerShell. Without one they are skipped with a warning.

**After applying:**
1. Quit Chrome completely: close every window and the tray icon, and turn off *Settings ▸ System ▸ Continue running background apps*. Otherwise a Chrome already running without the switch is reused.
2. Start Chrome from a shortcut.
3. Check `chrome://version` ▸ **Command Line**, or run the script again without arguments; it should say `started WITH the flag`.

Chrome updates and "make default browser" can rewrite the shortcuts or the link handler, so re-check after updating. To do it by hand instead, add ` --silent-debugger-extension-api` after `chrome.exe` in each shortcut's **Target**, and in the link handler before `--single-argument %1`.

## Interface language

The popup and options page are available in **English**, **简体中文**, **繁體中文**, **日本語**, **한국어**, **Deutsch**, **Français**, **Español**, **Русский** and **Português (Brasil)**. By default they follow the browser’s UI language (other Chinese variants map to 简体中文 or 繁體中文 by script/region, Portuguese to Brazilian Portuguese, anything else to English); change it in *Options ▸ Settings ▸ Display language*. This only affects Locale Jacket’s own pages, never what websites see. Detailed input-validation messages and the activity log are in English.

To add a language: copy `src/shared/i18n/en.ts` to a new catalog, register it in `src/shared/i18n.ts` (`CATALOGS`, `UI_LANGUAGES` and, if needed, `matchLanguage`), and add `static/_locales/<code>/messages.json` for the extension name and description. A missing key is a compile error, and `npm test` checks that every translation keeps the English placeholders.

## Using it

**Popup** (toolbar icon)
- Turns spoofing on or off for all sites.
- Shows the current tab: matched rule, profile, status, and a **Check what the page sees** button that reads the live values and the values the page's first scripts saw.
- Adds or changes a rule for the current site (its suffix, or the exact host) or excludes it with *System locale*.
- Sets the default for all other websites.

**Options page** (*Manage rules…*)
- **Rules:** enable or disable, reorder, edit, delete. Each rule's effective rank is shown, and duplicates, conflicts and redundant or no-op rules are flagged.
- **Rule editor:** match type (`DOMAIN-SUFFIX` by default), domain or keyword (IDN and pasted URLs accepted), and either *SYSTEM* or a full locale profile:
  - locale (presets or any validated BCP 47 tag)
  - `navigator.languages` and the resulting Accept-Language
  - optional time zone and geolocation
  - priority and note
- **Test & verify:** type a hostname and see which rules match and why, or pick an open tab and see what every locale API reports in the page and its cross-site frames.
- **Import / export:** JSON or YAML, replacing or merging.
- **Settings:**
  - frame mode
  - whether the debugger session is kept after leaving a spoofed site
  - the one-time reload when the profile arrived late
  - the DNR header rules
  - worker overrides
- **Sessions & log:** which tabs are being debugged, their status, and an in-memory activity log.
- **Subscriptions:** see [Rule subscriptions](#rule-subscriptions).
- **Updates:** see [Updating](#updating).

## Rule subscriptions

*Options ▸ Subscriptions* pulls rules from files on the internet and keeps them up to date, in the same JSON or YAML format as *Import / export*.

- **Adding one:** paste the file's address and click **Add**.
  - A link to the file's page on GitHub (`https://github.com/<owner>/<repo>/blob/<branch>/<path>`) or to a gist is turned into the raw file automatically.
  - A link that still returns a web page is refused with an explanation.
  - A new subscription is fetched right away, then on its schedule: daily by default, or weekly, monthly or never.
  - Updates are conditional (`ETag` / `Last-Modified`), so an unchanged file is not downloaded again. Use **Update now** or **Update all** to fetch at once.
- **Separate from your own rules:**
  - Subscription rules are stored apart from the rules on the *Rules* page and shown read-only.
  - Order: your rules, subscription rules, your **special** rules (`GEOSITE`, `IP-CIDR`, `IP-CIDR6`, `IP-ASN`, `GEOIP`), then subscription special rules. Between subscriptions, the one higher in the list wins; reorder them with ↑ ↓.
  - So a subscription's hostname rule beats your own GeoSite or IP rule, while your special rules beat a subscription's special rules.
  - To handle a site differently from a subscription, add your own hostname rule (exact, suffix or keyword), for example from the popup.
  - Because the first-request header rules cannot see server addresses, a rule that ranks below an IP rule (such as a subscription's `GEOSITE` below your own `IP-CIDR`) is applied by the debugger only.
  - Each subscription can be switched off without removing it.
- **What is used from a file:** only `rules`. A file cannot change your default action, options or subscriptions. Entries that are not valid rules are skipped and listed, without rejecting the file.
- **Data sets:**
  - If a subscription has `GEOSITE`, `GEOIP` or `IP-ASN` rules and that data set is not installed, it is downloaded automatically. This is the option *Download the data sets subscriptions need*, on by default.
  - The file may name where to get each one; otherwise the default address from *Data sets* is used:

    ```yaml
    datasets:
      geosite: https://example.com/geosite.dat
    rules:
      - GEOSITE,google,en-US
      - DOMAIN-SUFFIX,example.org,fr-FR
    ```
- **Limits:** up to 20 subscriptions, 5,000 rules and 2 MB per file. Very large rule sets can exceed Chrome's limit for the first-request header rules; those rules still work through the debugger.

Subscriptions are part of the exported configuration (name, address, on/off, schedule), so `subscriptions:` can also be imported.

```yaml
subscriptions:
  - name: Team rules
    url: https://github.com/example/locale-rules/blob/main/rules.yaml
    interval: weekly
```

## Updating

The installed version is shown next to the popup title and at the bottom of the options sidebar. *Options ▸ Updates* checks for a newer release:

- **When it checks:** only when you click **Check now**, or, if you turn them on, automatically when the browser starts and/or every day, week or month. Automatic checks are off by default, and there is at most one every 12 hours.
- **Where it asks:** only the release address shown on the page, by default `https://api.github.com/repos/Sakugar/locale-jacket/releases/latest`. While that repository is private, GitHub answers 404 to anyone not signed in, and the page says so; point the address at a public copy, or check the Releases page yourself.
- **When a newer version is found:** it is only a tip. The popup shows a notice, the *Updates* link shows the new version number, and the page links to the release page. The extension downloads and installs nothing; see [Install](#install) for how to upgrade (the diff pack or the full zip).

## Rules

```yaml
rules:
  - type: DOMAIN-SUFFIX        # google.com and every subdomain (label boundaries)
    domain: google.com
    locale: en-US
  - type: DOMAIN               # exact host only
    domain: accounts.google.com
    action: SYSTEM             # keep the real browser locale (DIRECT is an alias)
  - type: DOMAIN-KEYWORD       # hostname contains the text
    keyword: microsoft
    locale: en-GB
  - type: DOMAIN-SUFFIX
    domain: apple.com
    locale: ja-JP
    languages: [ja-JP, ja, en]   # optional; default [locale, base language]
    timezone: Asia/Tokyo         # optional, off unless set
    geolocation: { latitude: 35.68, longitude: 139.69, accuracy: 100 }   # optional
    priority: 0                  # optional tie-breaker (higher wins)
    enabled: true
  - DOMAIN-SUFFIX,yahoo.co.jp,ja-JP   # Clash-style compact form is accepted too
  - MATCH,SYSTEM                       # compact form of the default
default:
  mode: SYSTEM                 # or: mode: PROFILE + locale/languages/…
```

**Matching**
- Case-insensitive, with trailing dots ignored.
- Internationalized domain names work in either form: `例子.测试` and `xn--fsqu00a.xn--0zwm56d` are the same rule.
- `DOMAIN-SUFFIX` matches on DNS label boundaries: `google.com` matches `google.com` and `mail.google.com`, but never `fakegoogle.com` or `google.com.evil.org`.
- Suffix rules never match IP addresses; use `DOMAIN` for those.

**Precedence** (deterministic; the first difference decides)
1. Rule type: `DOMAIN` (exact) › `DOMAIN-SUFFIX` › `DOMAIN-KEYWORD` › `DOMAIN-REGEX` › `GEOSITE` › `IP-CIDR`/`IP-CIDR6` › `IP-ASN` › `GEOIP`. Hostname rules always beat IP rules, because the hostname is always known and the server address may not be.
2. Within a type, the most specific wins: the suffix with the most labels, or the IP range with the longest prefix.
3. Higher `priority` wins.
4. Earlier position in the list wins.
5. The default applies only when nothing matches.

Before all of this come four tiers. **Special** rules are `GEOSITE` and the IP rules (`IP-CIDR`, `IP-CIDR6`, `IP-ASN`, `GEOIP`):

| Tier | Rules |
|---|---|
| 1 | your own rules |
| 2 | rules from [subscriptions](#rule-subscriptions) |
| 3 | your own special rules |
| 4 | special rules from subscriptions |

Between subscriptions, the one higher in the list wins. The order above applies within each tier.

So `DOMAIN,accounts.google.com → SYSTEM` overrides `DOMAIN-SUFFIX,google.com → en-US`, whatever the list order.

### IP and GEO rules

```yaml
rules:
  - DOMAIN-REGEX,^(.+\.)?example\.(com|org)$,fr-FR   # JavaScript regex on the hostname
  - GEOSITE,google,en-US                # category from geosite.dat; @attr filters: apple@cn, geolocation-!cn
  - IP-CIDR,17.0.0.0/8,en-US            # server address in range
  - IP-CIDR6,2400:cb00::/32,en-US
  - IP-CIDR,192.168.0.0/16,SYSTEM,no-resolve   # only when the site is opened by IP address
  - IP-ASN,13335,en-US                  # autonomous system (AS13335 is also accepted)
  - GEOIP,JP,ja-JP                      # server country
  - GEOIP,LAN,SYSTEM                    # private/loopback/link-local, built in
```

- **Server address.** Extensions cannot resolve DNS, and asking a DNS-over-HTTPS service would send every hostname you visit to a third party. So IP rules use the address Chrome actually connected to, taken from `webRequest` and kept in memory for the session only.
  - On the first visit to a host that address is known only once the server answers. If an IP rule then changes the decision, the page is flagged and reloaded once.
  - Later visits are decided before the request is sent.
  - `no-resolve` rules only ever look at hosts that are IP literals.
- **Data sets.** `GEOSITE`, `GEOIP` country rules and `IP-ASN` need data files that are **not downloaded unless you ask**. In *Options ▸ Data sets*, either download them from an editable URL or import a local file. They are stored in the extension's IndexedDB.

  | Data set | Default source | Format |
  |---|---|---|
  | GeoSite | MetaCubeX `geosite.dat` (≈4 MB, via jsDelivr) | v2ray/mihomo `geosite.dat`; Loyalsoldier's also works |
  | GeoIP | MetaCubeX `country-lite.mmdb` (≈0.4 MB) | MaxMind DB, GeoLite2-Country schema; special codes such as `GOOGLE` work when the file has them |
  | ASN | MetaCubeX `GeoLite2-ASN.mmdb` (≈9 MB) | MaxMind DB, GeoLite2-ASN schema |

  GeoLite2 data is © MaxMind (CC BY-SA 4.0), the domain lists come from v2fly/domain-list-community. A rule whose data set is missing simply does not match, and the UI says so. Note that the community GeoIP files (MetaCubeX, Loyalsoldier) give some networks a special code *instead of* their country: 8.8.8.8 is `GOOGLE`, 1.1.1.1 is `CLOUDFLARE`. A `GEOIP,US` rule therefore does not match Google DNS; add `GEOIP,GOOGLE` if you want it to. *Options ▸ Test & verify* shows the code an address gets.
- **Automatic updates (opt-in, off by default).** *Options ▸ Data sets ▸ Automatic updates* re-checks downloaded data sets **when the browser starts** and/or **every day, week or month**. A **minimum gap** (default 24 h, 1–720 h) limits every data set to one automatic attempt per period, failed attempts included, so restarts never trigger repeated downloads. By default only data sets your rules use are checked. Requests are conditional (`If-None-Match` / `If-Modified-Since`), so an unchanged file costs a 304 and is not downloaded again. Imported files are never updated automatically. **Check now** checks every downloaded data set immediately. Results appear on the page and in the activity log.
- **First-request header.** `GEOSITE` domain lists (up to 20,000 domains) are mirrored into declarativeNetRequest for the first request's `Accept-Language`. IP and regex rules apply through the debugger only.

**Accept-Language** is always derived from `languages` the way Chrome does it (`en-US,en;q=0.9`, `…;q=0.8`, and so on). An `acceptLanguage` value given on import must agree with `languages`, or you get a warning.

## How it works (short version)

For every tab that needs a profile, the background service worker:

1. Attaches `chrome.debugger` to the tab and enables two things:
   - a **navigation gate**: `Fetch.enable` for document requests
   - **auto-attach** to cross-site iframes and dedicated workers, which are paused until they are configured
2. Handles each top-level navigation at the gate:
   - **Same profile as now:** the request continues, with `Accept-Language` corrected if needed.
   - **Different profile:** Chrome only delivers emulation commands to the next document after its scripts have started. So the navigation is aborted before anything reaches the server, the new profile is applied, and the navigation is re-issued (Referer kept, one history entry). The new page then starts with the right values.
3. Configures each cross-site iframe or worker before it runs a single script.
4. Mirrors the rules into `declarativeNetRequest` header rules, so even a tab that cannot be debugged yet (for example a URL typed into a New Tab Page) sends the right `Accept-Language` for its first document.
5. Confirms with a document-start probe (in an isolated world the page cannot see) that the page's first scripts saw the right values. If they didn't, the tab is flagged *Reload needed* and, for fresh navigations, reloaded once.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Verify it yourself

- **Options ▸ Test & verify:** pick a tab and compare every API with the expected locale, at document start and now.
- **Local verification page:** run `npm run serve:verify`, then open `http://google.localhost:8787/`, `http://apple.localhost:8787/` or `http://example.localhost:8787/`. All `*.localhost` names resolve to your machine.

  Each page shows:
  - the `Accept-Language` the server received
  - every locale API at document start and after load
  - a dedicated worker
  - a same-site iframe and a cross-site iframe

  Add `?expect=en-US` to highlight mismatches. To try your own rules there, add rules for `google.localhost` and the like.
- **Browser startup:** `http://google.localhost:8787/launch.html?expect=en-US` is meant to be the page Chrome opens at startup (set it as a startup page, or leave it open and restart with *Continue where you left off*). It lists every load of the page in that tab with what its first script saw and the header the server received, so an automatic reload shows as a second row. It also shows the navigation timing.
- **Any real website:** paste [verify/snippet.js](verify/snippet.js) into the DevTools console. It prints the `console.table` from the specification and more.

## Limitations (summary)

These are documented in the extension (*Options ▸ Limitations & privacy*) and in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

- **Restricted pages** are never spoofed: `chrome://`, `edge://`, the New Tab Page, the Chrome Web Store / Edge Add-ons, and anything blocked by policy.
- **Pages that start before debugging is possible.** The first page opened from the New Tab Page starts loading before Chrome allows debugging. Its HTTP header is still correct (DNR), and the page is reloaded once so its scripts see the profile. New tabs opened with a URL, the browser's startup page and a restored tab can also start loading before the extension attaches. If they are still loading, the load is restarted with the profile so the page renders once; if they already loaded, they are reloaded once. Form submissions are never repeated.
- **POST navigations** that change profile cannot be re-issued; they are flagged *Reload needed*.
- **The `Intl` locale is per renderer process.** Two tabs of one site, or one cross-site iframe embedded in two tabs with different profiles, can share a process, and then only one locale can win. Such conflicts are reported as *Partial*, never hidden. While a tab is spoofed, DevTools ▸ Sensors ▸ Locale cannot override it, and vice versa.
- **Service workers and shared workers** are not overridden.
- **Already-loaded pages** (pages restored from the back/forward cache, prerendered pages, and tabs open before a rule changed) keep the values their scripts already read until reloaded. They are re-aligned when shown and flagged.

## Privacy and permissions

Everything runs locally. There is no server, account, telemetry or analytics. The extension makes no network requests of its own, except:
- data-set downloads you start yourself in *Options ▸ Data sets*, and the automatic data-set updates you can turn on there, always from the URL shown there;
- update checks you start or turn on in *Options ▸ Updates*, only to the release address shown there;
- the rule subscriptions you add in *Options ▸ Subscriptions*, to their addresses, plus the data sets their rules need (from the address the subscription names, or the default one). Rules are stored in `chrome.storage.local`. The activity log lives in memory only and contains hostnames, not URLs.

| Permission | Why |
|---|---|
| `debugger` | Chrome's locale and Accept-Language emulation (the core feature) |
| `webNavigation` | Know when a tab navigates, to attach and reconcile in time |
| `declarativeNetRequestWithHostAccess` + `http://*/*`, `https://*/*` | Correct `Accept-Language` on the first document request; host access also lets the popup see the current tab's hostname |
| `storage` | Save your rules |
| `alarms` | Hourly check whether a scheduled data-set update, update check or subscription update is due (each alarm exists only while something uses a regular interval) |
| `webRequest` | Observe only, kept in memory. The server address of page loads, for IP rules (registered only while IP rules exist). The method of top-level page loads (GET or not), so a load that started before the debugger attached is restarted only if repeating it is safe. |

## Development

```sh
npm test            # build + unit tests (rule engine, YAML, import/export, DNR, session lifecycle)
npm run e2e         # build + end-to-end tests in real Chrome (headless), using the verify server
npm run e2e:edge    # the same in Microsoft Edge
node e2e/run.mjs --headful            # watch it run
npm run e2e:launch  # startup test and page-load timing (needs Chromium, see e2e/launch-perf.mjs; add -- --runs 10)
npm run screenshots # UI screenshots into e2e/artifacts/ (add -- --ui=ja etc. for another language)
npm run typecheck
```

The end-to-end suite starts the browser with `--lang=zh-CN`, loads `dist/` through the DevTools protocol (`Extensions.loadUnpacked`), and drives pages on `*.localhost` hostnames. It asserts what the page's **first script** observed, which headers the server received, and what frames and workers saw.

```text
src/shared/      rule engine, domain/IDN handling, locale profiles, YAML, import/export, DNR compiler
src/background/  service worker: per-tab debugger sessions, navigation gate, overrides, probe
src/popup/       toolbar popup
src/options/     options page and rule editor
src/ui/          small DOM helpers shared by the pages
static/          manifest, HTML/CSS, icons
test/            unit tests (node:test)
e2e/             real-browser tests and screenshot script (dependency-free CDP client)
verify/          local verification server, pages and console snippet
research/        probe extension + scripts behind research/FINDINGS.md
```

Troubleshooting: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## License

GPL-3.0. See [LICENSE](LICENSE).
