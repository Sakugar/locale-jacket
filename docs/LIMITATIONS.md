# Known limitations

Everything below was observed in Chrome 155 / Edge 155 on Windows 11 (see `research/FINDINGS.md`). Where something cannot be guaranteed, the extension reports it in the popup and in *Options ▸ Sessions & log* rather than claiming success.

## Chrome restrictions

- **The debugging banner.** Any `chrome.debugger` session makes Chrome show "… started debugging this browser". This is a deliberate security signal and is not suppressed. Clicking *Cancel* detaches every session, and Locale Jacket then stays paused until you resume it.
- **Restricted pages.** These cannot be debugged, and so cannot be spoofed:
  - `chrome://`, `edge://`, `chrome-extension://` (other extensions)
  - the New Tab Page
  - the Chrome Web Store and Edge Add-ons
  - hosts blocked by enterprise policy
  - pages embedding another extension's frame, which Chrome refuses with "Cannot access a chrome-extension:// URL of different extension"
- **Policies.** Enterprise policies that restrict developer tools or block extensions on certain hosts can prevent attaching (not tested here); such tabs show *Error* or *Not allowed*.

## Timing

- **First navigation from the New Tab Page** (or any restricted page). Chrome allows attaching only once the new page has committed, so its first scripts see the real locale.
  - The document's `Accept-Language` is still correct, through declarativeNetRequest.
  - With *Reload once if the profile arrived late* on (the default), the page is reloaded once.
- **Loads that start before the debugger can attach.** These pages start loading before the extension can attach (at browser start, before its service worker is even running):
  - new tabs opened with a URL (Ctrl+click, `window.open`, `target="_blank"` links)
  - the browser's startup page
  - the restored active tab

  How the extension catches up depends on whether the page is still loading:
  - **Still loading when it attaches** (the usual case for real sites): it stops the load, applies the profile, and loads the page again through the gate. The page renders once, already spoofed; the server sees the request twice. This is done only for loads known to be GET (seen by `webRequest`), or, with the method unknown, the browser's own loads within 10 s of it or the extension starting. A form POST is never restarted.
  - **Already loaded** (very fast servers): its first scripts saw the real locale. A page that began less than 10 seconds before the extension attached is reloaded once; older pages are only flagged *Reload needed*.
  - Both belong to *Reload once if the profile arrived late* (on by default) and happen at most once per URL.
  - Measured with `npm run e2e:launch` (Chromium 153, headless, local server answering in 300 ms), the page rendered once, already spoofed, in:
    - 10 of 10 new tabs in a running browser (about 70 ms slower than with no extension)
    - 5 of 5 tabs that had to wake the stopped service worker
    - 5 of 5 restored tabs
    - 4 of 5 startup pages; the fifth was reloaded once (about 450 ms slower than with no extension, because the server is asked twice)

    With the server answering in about 2 ms, the page has usually loaded before the extension attaches and is reloaded once instead. Every final page was correct in every run.
  - The test can only load the extension with `--load-extension`, which installs it afresh on every start. An installed extension also has its header rules and event listeners already registered at startup, so the first request's `Accept-Language` is expected to be right there; this was not measured.
- **POST navigations** (form submissions) that change the profile cannot be aborted and re-issued without losing the body. They continue and are flagged *Reload needed*; they are never auto-reloaded.
- **Navigations the gate cannot see.** The extension re-aligns these when they are shown and flags them if their scripts started with other values:
  - documents served by a service worker without a network request
  - back/forward cache restores
  - prerender activations
- **Live changes.** Changing a rule or the default re-applies immediately to open tabs, but scripts that already ran keep what they read. After *clearing* an override on a live page, `navigator.languages` may keep the old list until the next load. Reload to be exact.
- **Re-issued navigations.** Back/forward is re-issued as the same history traversal, and reloads as a reload. Other navigations keep their Referer and referrer policy and add exactly one history entry (verified). A `location.replace()` that changes profile cannot be told apart from a link and becomes a normal navigation, adding a history entry instead of replacing one. Navigation API listeners on the old page see the aborted navigation.

## Process model

- **One `Intl` locale and time zone per renderer process.** Chrome's locale override is process-wide. If two tabs (or two cross-site frames) with different profiles end up in one renderer process, only the first override wins, and the other session's command fails with "Another locale override is already in effect". This happens with same-site popups (OAuth windows), same-site tabs under process pressure, and the same embedded site (for example a video player) in two tabs. The tab shows *Partial*, and the verify view shows the actual values.
- **DevTools ▸ Sensors ▸ Locale** competes for the same process-wide override. While a tab is spoofed, DevTools cannot set a locale there, and vice versa. Other DevTools features coexist with the extension.
- **Same-site frames** always share the page's locale, even in per-frame mode.

## IP and GEO rules

- **No DNS lookups.** IP rules (`IP-CIDR`, `IP-CIDR6`, `IP-ASN`, `GEOIP`) use the address Chrome connected to, learned from `webRequest` per hostname and kept in memory for the session.
  - The first visit to a host is decided without it. If an IP rule then applies, the page is flagged and reloaded once (if that option is on); later visits are gated correctly.
  - Hosts behind CDNs or DNS load balancing can change address between visits, so a decision can change too.
  - The address cache is cleared when the browser or the service worker restarts.
- **Data sets are snapshots.** `GEOSITE`, `GEOIP` country and `IP-ASN` rules only match with an installed data set, and only as current as the file. Update them from *Options ▸ Data sets*, or turn on automatic updates there (browser start and/or a daily, weekly or monthly interval, with a minimum gap between attempts). Imported files are not updated automatically.
  - GeoSite regex entries use RE2 syntax; the few that JavaScript cannot compile are skipped and counted.
- **Regex rules are screened for slow matching.** `DOMAIN-REGEX` rules and GeoSite `regexp:` entries are refused (or, from subscriptions and data sets, skipped) when the extension cannot prove they finish quickly on any hostname: unknown syntax, back-references, repeated groups that can match the same text in more than one way, or a worked-out bound on the matching work above its budget. The check is conservative, so a pattern that is in fact fast can be refused; a form like `^([a-z0-9-]+\.)*example\.com$` or a `DOMAIN-SUFFIX` rule works instead. One entry of the default GeoSite data is refused.
- **First-request header.** `GEOSITE` lists larger than 20,000 domains, regex rules and IP rules are not mirrored into declarativeNetRequest; they apply through the debugger session. When IP rules exist, a spoofing default action is not mirrored either, because an IP rule might override it.

## Coverage gaps

- **Service workers and shared workers** are not overridden. Their `Intl` follows whichever process hosts them, and their `navigator.language` and requests use the real locale.
- **Non-ASCII DOMAIN-KEYWORD rules** cannot be mirrored into declarativeNetRequest (URLs use punycode there). They still work through the debugger, but the very first document request of an undebuggable tab keeps the real header.
- **Accept-Language format.** The header is always Chrome's own format, derived from `languages` (`en-US,en;q=0.9`). Arbitrary custom header strings are not supported, because they would disagree with `navigator.languages`.
- **Fingerprinting.** Locale Jacket aligns locale signals. It does not hide that a debugger is attached from a determined anti-bot script, and it does not change the User-Agent, fonts, time zone (unless enabled), or other fingerprint surfaces.
