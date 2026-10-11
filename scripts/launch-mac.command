#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_URL="http://127.0.0.1:4173/index.html"
SERVICE_LABEL="co.uk.prolineroofingandsolar.reflect.server"
NODE_BIN="$(command -v node)"

# Always restart the server so config changes and code updates take effect on every launch.
launchctl remove "$SERVICE_LABEL" 2>/dev/null || true
OLD_PID="$(lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null || true
  sleep 0.5
fi

launchctl submit -l "$SERVICE_LABEL" \
  -o /tmp/reflect-os-server.log \
  -e /tmp/reflect-os-server.log \
  -- /bin/zsh -c 'cd "$1" && exec "$2" server.js' reflect-launch "$APP_ROOT" "$NODE_BIN"

SERVER_PID=""
for _ in {1..60}; do
  SERVER_PID="$(lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$SERVER_PID" ] && break
  sleep 0.25
done
if [ -z "$SERVER_PID" ]; then
  echo "Reflect OS could not start. Check /tmp/reflect-os-server.log" >&2
  exit 1
fi
echo "$SERVER_PID" >/tmp/reflect-os-server.pid

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$APP_URL" --window-size=1366,768 --disable-infobars
else
  open "$APP_URL"
fi
