#!/bin/bash
# Patch the DSH web frontend so the PWA manifest is fetched WITH credentials.
#
# Why: dsh.mergio.app sits behind Cloudflare Access. Chrome fetches
# <link rel="manifest"> as an anonymous request, so the manifest request gets
# 302'd to the Cloudflare login page and dies with net::ERR_FAILED. Chrome then
# reports installabilityErrors ["manifest-parsing-or-network-error",
# "no-manifest"] and the browser menu loses the "Install app" entry.
# Adding crossorigin="use-credentials" makes Chrome send the Access cookie, the
# manifest comes back 200 application/manifest+json and installability is clean.
#
# `dsh web` re-reads dist/index.html on every request, so this patch only needs
# a page refresh to take effect. Re-running it is a no-op.
set -u

changed=0
for f in "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html; do
  [ -f "$f" ] || continue
  if grep -q 'rel="manifest" href="\./manifest\.webmanifest" />' "$f" 2>/dev/null; then
    sed -i '' 's|<link rel="manifest" href="\./manifest\.webmanifest" />|<link rel="manifest" href="./manifest.webmanifest" crossorigin="use-credentials" />|' "$f"
    echo "patched: $f"
    changed=1
  elif grep -q 'crossorigin="use-credentials"' "$f" 2>/dev/null; then
    :
  fi
done

# also cover a Vite build that uses a leading slash or a different asset path
for f in "$HOME"/.npm/_npx/*/node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html; do
  [ -f "$f" ] || continue
  grep -q 'crossorigin="use-credentials"' "$f" || echo "warning: manifest link not patched in $f"
done

[ "$changed" = 1 ] && echo "pwa-manifest patch applied (refresh the page; no restart needed)"
exit 0
