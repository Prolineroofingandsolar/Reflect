#!/bin/bash
set -e

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_URL="http://127.0.0.1:4173/index.html"

if ss -ltn | grep -q ':4173 ' && ! curl -fsS http://127.0.0.1:4173/api/health 2>/dev/null | grep -q '"version":9'; then
  if [ -f /tmp/reflect-os-server.pid ]; then
    kill "$(cat /tmp/reflect-os-server.pid)" 2>/dev/null || true
    sleep 0.5
  fi
fi

if ! ss -ltn | grep -q ':4173 '; then
  cd "$APP_ROOT"
  node server.js >/tmp/reflect-os-server.log 2>&1 &
  echo $! >/tmp/reflect-os-server.pid
  sleep 0.5
fi

if command -v unclutter >/dev/null 2>&1; then
  unclutter -idle 0.2 -root &
fi

chromium-browser \
  --kiosk \
  --disable-infobars \
  --noerrdialogs \
  --disable-session-crashed-bubble \
  "$APP_URL"
