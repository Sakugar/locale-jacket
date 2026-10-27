# Development backlog

Open issues, and the history of fixed ones. Items S1–S8 were found by the stress suite (`npm run e2e:stress`, from 2026-10-25), and its tests reproduce them. S1–S7 and code issues 1, 2, 3, 4, 6 and 7 were fixed in 1.4.0. Since 1.4.0 (unreleased): S8 turned out to be Edge's own behaviour plus the test's timing (test fixed), 5 is done (browser numbers re-measured), and 13 is fixed. Fixed items are in `CHANGELOG.md`. Limitations that users should know about are in [LIMITATIONS.md](LIMITATIONS.md). This file is for developers.

Priority: **P1** fix next, **P2** worth doing, **P3** only if cheap or someone asks.

| # | Issue | Area | Priority |
|---|---|---|---|
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

### S1. Closed tabs come back as tracked "failed" sessions (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `SessionManager` remembers removed tab ids (up to 1,000; Chrome doesn't reuse them within a browser session), and `session()` no longer creates entries for them. Covered by the unit test "events that arrive after a tab closed…" and the stress test "tab closed while the extension is attaching".

### S2. A navigation that never commits leaves the other site's profile on the page (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `onNavigationError` now ignores only the one error event each self-made abort causes, and only for the re-issued URL. The popup's check grades the page by the rule for the loaded document. The stress test "204 No Content…" covers both, including the popup's check.

### S3. SYSTEM popup in a spoofed process gets its Intl locale, and nothing reports it (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. When a SYSTEM page commits with no session and another tab spoofs a page or cross-site frame whose `roughSite` (last two labels; a hint, never proof) matches, `TabSession.checkSharedProcess` reads the main document's `navigator.language` and `Intl` locale once through `chrome.scripting` (isolated world, no debugger) and adds a warning if `Intl` is not native, so the popup shows *Partial*. The result counts only for the document it was read from (`documentSeq`, URL check). A SYSTEM page whose start probe shows native `navigator.language` but another `Intl` is reported the same way instead of as a late profile. Not covered: a spoofed same-site page that joins the process after the SYSTEM page was checked (see `LIMITATIONS.md`). Unit test "a SYSTEM page sharing a spoofed same-site process…"; stress test "same-site popup to a SYSTEM site…" now passes as a reported limitation.

### S4. Nested dedicated workers keep the real `navigator.language` (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `Target.setAutoAttach` is now sent on every child session (iframes and workers), so workers started by workers arrive paused and get the overrides before they run. Detaching a child also drops its descendants, and a frame's profile change re-applies to all its workers, nested ones included. Unit tests in "child targets"; stress test "same-process contexts…" (`nestedWorker`) passes in Chrome and Edge.

### S6. A profile switch sometimes adds an extra history entry (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. Cause: the restart-in-flight path (`Page.stopLoading` → apply → `Page.navigate`) assumed Chrome turns a navigation to the URL the stopped load committed into a replacement. It does not: a load that was already committing still commits (its commit can arrive before `Page.stopLoading` answers), and the `Page.navigate` then added a second entry for the same page. The restart now checks `Page.getNavigationHistory` and sends `Page.reload` when the current entry is already that URL. Ping-pong passed 13 of 13 runs in Chrome 156 after the fix (before: about 1 in 5 failed). Unit test "a stopped load that had already committed is reloaded…".

### S7. The popup can briefly show the previous page's check under the new host (fixed in 1.4.0, Edge)

- **What:** e2e "popup keeps its controls…" failed in Edge 156 about 2 times in 3: right after navigating, the popup showed the new host with the previous page's en-US check.
- **Fix (1.4.0):** `runVerify()` in `src/popup/popup.ts` accepts a result only when its main frame's `location.href` is on the host the popup shows. Otherwise it reads again, every 300 ms and at most 20 times per navigation. A check could start while `tab.url` already pointed to the next page but the tab still showed the old document.
- **Result:** 32 of 34 Edge runs passed (before: 2 of 6). The two failures came before the test recorded diagnostics; the 28 runs since then all passed. If it fails again, the error shows the table, the page's real host and values, and the tab's status at that moment. That tells whether the result was stale or the new page really reported en-US for a moment.
- **Closed 2026-10-27:** 15 of 15 more Edge 156 runs of the test passed (`node e2e/run.mjs --edge --only "popup keeps its controls"`), 43 in a row since the diagnostics were added, plus the full e2e suite in Edge.

### S8. Edge: a crashed tab's reload sometimes never commits (fixed in the test, unreleased; not an extension bug)

- **Cause:** `Page.crash` doesn't kill an Edge renderer at once. Edge 156 reports `Target.targetCrashed` 1.2–1.8 s after the first crash in a browser and about 0.7 s after later ones (Chrome: about 0.1 s). The test reloaded after a fixed 1.5 s. When the crash wasn't reported yet, the reload committed into the dying renderer and was lost with it, which left a sad tab nothing reloaded.
- **Evidence** (`research/crash-reload.mjs`, fresh Edge 156 per launch):
  - With no extension, a reload 1 s after the crash was lost on the first crash in 10 of 10 launches.
  - With the reload at 1.5 s: 2 of 13 lost without the extension, 3 of 12 with it. Every lost reload was sent before the crash was reported.
  - Reloading after `Target.targetCrashed`: 20 of 20 loaded and were spoofed.
- **Rarer:** now and then Edge reports the crash only after 20–30 s, and every reload until then is lost, with or without the extension. The trigger isn't known (seen in 6 of 22 runs in one sitting, 0 of 29 later).
- **Fix:** the stress test waits for `Target.targetCrashed` before it reloads (a user can only press the sad tab's *Reload* then), with a 45 s timeout. Edge passed the crash subset in 25 of 25 runs, and the full stress suite 24/24 in Chrome and Edge.
- **Checked in the extension, nothing needed:** overrides survive the crash (the reloaded page is ja-JP at document start), and child sessions are dropped on `Target.detachedFromTarget` and come back after the reload. Minor, left alone: a command sent to the dying renderer waits for the 10 s command timeout, which holds up that tab's queue (the Fetch gate isn't queued, so pages are still spoofed).

### S5. Refused stored regexes are named by position, not by pattern (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `sanitizeStoredSettings` now writes "Stored rule #12 (DOMAIN-REGEX,<value>) was invalid and has been skipped: …", with the value cut to 80 characters, and without the one-rule import's `rules[0]: ` prefix. Covered by the unit test "names a skipped stored rule by its type and value…".

## Checking the UI with the Playwright MCP

The stress suite reads what the page sees. The popup and the options page need a person, or the Playwright MCP:
- **The MCP's own browser can't run the extension.** Playwright launches Chrome with `--disable-extensions`, so `Extensions.loadUnpacked` returns an id but no worker starts, and `chrome-extension://` pages are blocked (`ERR_BLOCKED_BY_CLIENT`).
- **Workaround, no config change:** in `browser_run_code_unsafe`, start a second Chrome with `page.context().browser().browserType().launchPersistentContext(dir, { channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'], args: ['--enable-unsafe-extension-debugging', '--lang=zh-CN'] })`, then `Extensions.loadUnpacked` through `ctx.browser().newBrowserCDPSession()`.
- **Each tool call runs in a fresh scope.** Keep handles on the persistent `page` object (`page.__lj = { ctx }`), not `globalThis`.
- **First navigation fails in Playwright:** `page.goto` to a spoofed site fails with `ERR_ABORTED`, because of the extension's abort-and-reissue. Catch it and wait for the page.
- **Clean up:** close the second Chrome (`ctx.close()`), the MCP browser and the verify server afterwards, and delete the profile.

## Code issues

### 1. GeoSite `cn` category blocks the worker for about 130 ms (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. Measured first: almost all of the time went into decoding ~110,000 entries into one string each (`TextDecoder` per entry, `toLowerCase`, a regex for leading dots) and hashing them into a `Set`; walking the protobuf is ~6 ms. `loadGeositeCategory` now keeps the `domain:`/`full:` entries as byte ranges of the data set in a `DomainTable` (an open-addressing hash index over the ASCII-lowercased bytes, reused readers, no per-entry strings or objects). It behaves like the `Set` it replaces (same members, order and size; non-ASCII entries are still decoded and lowercased as strings), checked against the old code on every category of the MetaCubeX file (with and without `@cn`, `@!cn`, `@ads`, `@!ads`; 7,810 loads, 0 differences). Data sets are untrusted, so the hash is seeded per table, and a file crafted to collide makes the table fall back to a plain `Set` after a probe budget (8 per entry), so it costs at most what it did before. `regexp:` entries are decoded and charged to `GEOSITE_REGEX_BUDGET_MS` exactly as before. The DNR compiler also listed every domain of a category before seeing it was over the 20,000 limit; it now counts first (`plainDomainCount`).

Cold, first call in a fresh process (Node 24, Windows; MetaCubeX `geosite.dat`, medians of 11): `cn` 98 → 34 ms, `geolocation-!cn` 42 → 29 ms (most of the rest is the check of its 151 regexes), `google` 2.3 → 0.8 ms; DNR compile for a `GEOSITE,cn` rule ~22 → 0.8 ms; memory held by `cn` 6.1 → 2.1 MB. Not re-measured in the browser.

The load is still synchronous: the navigation that wakes the worker needs the category to pick its profile, so slicing it (or counting it as no match while it loads) would give that page the wrong locale.

### 2. Options-page import has no whole-file regex budget (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `importConfigText` gives the whole file one `analysisBudget(REGEX_BATCH_BUDGET_MS)` with `defer`, like `sanitizeStoredSettings`. Patterns past the budget are kept unchecked rather than refusing the import, so a backup that the worker's settings load only partly checked can still be restored. They are counted in `ImportResult.unchecked` (the options page's confirmation says how many), named in the first warning, and never run until checked: the options page's matcher checks them itself, and the worker checks them in slices and lists the refused ones as settings problems. The first-run preset (`sw.ts`) uses the same path, so it always loads. 8,000 patterns that are hard to check: about 6 s before, about 0.75 s now. Covered by the "import regex budget" unit tests.

### 3. 20 large subscriptions can exceed the `storage.local` quota (fixed in 1.4.0)

Fixed: see `CHANGELOG.md` [1.4.0]. `subscriptionData` is stored in a compact form (format 2): each entry's rule types and profiles are stored once and rules refer to them by index; ids (`<subId>:<index>`) and `origin` are rebuilt on load. `encodeSubscriptionData` / `decodeSubscriptionData` in `src/shared/subscriptions.ts` are the only code that knows the format (used by `sw.ts`, `options.ts` and the e2e helper). Data saved by 1.3.3 or older is read as before (the `regexCheck` marker and fetch times are kept, so nothing is refetched because of it) and written back in the new form when the worker loads it. At the limits (20 × 5,000 rules) the stored size is 2.9 MB for typical lists (was 32 MB) and 4.6 MB with 50-character host names (was 34 MB); besides the rules' own text, a rule costs about 8 bytes. Still possible to pass the quota: rules whose text alone is near 10 MB (e.g. 80-character names and a note on every rule: 10.1 MB), or a different profile on nearly every rule (about 19 MB). The existing quota error then keeps the old rules. Covered by the unit tests "stored form of subscription data".

### 4. Timing-based unit tests may flake on a slow machine (fixed in 1.4.0)

- **What:** `test/perf.test.ts` asserted time ceilings. They are at least 10× the measured numbers, but a slow or busy CI machine could still fail them.
- **Fixed:** the hostile stored-regex test asserts on work: what one check of such a pattern charges to an `analysisBudget`, that the first navigation checks no more patterns than `NAVIGATION_REGEX_BUDGET_MS` worth of units (it resets the navigation budget first), and that the second checks none. The other ceilings (resolveHost, analyzeRules, refusing a 20,000-rule file, profile validations) have no work counter in the code; they always run, but are enforced only with `LJ_PERF=1`, i.e. `npm run test:perf` (`scripts/test-perf.mjs`). Without it, `npm test` prints each time as a test diagnostic.

### 5. Browser timings not re-measured after the perf fixes (done, 2026-10-27)

Measured with the new `npm run e2e:nav-perf` (Chrome 156 and Edge 156) and `npm run e2e:launch -- --runs 10`. The numbers are in `handoff.md` (Performance).
- **Worker CPU:** about 1.1–2.0 ms JS+GC per navigation, plus 0.5–0.9 ms native, the same with 4 and with 5,004 rules. The 5,000-rule jump to 17 ms is gone.
- **Page loads:** the extra page-load time barely changed: +3 to +9 ms for a spoofed reload, +75 to +85 ms for a cross-site switch, and +84 ms (Chrome) or +138 ms (Edge) for a spoofed new tab. That cost comes from attaching, holding the request and the new renderer, not from worker CPU.

### 6. Corrupt mmdb records found at runtime aren't shown (fixed in 1.4.0)

- **What:** a corrupt GeoIP/ASN record found during a lookup counts as no match, but the user never learned why an IP rule didn't match.
- **Fixed:** `DatasetRuntime` keeps the first `lookup(...).error` per data set (`lookupErrors`), logs it once as a warning, and keeps it until `reset()` (download, replace or delete); `ensure()` doesn't clear it. It reaches the options page as `GlobalStatus.datasets.lookupErrors` (`listStatuses`), and the data set's card shows it (`opt.data.recordError`). It lives in the worker's memory, so after the worker restarts it shows again only once a lookup hits the record again. Tests: "Corrupt data-set records found by lookups" in `test/parser-safety.test.ts` (the runtime now takes an optional `DatasetSource`, so tests don't need IndexedDB).

### 7. Deleted data set still says "was downloaded for subscription X" (fixed in 1.4.0)

- **What:** after a data set was deleted, Options ▸ Subscriptions still showed that it was downloaded for a subscription.
- **Fixed by deriving the text, not clearing the record:** the `subscriptionDatasetState` record is what keeps a deleted data set from being downloaded again (`datasetDownloadDue`), so clearing it on delete would bring the file back at the next subscription update. `subscriptionDatasetStatus()` (`src/shared/subscription-dataset-status.ts`) combines the record with what is installed: *downloaded* only while a file from the record's URL is installed, *deleted* (`opt.sub.dsDeleted`) when it is gone, nothing when another file replaced it, and the failure only while nothing is installed. The options page refreshes the installed list on the data page and when the worker writes a record. Tests: "what Options says about data sets downloaded for subscriptions" in `test/dataset-update.test.ts`.

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

- **What:** in Edge, a spoofed site opened in a new tab shows a visible reload most of the time (9 of 10 runs in Edge 156, `npm run e2e:nav-perf`, 2026-10-27); Chrome usually gets the profile in before the load. Documented in `LIMITATIONS.md` (Timing).
- **Why it stays:** the load starts before the debugger can attach. The restart-in-flight and reload-once paths in `tab-session.ts` are the fallback. Any change there must keep the invariants in `handoff.md` (never restart a POST, at most one reload per URL).

### 13. "Reload needed" stuck on a tab after a prerendered page was activated (fixed, unreleased)

- **What:** reported on claude.ai: every load in a tab, reloads included, was flagged *This page started loading before its profile could be applied*, although the page was spoofed. The log showed `Start probe unavailable: No frame for given id found` on each commit.
- **Cause:** Chrome prerenders sites from the new-tab page (the address bar does this for sites visited often). Prerendering is only possible while no debugger is attached (`PrerenderingDisabledByDevTools`), so it happens before the extension attaches. The activated page keeps its own main frame id while the page target id stays the same, and `mainFrameId` was taken once from the target id (`targetIdForTab`). From then on the gate didn't recognise the tab's own document requests (no gate, no abort-and-re-issue on a profile change) and the start probe asked for a frame that no longer existed.
- **Fixed:** `onFrameNavigated` (from `Page.frameNavigated` without a `parentId`) follows the main frame, and `inMainFrame` looks the main frame up in `Page.getFrameTree` and retries once when a command answers "No frame" (probe and popup check). Unit tests "follows a new main frame…" and "learns the new main frame from Page.frameNavigated…"; stress test "page prerendered in a tab without a session…" (fails on 1.4.0 with the reported message, passes in Chrome 156 and Edge 156). `verify/public/prerender.html?go=<ms>` and `?prerenderable` make such a prerender possible in tests.

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
