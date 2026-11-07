# Release notes — v1.9.0

For the AMO version-history page. Written for users, not developers: no internal
jargon, no attribute names, no file paths. Two lengths — use the short one if the
field is size-limited.

---

## Short (paste this one)

```
A reliability release: saves can no longer silently fail, Undo is precise, and
blocking stays steady while pages update themselves.

• Fixed: a result you revealed with "Show" could be re-hidden moments later by
  the page updating itself. It now stays visible until you hide it again.
• Fixed: the Undo button on a notification now reverts exactly that change —
  it could previously undo a different domain's block instead.
• Fixed: blocking or unblocking now tells you when saving failed, instead of
  appearing to work and silently reverting on reload.
• Fixed: your place in auto-loaded pages is restored more reliably after a
  reload, going back, or searching again in the same tab.
• Fixed: Startpage and Yandex could offer to block the search engine itself on
  some result links.
• Fixed: settings no longer revert after a brief Firefox Sync hiccup, and
  rapid setting changes no longer overwrite each other.
• Fixed: importing a backup no longer re-enables domains you had disabled.
• New: works on many more regional Google and Yandex domains — site coverage
  grew from 60 to 220 domains.
```

---

## Full

**A reliability release: saves that cannot silently fail, precise Undo, and
steadier blocking while pages update themselves.**

### Fixed

- **Show-once results stay shown.** A result you revealed with *Show* could be
  re-hidden moments later, when the page refreshed itself or the extension
  re-checked the results. It now stays visible until you hide it again.

- **Undo now reverts exactly the change it belongs to.** Each notification's
  Undo button undoes its own block or unblock. Previously, if you made other
  list changes in between, Undo could revert a completely different domain's
  change.

- **Failed saves are no longer silent.** If saving a block could not complete
  (for example when storage is full), the page used to behave as if it had
  worked and the change quietly disappeared on reload. You now get a clear
  message, and the result keeps its controls so you can retry.

- **Deep-scroll restore is more reliable.** If you scroll far into auto-loaded
  pages and then reload or go back, your position and the pages behind it are
  restored properly — including after searching again in the same tab, which
  used to disable scroll restoration for the rest of the session.

- **Startpage and Yandex no longer offer to block the search engine itself.**
  Some result links (proxies and redirects the extension could not decode)
  made the block button target the search engine instead of the result.

- **Settings survive a Firefox Sync hiccup.** A brief failure of Firefox Sync
  used to make the next start silently revert your preferences to older values.
  The newest settings are now kept.

- **Rapid setting changes no longer overwrite each other.** Quick slider drags
  and toggles used to race; each change now applies on top of the latest state,
  and switching an engine on or off no longer reverts changes made at the same
  time.

- **Importing a backup keeps disabled entries disabled**, and preserves when
  they were added. Previously an import silently re-enabled every disabled
  domain and reset its history.

### Improved

- **Works on many more regional domains.** Coverage expanded from 60 to 220
  search-engine domains: 189 Google country portals (google.ad, google.co.za,
  google.com.au, …), 21 Yandex domains, and the other supported engines.
  Blocking, unblocking and auto-load now behave the same on all of them.

- **Steadier page lifecycle.** Pausing and resuming, recovering from a sleeping
  background process, and a page that loads while paused are handled more
  robustly — fewer situations where blocking appears stuck until you reload.

- **Unblocking one domain no longer reveals other still-blocked domains** that
  sit nested inside the same result group.

- **The Perma button waits until the ban is actually saved** before removing
  its controls, so a failed save cannot leave a result hidden with no way to
  reach it.

### Notes

- **Site-access list is longer, by design.** With the expanded domain coverage,
  the per-site access entries Firefox shows for this add-on now cover the 220
  supported domains. No special permissions were added — the only regular
  permission remains Storage.
- **No new network requests.** The extension still communicates only with the
  search engine whose page you are viewing.
- **Nothing is collected or sent anywhere**; the block list stays on your
  device.

---

## For the GitHub release (the workflow generates this automatically)

The Release workflow builds the changelog from `git describe --tags`, so nothing
needs to be pasted for GitHub. Only the AMO version-history field above is
manual.
