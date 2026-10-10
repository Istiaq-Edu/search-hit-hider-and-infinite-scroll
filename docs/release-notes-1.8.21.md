# Release notes — v1.8.21

For the AMO version-history page. Written for users, not developers: no internal
jargon, no attribute names, no file paths. Two lengths — use the short one if the
field is size-limited.

---

## Short (paste this one)

```
Blocking is now much more reliable, and blank gaps in the results page are fixed.

• Fixed: search results that were invisible but still took up space, leaving blank gaps.
• Fixed: blocking could be delayed by up to a minute on some page loads. It now starts
  as soon as the page structure is ready, instead of waiting for every resource to finish.
• Fixed: blocking or unblocking a domain now applies to tabs you already have open —
  no reload needed.
• Fixed: pausing and resuming now works properly. A tab that loaded while paused could
  never hear that you had resumed.
• Fixed: unblocking a result could leave it blank.
• Fixed: if the extension's background process was slow, an empty block list could be
  cached and then reused. It no longer is.
• Fixed: the "copy report" button in Settings silently did nothing. It works now.
```

---

## Full

**Blocking is now much more reliable, and the blank gaps in the results page are gone.**

### Fixed

- **Blank gaps in search results.** Results could be invisible while still taking up
  their full height, leaving empty space where a result should be. Fixed.

- **Blocking could be delayed by up to a minute.** On some page loads the extension did
  not start working until the page had finished loading *everything* — including
  advertising and analytics requests that can hang for a long time. Blocking now starts
  as soon as the page structure is ready. If you ever reloaded a results page and saw
  blocked sites appear anyway for the first few seconds, this is why.

- **Changes now apply to tabs you already have open.** Blocking or unblocking a domain
  used to take effect only in tabs loaded afterwards. Open results pages now update
  straight away, without a reload.

- **Pause and resume.** Resuming after a pause now works reliably. A tab that had been
  loaded while paused had no way of knowing you had resumed, so it stayed inactive until
  you reloaded it.

- **Unblocking a result could leave it blank.** After clicking *Unblock*, the result
  could come back as an empty space instead of content. Fixed.

- **A slow background process could poison the block list.** If the extension's
  background process was temporarily unreachable, it could save an empty block list and
  then keep reusing it. An empty list is no longer treated as authoritative.

- **The "copy report" helper did nothing.** The button in Settings that is meant to copy
  a diagnostic report raised an error instead, so reports could never be collected. It
  works now.

### Improved

- **The diagnostic report now gives a plain-English verdict** on whether anything is
  stuck invisible on the page, and says so explicitly when it cannot tell — rather than
  reporting an all-clear it has not actually earned.

### Notes

- No new permissions, and no new network requests.
- Nothing is sent anywhere; the block list stays on your device.

---

## For the GitHub release (the workflow generates this automatically)

The Release workflow builds the changelog from `git describe --tags`, so nothing needs
to be pasted for GitHub. Only the AMO version-history field above is manual.
