# Development backlog

Open issues found up to the 1.3.3 release (2026-10-24), from the performance run, the review that followed it, and the release itself. Items S1–S5 were found by the stress suite (`npm run e2e:stress`, 2026-10-25), and its failing tests reproduce them. Fixed items are in `CHANGELOG.md`. Limitations that users should know about are in [LIMITATIONS.md](LIMITATIONS.md). This file is for developers.

Priority: **P1** fix next, **P2** worth doing, **P3** only if cheap or someone asks.

| # | Issue | Area | Priority |
|---|---|---|---|
| S1 | Closed tabs come back as tracked "failed" sessions | `src/background/manager.ts` | P1 |
| S2 | A navigation that never commits (204) leaves the other site's profile on the page | `src/background/tab-session.ts` | P1 |
| S3 | SYSTEM popup in a spoofed process gets its Intl locale, and nothing reports it | `src/background/tab-session.ts` | P2 |
| S4 | Nested dedicated workers keep the real `navigator.language` | `src/background/tab-session.ts` | P2 |
| S5 | Refused stored regexes are named by position, not by pattern | `src/shared/config-io.ts` | P3 |
| 1 | GeoSite `cn` category blocks the worker for about 130 ms | `src/shared/geosite.ts` | P2 |
| 2 | Options-page import has no whole-file regex budget | `src/shared/config-io.ts`, `src/options/options.ts` | P2 |
| 3 | 20 large subscriptions can exceed the `storage.local` quota | `src/shared/subscriptions.ts`, `src/background/sw.ts` | P2 |
| 4 | Timing-based unit tests may flake on a slow machine | `test/perf.test.ts` | P2 |
| 5 | Browser timings not re-measured after the perf fixes | `e2e/launch-perf.mjs` | P2 |
| 6 | Corrupt mmdb records found at runtime aren't shown | `src/background/datasets.ts` | P3 |
| 7 | Options keeps saying a deleted data set "was downloaded for subscription X" | `src/options/options.ts` | P3 |
| 8 | First-request header missing for subscription GEOSITE rules below an IP rule | `src/shared/dnr.ts` | P3 |
| 9 | Validation messages, activity log and fetch errors are English-only | `src/shared/config-io.ts`, `src/shared/i18n/*` | P3 |
| 10 | The regex check refuses some harmless patterns | `src/shared/regex-safety.ts` | P3 |
| 11 | Locale switch between sites in one tab costs about 80 ms | `src/background/tab-session.ts` | P3 |
| 12 | Edge reloads a spoofed page in a new tab once, most of the time | `src/background/tab-session.ts` | P3 |
| D1 | Data sets download from jsDelivr by default for subscriptions | product decision | ask user |
| D2 | Subscription and data-set URLs may be plain `http://` | product decision | ask user |
| T1 | Chrome DevTools MCP can't load the extension | dev tooling | — |
| T2 | Windows `git.exe` sometimes can't reach github.com | dev tooling | — |

## Found by the stress suite

Each item has a failing test in `e2e/stress.mjs`. It failed the same way in Chrome 156 and Edge 156, on every run. S1–S3 were also reproduced by hand in Linux Chrome 156 with the Playwright MCP, looking at the popup and the options page (see "Checking the UI with the Playwright MCP" below).

### S1. Closed tabs come back as tracked "failed" sessions (P1)

- **What:** close a tab while the extension is still attaching (slow server, closed 0–400 ms after opening). 3–4 of 10 such tabs stay in `localeJacket.statuses()` forever, with session `failed` and no host. They are never cleaned up. Each one is a small leak, and the options page's Sessions view lists tabs that no longer exist.
- **Where:** `SessionManager.session()` (`src/background/manager.ts`) creates a `TabSession` for any tab id it doesn't know. An event that arrives after `chrome.tabs.onRemoved` (`webNavigation`, `tabs.onUpdated`, a late debugger result) therefore re-creates a session for a closed tab.
- **Fix:** remember removed tab ids (Chrome doesn't reuse them within a browser session). `session()` should not create entries for those ids, and late events for them should be ignored.
- **In the UI:** nothing is visible, because the options page's Sessions table filters by open tabs. The ghosts only show in `localeJacket.statuses()`, each with the error "No tab with given id …", and they pile up (8 after 20 closed tabs). They only appear when the tab is created with its URL (Ctrl+click, `target="_blank"`, `Target.createTarget`). Opening about:blank and then navigating didn't leak.
- **Test:** "tab closed while the extension is attaching".

### S2. A navigation that never commits leaves the other site's profile on the page (P1)

- **What:** on a page that should be en-US, start a navigation to a ja-JP site that answers `204 No Content`. The gate applies ja-JP for that navigation, but the 204 never commits, so the old en-US page stays and keeps reporting ja-JP (`navigator.language`, every `Intl` constructor). The same probably happens with downloads and any other navigation that doesn't commit.
- **Where:** `onNavigationError()` in `src/background/tab-session.ts` restores the committed page's profile, but Chrome doesn't fire `webNavigation.onErrorOccurred` for a 204.
- **Fix:** after an abort-and-reissue, if no commit follows (watch `Page.frameStoppedLoading` or the re-issued request's response status, or use a timeout), re-apply the profile of the URL that is actually committed.
- **The popup makes it worse:** the tab's status knows ja-JP is applied (`applied.locale`), but the popup's badge says **"Active · de-DE … Applied from the start of the page"**, taken from the rule, with no warning. Its "Check what the page sees" grades backwards: it compares against the stale target profile (ja-JP), so "At start: de-DE" shows red and "Now: ja-JP" shows green.
- **Seen once, not reproduced in 2 more tries:** the extension re-applied de-DE in its session, but the page's main world kept ja-JP, and the check (a fresh isolated world) showed de-DE. In that state the check disagrees with the page.
- **A reload fixes the page.**
- **Test:** "204 No Content, a network error page and a 404 in between…". It also compares the popup's check with the page (`checkDisagrees`).

### S3. SYSTEM popup in a spoofed process gets its Intl locale, and nothing reports it (P2)

- **What:** an en-US page (`mail.google.localhost`) opens a same-site popup to a SYSTEM site (`accounts.google.localhost`), the OAuth pattern. The popup shares the opener's renderer, so its `Intl` reports en-US instead of the native locale. `navigator.language` and the header are correct. The tab's status is session `none` with no warnings, so the popup shows nothing wrong. `LIMITATIONS.md` says such tabs show *Partial*, and the project's rule is that conflicts are reported, never hidden.
- **Same case with a profile:** with another profile (fr-FR popup in an en-US process), the conflict *is* reported ("Page scripts started with fr-FR / en-US instead of fr-FR").
- **Fix:** for a SYSTEM tab whose opener is spoofed and same-site, check `Intl` once (e.g. through `chrome.scripting`, or a short debugger attach) and show it as *Partial*. Or keep a session on SYSTEM tabs opened by a spoofed same-site page.
- **In the UI:** the popup's badge says "System locale" and "No spoofing on this site; the browser's own locale is used." "Check what the page sees" shows `navigator.language` zh-CN next to `Intl.*` de-DE, but marks nothing, since a SYSTEM tab has no expected locale to compare with.
- **Test:** "same-site popup to a SYSTEM site (accounts.google)…".

### S4. Nested dedicated workers keep the real `navigator.language` (P2)

- **What:** a dedicated worker started *by another worker* reports the native `navigator.language` and `navigator.languages` (zh-CN). Its `Intl` is right, because that is per process. Workers started by the page itself, including blob: and data: workers, are correct. This isn't in `LIMITATIONS.md`.
- **Where:** worker overrides are applied to targets auto-attached from the page. A worker's own child workers need auto-attach set on the worker's session too.
- **Fix:** call `Target.setAutoAttach` (with `waitForDebuggerOnStart`) on each worker session as well, and apply the same overrides. Document the gap if that isn't possible.
- **Test:** "same-process contexts follow the page…" (`nestedWorker`).

### S5. Refused stored regexes are named by position, not by pattern (P3)

- **What:** stored DOMAIN-REGEX rules that the check refuses are listed as "Stored rule #12 was invalid and has been skipped: …". The message doesn't show the pattern, so with many rules it's hard to find the right one.
- **Fix:** include the rule's type and value in the message (trimmed when long), as `regexProblems` in `sw.ts` already does for deferred checks.

## Checking the UI with the Playwright MCP

The stress suite reads what the page sees. The popup and the options page need a person, or the Playwright MCP:
- **The MCP's own browser can't run the extension.** Playwright launches Chrome with `--disable-extensions`, so `Extensions.loadUnpacked` returns an id but no worker starts, and `chrome-extension://` pages are blocked (`ERR_BLOCKED_BY_CLIENT`).
- **Workaround, no config change:** in `browser_run_code_unsafe`, start a second Chrome with `page.context().browser().browserType().launchPersistentContext(dir, { channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--lang=zh-CN'] })`, then `Extensions.loadUnpacked` through `ctx.browser().newBrowserCDPSession()`.
- **Each tool call runs in a fresh scope.** Keep handles on the persistent `page` object (`page.__lj = { ctx }`), not `globalThis`.
- **First navigation fails in Playwright:** `page.goto` to a spoofed site fails with `ERR_ABORTED`, because of the extension's abort-and-reissue. Catch it and wait for the page.
- **Clean up:** close the second Chrome (`ctx.close()`), the MCP browser and the verify server afterwards, and delete the profile.

## Code issues

### 1. GeoSite `cn` category blocks the worker for about 130 ms (P2)

- **What:** `loadGeositeCategory(index, 'cn')` runs synchronously in the service worker and takes about 130 ms (measured 2026-10-24). Navigation events that arrive during that time wait.
- **Where:** `src/shared/geosite.ts:115`, called when a GEOSITE rule needs a category for the first time in a worker's life.
- **Ideas:**
  - Load the category in slices, the way `precompileRegexes` checks stored regexes between events.
  - Or build the category's lookup structure once and store it in IndexedDB next to the data set, so a worker wake only reads it.
  - Keep the regex batch budget (`GEOSITE_REGEX_BUDGET_MS`) charged exactly as now.

### 2. Options-page import has no whole-file regex budget (P2)

- **What:** `importConfigText` checks each regex with the per-pattern limit (`MAX_ANALYSIS`, about 0.6 ms) but has no batch budget, unlike subscription parsing and settings loading (`REGEX_BATCH_BUDGET_MS` = 750 ms). A very large hostile import can freeze the options page for seconds. Only the options page is affected, not the worker or browsing.
- **Where:** `src/shared/config-io.ts:58`. Callers: `src/options/options.ts:511` (paste/import) and `src/background/sw.ts:106` (preset).
- **Fix:** pass an `analysisBudget(...)` through the import, as `parseSubscription` does. Decide what happens to rules past the budget. They can't simply be dropped from your own rules (see invariant "your own rules are never deleted by a budget" in `handoff.md`), so either refuse the import with a clear message or keep them unchecked with `defer` and list them as problems.

### 3. 20 large subscriptions can exceed the `storage.local` quota (P2)

- **What:** subscription data is stored verbatim: each rule repeats its profile, id and origin. At the limits (20 subscriptions × 5,000 rules × 2 MB files) this can pass the 10 MB `storage.local` quota. Since 1.3.3 the write failure is shown and the old rules are kept, so nothing breaks silently, but the update is lost.
- **Where:** `subscriptionData` in `storage.local`, written only by the SW (`src/shared/subscriptions.ts`, `src/background/sw.ts`).
- **Fix:** a compact storage form: store each distinct profile once and refer to it by index, and rebuild ids (`<subId>:<index>`) and `origin` on load instead of storing them. `options.ts` reads this data too and needs the same change. Bump the stored format and migrate on load.

### 4. Timing-based unit tests may flake on a slow machine (P2)

- **What:** `test/perf.test.ts` asserts time ceilings. They are at least 10× the measured numbers, but a slow or busy CI machine could still fail them.
- **Fix options:** count work instead of time where the code already has a counter (the regex check's `work()` units), or skip the timing assertions unless an env var like `LJ_PERF=1` is set and run them in a separate script.

### 5. Browser timings not re-measured after the perf fixes (P2)

- **What:** the real-browser numbers in `handoff.md` (Performance) were taken before the 1.3.3 speed-ups. The fixes cut worker CPU per navigation (rule matching 4.3 ms → 0.009 ms with 5,000 rules), but page-load times weren't measured again.
- **Do:** run `npm run e2e:launch -- --runs 10` and a 5,000-rule CPU-per-navigation run, then update `handoff.md`. Expect worker CPU per navigation near the 4-rule figure (3.4 ms) instead of 17 ms.

### 6. Corrupt mmdb records found at runtime aren't shown (P3)

- **What:** a corrupt GeoIP/ASN record found during a lookup counts as no match, but the user never learns why an IP rule doesn't match.
- **Fix:** surface `lookup(...).error` in `src/background/datasets.ts` (once per data set, not per lookup) and show it on the options page's data page.

### 7. Deleted data set still says "was downloaded for subscription X" (P3)

- **What:** after a data set is deleted, the options page still shows that it was downloaded for a subscription.
- **Fix:** clear the "downloaded for" record when the data set is deleted, or derive the text from what is stored.

### 8. First-request header missing for subscription GEOSITE rules below an IP rule (P3)

- **What:** DNR stops mirroring rules below the first IP rule in precedence order, because DNR can't see server addresses. So when one of your IP rules ranks above a subscription's GEOSITE rules, those GEOSITE sites don't get the right `Accept-Language` on their first request. The debugger still applies the rule after that.
- **Where:** `src/shared/dnr.ts`.
- **Idea:** mirror the GEOSITE rules for hosts that no IP rule above them could match. This is only safe where that can be proven, so it may not be worth it.

### 9. Some messages are English-only (P3)

- **What:** input-validation messages, the activity log and fetch error strings (shown in `{error}` placeholders) are English in all 10 UI languages.
- **Fix:** move validation messages to i18n keys with parameters. All 10 languages are needed, and `test/i18n.test.ts` checks placeholder parity. Fetch errors come from the browser and can stay as they are, wrapped in a translated sentence.

### 10. The regex check refuses some harmless patterns (P3)

- **What:** the check is deliberately conservative. Known refusals: `.*.*!`, 73 `(?:a|b)` in a row, and an unanchored label loop with three capture groups. Against the default GeoSite data only 1 of 163 patterns is refused, and that one really is exponential.
- **Only change this with care:** keep `test/regex-safety.test.ts` (SAFE/UNSAFE lists and seeded fuzz) green, charge every new analysis loop to `work()`, and bump `REGEX_CHECK_VERSION` if acceptance changes.

### 11. Locale switch between sites in one tab costs about 80 ms (P3)

- **What:** going to a site with a different profile in the same tab costs about 80 ms: about 22 ms for abort and re-issue, about 55 ms for a new renderer process.
- **Why it stays:** the `Intl` locale is per renderer process, so a new renderer is part of how switching works (see `research/FINDINGS.md`). Only the 22 ms is ours to shave.

### 12. Edge reloads a spoofed page in a new tab once (P3)

- **What:** in Edge, a spoofed site opened in a new tab shows a visible reload about 85% of the time; Chrome usually gets the profile in before the load. Documented in `LIMITATIONS.md` (Timing).
- **Why it stays:** the load starts before the debugger can attach. The restart-in-flight and reload-once paths in `tab-session.ts` are the fallback. Any change there must keep the invariants in `handoff.md` (never restart a POST, at most one reload per URL).

## Product decisions to ask the user about

- **D1. jsDelivr downloads by default.** `subscriptionDatasets` (`src/shared/types.ts:133`) is on by default, so adding a subscription with GEOSITE/GEOIP rules downloads data sets from jsDelivr. It's documented, and adding the subscription counts as the opt-in, but it's still a network request the user didn't make directly.
- **D2. Plain `http://` URLs.** Subscription and data-set URLs may use `http://` (`src/shared/subscriptions.ts:144`), and redirects are followed. Options: require `https://`, or warn on `http://`.

## Dev tooling

### T1. Chrome DevTools MCP can't load the extension

- **What:** `chrome-devtools-mcp` 1.12.0 starts Chrome with `--disable-extensions`, refuses to open `chrome://extensions` and `chrome-extension://` pages, and leaves out its install tools. So a subagent can't load `dist/` or open the popup through it. The planned Chrome MCP retest wasn't run; the e2e suite (34/34 in Chrome 156 and Edge 156) is the real-browser coverage for 1.3.3.
- **Fix (user-level Claude config, the user's call):**
  ```sh
  claude mcp remove chrome-devtools -s user && claude mcp add chrome-devtools -s user -- npx -y chrome-devtools-mcp@1.12.0 --categoryExtensions=true --chromeArg=--lang=zh-CN
  ```
  The pinned version also avoids the 30-second startup timeout seen with `@latest`.
- **When testing:** that Chrome's native locale is `en-US`, the same as the default spoof. Test with other locales (for example ja-JP and fr-FR) or start it with `--lang=zh-CN`, otherwise a working spoof and no spoof look the same.

### T2. Windows `git.exe` sometimes can't reach github.com

- **What:** on 2026-10-24 `git.exe push` timed out on github.com:443 while WSL could reach GitHub. The 1.3.3 push was done from WSL git using gh's login for that one command (in `handoff.md`, Gotchas).
- **Check:** the Windows proxy or VPN settings if it happens again.
