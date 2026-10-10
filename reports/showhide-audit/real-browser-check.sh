#!/usr/bin/env bash
# ============================================================
# real-browser-check.sh — drive real-browser-check.mjs from a shell.
#
# WHY A SEPARATE SHELL DRIVER: Node cannot spawn any .exe on this machine
# (spawnSync -> EBUSY; execSync -> cmd.exe EBUSY), while the identical command
# line from bash works. So: Node generates the site, Python serves it, Chrome
# renders it, and this script collects the report.
#
# --host-resolver-rules maps www.google.com onto 127.0.0.1 so the preload's
# `isGoogle` gate (location.hostname) is genuinely ON. Without it the cover is
# never armed and every case would trivially report opacity=1.
#
# USAGE: bash reports/showhide-audit/real-browser-check.sh <preload.js> <label>
# ============================================================
set -u
cd "$(dirname "$0")/../.." || exit 1
PRELOAD="${1:-dist/content/preload.js}"
LABEL="${2:-fixed}"
PORT="${SHH_PORT:-8765}"
SITE=".tmp-cascade/site"
# No machine-specific path baked in: override with SHH_CHROME.
CHROME="${SHH_CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"

rm -rf "$SITE"; mkdir -p .tmp-cascade
node reports/showhide-audit/real-browser-check.mjs "$PRELOAD" "$LABEL" "$SITE" || exit 1

python -m http.server "$PORT" --bind 127.0.0.1 --directory "$SITE" >/dev/null 2>&1 &
SRV=$!
# Wait for the listener rather than sleeping a fixed amount.
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/preload.js"; then break; fi
  sleep 0.25
done

"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --host-resolver-rules="MAP www.google.com 127.0.0.1" \
  --virtual-time-budget=9000 --dump-dom \
  "http://www.google.com:$PORT/" > .tmp-cascade/dom.html 2>/dev/null

kill "$SRV" 2>/dev/null

echo ""
echo "########## $LABEL   preload=$PRELOAD ##########"
python - <<'PYX'
import re, html
s = open(".tmp-cascade/dom.html", encoding="utf8", errors="replace").read()
m = re.search(r'<pre id="report">(.*?)</pre>', s, re.S)
print(html.unescape(m.group(1)) if m else "NO REPORT in dom.html")
PYX
echo ""
