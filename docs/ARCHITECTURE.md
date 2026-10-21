# Architecture

```text
 popup / options pages ──(chrome.storage.local "settings")──▶ background service worker
        │                                                        │
        └──(runtime messages: status, verify, reload, resume)────┤
                                                                 ▼
                       SessionManager ── one TabSession per tab ── chrome.debugger (CDP 1.3)
                              │                    │
                              │                    ├─ Fetch gate (document requests)
                              │                    ├─ Target.setAutoAttach → OOPIF / worker child sessions
                              │                    ├─ Emulation.* overrides (locale, accept-language, tz, geo)
                              │                    └─ isolated-world document-start probe
                              └─ declarativeNetRequest dynamic rules (top-level Accept-Language)
```

## Modules

| File | Responsibility |
|---|---|
| `src/shared/domain.ts` | Hostname normalization (WHATWG URL / UTS #46), punycode decoding, IP detection, label-boundary suffix matching |
| `src/shared/rules.ts` | Rule matching and deterministic precedence, match traces, conflict/duplicate/redundancy analysis |
| `src/shared/locale.ts` | BCP 47 canonicalization and ICU support check, profile completion, Chrome's Accept-Language q-value format |
| `src/shared/config-io.ts`, `yaml.ts` | JSON/YAML import (full and Clash-compact forms) and export, validation of stored settings |
| `src/shared/dnr.ts` | Compiles rules into `declarativeNetRequest` rules whose priorities reproduce the engine's precedence |
| `src/background/sw.ts` | MV3 entry point: listeners, settings and DNR sync, badge, messaging |
| `src/background/manager.ts` | Routes tab, navigation and debugger events to `TabSession`s; global enable/suspend |
| `src/background/tab-session.ts` | Per-tab lifecycle: attach, gate, re-issue, children, late detection, verification |
| `src/background/overrides.ts` | Diffs intended against desired state and sends only the commands that change something |

## The navigation gate

The facts this design rests on (all measured in Chrome 155, see `research/FINDINGS.md`):

1. Emulation overrides set on a tab's session **persist across navigations**, including cross-site, cross-process ones.
2. While a navigation is pending, Chrome **holds renderer-bound commands** and delivers them after the new document has started. Overrides sent "just before" a navigation therefore arrive too late for the page's first scripts, and awaiting them inside a paused request deadlocks.
3. Aborting the paused request (`Fetch.failRequest`), applying the overrides (≈5 ms with no navigation pending) and re-issuing the navigation (`Page.navigate`, with the original Referer) gives the right values from document start. The aborted request never reaches the server.

Hence, for every main-frame document request:

```text
requestPaused(url)
 ├─ profile(url) == applied profile → continueRequest(fix Accept-Language if needed)
 ├─ profile differs and method is GET → failRequest(Aborted) → apply → Page.navigate(url, referrer)
 │                                      (the re-issued request then matches and continues)
 └─ profile differs and method is POST → apply (best effort) + continueRequest → flagged "late"
```

The gate and child-target setup are synchronous and never await (fact 2). Attach, detach and commit bookkeeping run in a per-tab serial queue. Every CDP call has a 10 s timeout, so nothing can block a tab forever.

## Frames and workers

`Target.setAutoAttach({autoAttach, waitForDebuggerOnStart: true, flatten: true, filter: iframe + worker})` delivers each cross-site iframe (OOPIF) and dedicated worker paused. The extension sends its overrides and then `Runtime.runIfWaitingForDebugger`, in that order on the same session, so the child's first script already sees them. Nested frames are handled by enabling auto-attach on each iframe session.

- **Inherit mode (default):** children get the tab's profile.
- **Per-frame mode:** a cross-site iframe gets the profile of its own URL. The child target attaches with an empty URL, but the parent's gate saw the frame's document request (whose `frameId` equals the child's target id) and recorded its URL.
- **Same-site frames** live in the page's process and always share its locale.
- **Workers** only need `navigator.language(s)`: `Intl` is process-wide and already follows the page.

## Late detection

At each main-frame commit the extension reads `globalThis.__ljProbe` from an isolated world. It is written by `Page.addScriptToEvaluateOnNewDocument` at document start and is invisible to the page. If it is missing (the document predates the session) or disagrees with the expected profile (or with the browser's native values for SYSTEM sites), the tab is flagged *late*. Fresh, deliberate navigations (typed, link or bookmark, younger than 10 s, at most once per 30 s, never POST or back/forward) are reloaded once. The reload passes through the gate.

## Lifecycle and failure handling

| Event | Behaviour |
|---|---|
| Tab created / navigation starts | Attach if the target URL needs a profile. Overrides are *not* sent here, because the gate does that. |
| Attach refused (`chrome://`, Web Store, other extensions' frames, policy) | Status *restricted*, not counted as a failure. Retried on the next navigation event. |
| Other attach failures | At most 3 attempts per minute per tab, so there is no retry loop |
| "Another debugger is already attached" | Our own session survived a service-worker restart: adopt it and re-announce children |
| `chrome.debugger.onDetach: target_closed` | Session state dropped; re-attached on the next navigation that needs it |
| `onDetach: canceled_by_user` (banner Cancel) | Global *paused* state (`chrome.storage.session`), all sessions detached, DNR rules removed, until the user presses Resume |
| Extension disabled / rules no longer spoof | All sessions detached, which also clears every override; DNR rules removed |
| SYSTEM site with *keep session* on | Overrides cleared, session kept so the next switch is gated |
| Service worker suspension | An attached debugger keeps the worker alive (Chrome 118+). Without sessions, the worker sleeps and events revive it; `reconcileAll()` runs on start-up. |

## Testing

- **Unit tests** (`test/`, `node:test`) cover the rule engine (spec table, precedence, IDN, keyword, SYSTEM exceptions), YAML, import/export round-trips, the DNR compiler (compared with the engine on many URLs) and `TabSession`/`SessionManager` against a fake debugger: gate decisions, re-issue, no loops, children, conflicts, suspend/resume.
- **End-to-end tests** (`e2e/run.mjs`) run the built extension in real Chrome and Edge and assert what pages, frames and workers observe at document start, as well as the headers the server receives.
