#!/bin/zsh
# Run only when Firebase shows fixmypvd.org cert ACTIVE and https://fixmypvd.org returns 200.
set -e
cd /Users/rob/Code/pvd311
# 1. marketing placeholders: current value → fixmypvd.org
for f in marketing/*.md; do sed -i '' -e 's|FIXMYPVD_URL\*\* = https://pvdsnow.org|FIXMYPVD_URL** = https://fixmypvd.org|' -e 's|\*\*Now:\*\* `https://pvdsnow.org`|**Now:** `https://fixmypvd.org`|' "$f"; done
# 2. client-side canonical redirect (Firebase Hosting has no host-based redirects)
python3 - <<'PY'
p='app/index.html'; s=open(p).read()
snip='''    <script>
      // Canonical host: the old pvdsnow.org domain forwards to fixmypvd.org (Firebase Hosting has no host-based redirects).
      if (/(^|\\.)pvdsnow\\.org$/.test(location.hostname)) location.replace('https://fixmypvd.org' + location.pathname + location.search + location.hash);
    </script>
'''
if 'pvdsnow\\.org$' not in s:
    s=s.replace('    <meta charset="UTF-8" />\n','    <meta charset="UTF-8" />\n'+snip,1); open(p,'w').write(s)
PY
# 3. canonical link + OG urls
sed -i '' 's|content="https://pvdsnow.org/og-image.png"|content="https://fixmypvd.org/og-image.png"|' app/index.html
grep -q 'rel="canonical"' app/index.html || sed -i '' 's|    <title>|    <link rel="canonical" href="https://fixmypvd.org/" />\n    <title>|' app/index.html
cd app && npm run build >/dev/null && npx playwright test tests/smoke.spec.ts 2>&1 | grep -E "passed|failed"; cd ..
git commit -q -m "cutover: fixmypvd.org is canonical — pvdsnow.org forwards client-side, marketing placeholders flipped

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Q1REyxEbp4GnvgMyznMTpX" -- marketing app/index.html
git push -q github main; npm run deploy 2>&1 | grep -E "Deploy complete|rror"
curl -s -o /dev/null -w "fixmypvd.org %{http_code}\n" https://fixmypvd.org/
