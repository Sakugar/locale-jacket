# Troubleshooting

Start with the popup's status chip and **Check what the page sees**. Next, look at *Options ▸ Sessions & log*: the log is in-memory and explains every attach, gate decision and reload. For deeper debugging, open `chrome://extensions`, click **service worker** under Locale Jacket, and read the console (`[LocaleJacket]` lines).

| Symptom | Likely cause | What to do |
|---|---|---|
| Chrome shows "Locale Jacket started debugging this browser" | Expected. Chrome shows this for every `chrome.debugger` session. | Leave it open. It disappears when no tab needs spoofing (or turn *Keep the debugger attached after leaving a spoofed site* off, so sessions end sooner). To hide it for good, launch Chrome with `--silent-debugger-extension-api`, but that hides it for **all** debugger-using extensions. See the README section *Hiding the debugging banner* and `tools/chrome-banner-flag.ps1`. |
| Popup says **Paused** / badge shows `\|\|` | You clicked *Cancel* on that banner. Chrome detached every session. | Press **Resume** in the popup (or under *Options ▸ Sessions & log*). |
| Badge shows `EN!` / chip says **Reload needed** | The page started before the profile could be applied: an already-open tab, a rule changed, a POST navigation, or a page restored from cache. | Reload the tab (the popup has a button). |
| The first page opened from a new tab reloads once | Chrome refuses to attach while the tab shows the New Tab Page, so the extension reloads the page so its scripts see the profile. | Expected. Turn off *Reload once if the profile arrived late* to disable it. The HTTP header is right either way. |
| Chip says **Not allowed** | Chrome forbids debugging this page (`chrome://`, the New Tab Page, Web Store / Edge Add-ons, enterprise policy), or the page embeds another extension's frame. | Nothing to fix. These pages cannot be spoofed by any extension. |
| The startup page, a restored tab or a page opened in a new tab loads twice (the server log shows the request twice) | It began loading before the extension could attach (at browser start, before its service worker was running). A load still in flight is stopped and restarted with the profile, so it renders once; a page that had already loaded is reloaded once. | Expected. Turn off *Reload once if the profile arrived late* to disable both. Form submissions (POST) are never repeated. |
| Chip says **Partial**: "another tab or DevTools already overrides it in this renderer process" | The `Intl` locale is per renderer process and another tab, frame or DevTools ▸ Sensors already set one. | Close the other tab of the same site (or the popup window that shares its process) or clear DevTools ▸ Sensors ▸ Locale, then reload. |
| `navigator.language` is right but `Intl` is not | Same process conflict as above. | See above. |
| A cross-site iframe (for example an embedded video) reports a different locale | Inherit mode: it should match the page. If it doesn't, the iframe's process is shared with another tab that embeds the same site under another profile. | Reload, or close the other tab. In per-frame mode the iframe uses its own rule by design. |
| Nothing is spoofed in private windows | Extensions are off in incognito by default. | `chrome://extensions` ▸ Locale Jacket ▸ Details ▸ **Allow in Incognito**. |
| Rule does not match | Typo, keyword vs suffix confusion, a more specific rule winning, or the rule is disabled. | *Options ▸ Test & verify*: enter the hostname to see every matching rule and why the winner wins. |
| `fakegoogle.com` is not matched by `google.com` | Intended: `DOMAIN-SUFFIX` respects label boundaries. | Use `DOMAIN-KEYWORD,google` if you really want substring matching. |
| Accept-Language shows `q=0.9` values you did not type | Chrome always builds the header from `navigator.languages`. | Edit **navigator.languages** in the rule. The header follows. |
| Time zone does not change | The time zone override is off unless set in the rule's profile, and it is per process like the locale. | Enable *Override time zone* in the rule. |
| "Attach failed" errors in the log | Usually a page that closed during attach, or a policy. Attempts are capped at 3 per minute per tab. | If it persists on one site, check `chrome://policy` for `DeveloperToolsAvailability` and `ExtensionSettings` → `runtime_blocked_hosts`. |
| A `DOMAIN-REGEX` rule is refused as possibly slow, or a subscription lists one as skipped | The pattern could take too long on some hostnames, or uses syntax the check does not know. The check is conservative. *Too complex to check* means analysing the pattern itself would take too long (it is refused without a verdict). | Rewrite it in a form like `^([a-z0-9-]+\.)*example\.com$`, or use a `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` rule. |
| A subscription skips regexes as *too many complex regular expressions in this list* | All the regexes of one file share about 750 ms of checking; the ones left when it is spent are skipped. | Split the file, simplify the patterns, or use `DOMAIN-SUFFIX` / `DOMAIN-KEYWORD` rules. |
| Settings problems list *Stored rule DOMAIN-REGEX,… is kept but never matches* | One of your saved regex rules was checked after the settings loaded (very long rule lists are checked in the background) and refused. | Simplify the pattern, or delete the rule. |
| A subscription shows "Could not save the subscription data …; the previous rules stay in use" | The extension's storage (`chrome.storage.local`, 10 MB) is full, usually from very large subscription files. | Remove subscriptions you don't need or use smaller files, then *Update now*. Until then the previous rules stay in use. |
| A subscription, data-set download or update check fails with "did not finish within …", "did not answer within …" or "stopped sending data …" | The server was too slow or stalled. Downloads have an overall time limit and a limit on pauses, so a stuck server cannot block later updates. | Try again later, or use another address or mirror. |
| Import fails | The validator reports the exact rule index and problem (invalid domain, BCP 47 tag, time zone, or an unsupported YAML feature such as anchors or `\|` blocks). | Fix the listed lines. JSON and the documented YAML subset are accepted. |
| Everything should go back to normal | — | Turn the switch off (all sessions detached, DNR rules removed) or disable / uninstall the extension. Already-open pages keep what their scripts read until reloaded. |

## Reporting a problem

Include:
- the browser version (`chrome://version`)
- the popup's status chip text
- the output of **Check what the page sees**
- the relevant lines from *Sessions & log*

The log contains hostnames only. Remove any you don't want to share.
