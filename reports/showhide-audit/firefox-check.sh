#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/../.." || exit 1
FF="/c/Program Files/Firefox Developer Edition/firefox.exe"
# A FRESH profile directory per run. `rm -rf` on a stale profile is
# intercepted by the environment's safe-delete and can fail, leaving a
# locked profile that makes web-ext hang -> an empty capture that looks
# like a product failure. A unique name sidesteps that entirely.
PROF=".tmp-ff/prof-$$"
mkdir -p "$PROF"
: > .tmp-ff/report.txt
cat > "$PROF/user.js" <<'PREFS'
user_pref("network.dns.localDomains", "www.google.com");
user_pref("network.proxy.type", 0);
user_pref("network.proxy.allow_hijacking_localhost", true);
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.update.enabled", false);
user_pref("browser.startup.page", 0);
PREFS

node .tmp-ff/serve.mjs >/dev/null 2>&1 &
SRV=$!
sleep 1
echo "[ff] starting Firefox Developer Edition with the REAL extension (web-ext run)…"
# This web-ext has no --headless flag; Firefox itself honours MOZ_HEADLESS.
# Prefs go in via --pref (repeatable), which is how the DNS override and the
# proxy bypass reach the browser: without them www.google.com goes to the
# environment's proxy (127.0.0.1:60927) instead of the local server.
MOZ_HEADLESS=1 npx web-ext run --source-dir dist --firefox "$FF" \
  --firefox-profile "$PROF" --keep-profile-changes --no-reload \
  --pref=network.dns.localDomains=www.google.com \
  --pref=network.proxy.type=0 \
  --pref=network.proxy.allow_hijacking_localhost=true \
  --pref=extensions.autoDisableScopes=0 \
  --start-url "http://www.google.com:8765/" > .tmp-ff/webext.log 2>&1 &
WE=$!
# WAIT FOR THE RESULT, do not guess a duration. A fixed sleep raced Firefox's
# startup: the driver killed the browser before web-ext had finished installing
# the add-on, and the harness reported an empty capture that looked like a
# product failure. Poll the captured report instead, with a hard ceiling.
for _ in $(seq 1 75); do
  [ -s .tmp-ff/report.txt ] && break
  sleep 1
done
# Kill ONLY our own web-ext child. `pkill -f firefox` was used here before and it
# is indiscriminate: it kills the user's own browser windows, not just the
# profile this script launched. web-ext closes its own Firefox on SIGTERM.
kill $WE 2>/dev/null
wait $WE 2>/dev/null
kill $SRV 2>/dev/null
sleep 1
echo "=== web-ext log (tail) ==="
tail -6 .tmp-ff/webext.log 2>/dev/null
echo "=== PAGE-WORLD REPORT ==="
cat .tmp-ff/report.txt 2>/dev/null | head -60
