#!/usr/bin/env bash
# Mutation matrix for the "cover must never be left undetermined" fix.
# Each mutation is applied, the bundle rebuilt, and the focused suites run.
# Every mutation is expected to turn a SPECIFIC test red; a mutation that
# leaves everything green is a vacuous test.
set -u
cd "$(dirname "$0")/../.." || exit 1
BAK=/tmp/shhbak
H=src/content/blocking/hider.ts
C=src/content/preload.css
M=src/content/markers.ts
P=src/content/preload.ts
G=src/content/infinite-scroll/manager.ts
FILES="tests/preload-flicker.test.ts tests/content/reveal-cover-candidate.test.ts tests/infinite-scroll/cover-reveal.test.ts tests/content/cover-selector-sync.test.ts tests/blocking/shown-once-cover.test.ts"
AUDIT="reports/showhide-audit/repro-cover-section.audit.ts"

restore() { cp "$BAK/markers.ts" "$M"; cp "$BAK/preload.ts" "$P"; cp "$BAK/manager.ts" "$G"; cp "$BAK/hider.ts" "$H"; cp "$BAK/preload.css" "$C"; }

strip() { sed 's/\x1b\[[0-9;]*m//g'; }

run() {
  local label="$1"
  node build.js >/dev/null 2>&1 || { echo "  !! build failed"; return; }
  local out aout
  # --no-file-parallelism is REQUIRED here: with the default file parallelism
  # vitest silently drops one of the three files on every run in this
  # environment (measured: 11 / 43 / 50 tests across three identical
  # invocations of a 52-test file set), which turns red tests into false greens.
  out=$(npx vitest run --no-file-parallelism $FILES 2>&1 | strip)
  aout=$(npx vitest run --config reports/showhide-audit/vitest.config.ts "$AUDIT" 2>&1 | strip)
  echo "### $label"
  echo "$out" | grep -E "Test Files +[0-9]+ (passed|failed)|Tests +[0-9]+ (passed|failed)" | sed 's/^ */  suite: /'
  echo "$out" | grep -E "FAIL " | sed -E 's/^.*FAIL +//' | sed 's/^/  RED: /'
  echo "$aout" | grep -E "Tests +[0-9]+ (passed|failed)" | sed 's/^ */  audit: /'
  echo
}

echo "=== BASELINE (no mutation) ==="
restore; run "baseline"

echo "=== M1: remove revealCoverCandidate from the CONTAINER guard ==="
restore
python -c "
p='$P'; s=open(p,encoding='utf8').read()
t='          if (isGoogle) revealCoverCandidate(el);\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M1 container guard call removed"

echo "=== M2: remove revealCoverCandidate from the SECTION guard ==="
restore
python -c "
p='$P'; s=open(p,encoding='utf8').read()
t='      // \`opacity:0\` and the section renders as a correctly-sized blank gap.\n      revealCoverCandidate(el);\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M2 section guard call removed"

echo "=== M3: remove revealCoverCandidate from the AGGREGATE guard ==="
restore
python -c "
p='$P'; s=open(p,encoding='utf8').read()
t='      // not leave the node undetermined, or the cover renders it as a gap.\n      revealCoverCandidate(el);\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M3 aggregate guard call removed"

echo "=== M4: remove revealCoverCandidate from the manager append net ==="
restore
python -c "
p='$G'; s=open(p,encoding='utf8').read()
t='        revealCoverSubtree(pageContainer);\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M4 manager append net call removed"

echo "=== M5: gut the helper (always refuse) ==="
restore
python -c "
p='$M'; s=open(p,encoding='utf8').read()
t='  el.setAttribute(\"data-shh-ok\", \"true\");\n  return true;'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,'  return false;'))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M5 helper body gutted"

echo "=== M6: drop the preloaded/result refusal in the helper ==="
restore
python -c "
p='$M'; s=open(p,encoding='utf8').read()
t='''  if (
    el.hasAttribute(\"data-shh-ok\") ||
    el.hasAttribute(\"data-shh-preloaded\") ||
    el.hasAttribute(\"data-shh-result\")
  ) {
    return false;
  }
'''
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M6 refusal block removed"

echo "=== M7: drop :not(.g .g) from the candidate selector ==="
restore
python -c "
p='$M'; s=open(p,encoding='utf8').read()
t='  \"div.g:not(.g .g)\",'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,'  \"div.g\",'))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M7 nested-div.g guard removed"

echo "=== M8: revert the whole fix (control) ==="
restore
python -c "
import re
p='$P'; s=open(p,encoding='utf8').read()
s=s.replace('          if (isGoogle) revealCoverCandidate(el);\n','')
s=s.replace('      revealCoverCandidate(el);\n','')
open(p,'w',encoding='utf8').write(s)
p='$G'; s=open(p,encoding='utf8').read()
s=s.replace('        revealCoverSubtree(pageContainer);\n','')
open(p,'w',encoding='utf8').write(s)
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M8 all call sites reverted"

echo "=== M9: remove the trailing-sweep arming (no-link exits) ==="
restore
python -c "
p='$P'; s=open(p,encoding='utf8').read()
t='      scheduleUndeterminedSweep();\n'
assert s.count(t)==2, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M9 trailing sweep disarmed"

echo "=== M10: drop the cover lift in restoreResult (unblock path) ==="
restore
python -c "
p='$H'; s=open(p,encoding='utf8').read()
t='  if (isGoogleHost(node)) revealCoverSubtree(node);\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M10 restoreResult cover lift removed"

echo "=== M11: subtree sweep degraded to self-only ==="
restore
python -c "
p='$M'; s=open(p,encoding='utf8').read()
t='  for (const el of candidates) {\n    if (stampCoverOk(el)) stamped++;\n  }\n'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,''))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M11 subtree walk removed"

echo "=== M12: break the CSS/JS selector agreement ==="
restore
python -c "
p='$C'; s=open(p,encoding='utf8').read()
t='div.g:not(.g .g):not([data-shh-ok]):not([data-shh-preloaded]),'
assert s.count(t)==1, s.count(t)
open(p,'w',encoding='utf8').write(s.replace(t,'div.g:not([data-shh-ok]):not([data-shh-preloaded]),'))
" || echo "  !! MUTATION NOT APPLIED (pattern not found)"; run "M12 preload.css drifted from markers.ts"

echo "=== RESTORING ==="
restore
node build.js 2>&1 | tail -1
