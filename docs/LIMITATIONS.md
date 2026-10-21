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
  - Tabs opened directly with a URL (Ctrl+click, `window.open`) can hit the same race and are handled the same way.
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
- **First-request header.** `GEOSITE` lists larger than 20,000 domains, regex rules and IP rules are not mirrored into declarativeNetRequest; they apply through the debugger session. When IP rules exist, a spoofing default action is not mirrored either, because an IP rule might override it.

## Coverage gaps

- **Service workers and shared workers** are not overridden. Their `Intl` follows whichever process hosts them, and their `navigator.language` and requests use the real locale.
- **Non-ASCII DOMAIN-KEYWORD rules** cannot be mirrored into declarativeNetRequest (URLs use punycode there). They still work through the debugger, but the very first document request of an undebuggable tab keeps the real header.
- **Accept-Language format.** The header is always Chrome's own format, derived from `languages` (`en-US,en;q=0.9`). Arbitrary custom header strings are not supported, because they would disagree with `navigator.languages`.
- **Fingerprinting.** Locale Jacket aligns locale signals. It does not hide that a debugger is attached from a determined anti-bot script, and it does not change the User-Agent, fonts, time zone (unless enabled), or other fingerprint surfaces.
