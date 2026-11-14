#!/bin/bash
set -a
. "$HOME/.dsh/.env"
set +a
export BLACKFOLD_API_KEY="$(cat "$HOME/.dsh/secrets/blackfold.key")"
OUT="$HOME/.dsh/dsh.out"
: > "$OUT"
npx -y @deepseek-ai/dsh@0.2.2-rc.1 web --no-open --port 3080 \
  --public-url https://dsh.mergio.app --trusted-host dsh.mergio.app >"$OUT" 2>&1 &
DPID=$!
# persist the current public login link as soon as dsh prints it
for i in $(seq 1 90); do
  # keep the PWA manifest fetchable behind Cloudflare Access (idempotent)
  bash "$HOME/.dsh/patch-pwa-manifest.sh" >/dev/null 2>&1
  link=$(grep -oE 'https://dsh\.mergio\.app/\?token=[A-Za-z0-9_-]+' "$OUT" | tail -1)
  if [ -n "$link" ]; then umask 077; printf '%s\n' "$link" > "$HOME/.dsh/login-link.txt"
    printf '%s\n' "$link" | sed 's#https://dsh\.mergio\.app/#http://127.0.0.1:3080/#' > "$HOME/.dsh/login-link-local.txt"; break; fi
  sleep 1
done
wait $DPID
