#!/bin/bash
# LAN dsh launcher: bind dsh to this host's current LAN IP, sharing the SAME
# config dir ~/.dsh as the tunnel instance. Managed by launchd app.mergio.dsh-lan.
set -u
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export DSH_HOME="$HOME/.dsh"
set -a; . "$HOME/.dsh/.env"; set +a
[ -f "$HOME/.dsh/secrets/blackfold.key" ] && export BLACKFOLD_API_KEY="$(cat "$HOME/.dsh/secrets/blackfold.key")"

OUT="$HOME/.dsh/dsh-lan.out"
LINK_FILE="$HOME/.dsh/login-link-lan.txt"

# wait for a usable private LAN IPv4 (skip the 198.18 fake-IP range)
LANIP=""
for i in $(seq 1 60); do
  LANIP=$(ipconfig getifaddr en0 2>/dev/null); [ -n "$LANIP" ] && break
  LANIP=$(ipconfig getifaddr en1 2>/dev/null); [ -n "$LANIP" ] && break
  LANIP=$(ifconfig 2>/dev/null | awk '/inet /{print $2}' | grep -E '^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01]))\.' | grep -v '^198\.18\.' | head -1)
  [ -n "$LANIP" ] && break
  sleep 2
done
if [ -z "$LANIP" ]; then echo "$(date '+%F %T') [dsh-lan] no LAN IP found, exiting"; exit 1; fi
echo "$(date '+%F %T') [dsh-lan] binding $LANIP:3080 (DSH_HOME=$DSH_HOME)"

: > "$OUT"
npx -y @deepseek-ai/dsh@0.2.2-rc.1 web --no-open --port 3080 \
  --host "$LANIP" \
  --public-url "http://$LANIP:3080" --trusted-host "$LANIP:3080" --trusted-host "dsh.mergio.app" >"$OUT" 2>&1 &
DPID=$!
for i in $(seq 1 90); do
  # keep the PWA manifest fetchable behind Cloudflare Access (idempotent)
  bash "$HOME/.dsh/patch-pwa-manifest.sh" >/dev/null 2>&1
  link=$(grep -oE "http://[0-9.]+:3080/\?token=[A-Za-z0-9_-]+" "$OUT" | tail -1)
  if [ -n "$link" ]; then umask 077; printf '%s\n' "$link" > "$LINK_FILE"; echo "$(date '+%F %T') [dsh-lan] link -> $LINK_FILE"; break; fi
  sleep 1
done
wait $DPID
