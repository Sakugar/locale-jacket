# Troubleshooting

Start with the popup's status chip and **Check what the page sees**. Next, look at *Options ▸ Sessions & log*: the log is in-memory and explains every attach, gate decision and reload. For deeper debugging, open `chrome://extensions`, click **service worker** under Locale Jacket, and read the console (`[LocaleJacket]` lines).

| Symptom | Likely cause | What to do |
|---|---|---|
| Chrome shows "Locale Jacket started debugging this browser" | Expected. Chrome shows this for every `chrome.debugger` session. | Leave it open. It disappears when no tab needs spoofing (or turn *Keep the debugger attached after leaving a spoofed site* off, so sessions end sooner). |
| Popup says **Paused** / badge shows `\|\|` | You clicked *Cancel* on that banner. Chrome detached every session. | Press **Resume** in the popup (or under *Options ▸ Sessions & log*). |
| Badge shows `EN!` / chip says **Reload needed** | The page started before the profile could be applied: an already-open tab, a rule changed, a POST navigation, or a page restored from cache. | Reload the tab (the popup has a button). |
| The first page opened from a new tab reloads once | Chrome refuses to attach while the tab shows the New Tab Page, so the extension reloads the page so its scripts see the profile. | Expected. Turn off *Reload once if the profile arrived late* to disable it. The HTTP header is right either way. |
| Chip says **Not allowed** | Chrome forbids debugging this page (`chrome://`, the New Tab Page, Web Store / Edge Add-ons, enterprise policy), or the page embeds another extension's frame. | Nothing to fix. These pages cannot be spoofed by any extension. |
| Chip says **Partial**: "another tab or DevTools already overrides it in this renderer process" | The `Intl` locale is per renderer process and another tab, frame or DevTools ▸ Sensors already set one. | Close the other tab of the same site (or the popup window that shares its process) or clear DevTools ▸ Sensors ▸ Locale, then reload. |
| `navigator.language` is right but `Intl` is not | Same process conflict as above. | See above. |
| A cross-site iframe (for example an embedded video) reports a different locale | Inherit mode: it should match the page. If it doesn't, the iframe's process is shared with another tab that embeds the same site under another profile. | Reload, or close the other tab. In per-frame mode the iframe uses its own rule by design. |
| Nothing is spoofed in private windows | Extensions are off in incognito by default. | `chrome://extensions` ▸ Locale Jacket ▸ Details ▸ **Allow in Incognito**. |
| Rule does not match | Typo, keyword vs suffix confusion, a more specific rule winning, or the rule is disabled. | *Options ▸ Test & verify*: enter the hostname to see every matching rule and why the winner wins. |
| `fakegoogle.com` is not matched by `google.com` | Intended: `DOMAIN-SUFFIX` respects label boundaries. | Use `DOMAIN-KEYWORD,google` if you really want substring matching. |
| Accept-Language shows `q=0.9` values you did not type | Chrome always builds the header from `navigator.languages`. | Edit **navigator.languages** in the rule. The header follows. |
| Time zone does not change | The time zone override is off unless set in the rule's profile, and it is per process like the locale. | Enable *Override time zone* in the rule. |
| "Attach failed" errors in the log | Usually a page that closed during attach, or a policy. Attempts are capped at 3 per minute per tab. | If it persists on one site, check `chrome://policy` for `DeveloperToolsAvailability` and `ExtensionSettings` → `runtime_blocked_hosts`. |
| Import fails | The validator reports the exact rule index and problem (invalid domain, BCP 47 tag, time zone, or an unsupported YAML feature such as anchors or `\|` blocks). | Fix the listed lines. JSON and the documented YAML subset are accepted. |
| Everything should go back to normal | — | Turn the switch off (all sessions detached, DNR rules removed) or disable / uninstall the extension. Already-open pages keep what their scripts read until reloaded. |

## Reporting a problem

Include:
- the browser version (`chrome://version`)
- the popup's status chip text
- the output of **Check what the page sees**
- the relevant lines from *Sessions & log*

The log contains hostnames only. Remove any you don't want to share.
