#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_URL="http://127.0.0.1:4173/index.html"

if lsof -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1 && ! curl -fsS http://127.0.0.1:4173/api/health 2>/dev/null | grep -q '"version":9'; then
  OLD_PID="$(lsof -tiTCP:4173 -sTCP:LISTEN)"
  if [ -n "$OLD_PID" ]; then
    kill "$OLD_PID"
    sleep 0.5
  fi
fi

if ! lsof -iTCP:4173 -sTCP:LISTEN >/dev/null 2>&1; then
  cd "$APP_ROOT"
  node server.js >/tmp/reflect-os-server.log 2>&1 &
  echo $! >/tmp/reflect-os-server.pid
  sleep 0.5
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  open -na "Google Chrome" --args --app="$APP_URL" --window-size=1366,768 --disable-infobars
else
  open "$APP_URL"
fi
