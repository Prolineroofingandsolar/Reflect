#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_URL="http://127.0.0.1:4173/index.html"

# Always restart the server so config changes and code updates take effect on every launch.
OLD_PID="$(lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null)"
if [ -n "$OLD_PID" ]; then
  kill $OLD_PID 2>/dev/null || true
  sleep 0.5
fi

cd "$APP_ROOT"
node server.js >/tmp/reflect-os-server.log 2>&1 &
echo $! >/tmp/reflect-os-server.pid
sleep 0.7

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$APP_URL" --window-size=1366,768 --disable-infobars
else
  open "$APP_URL"
fi
