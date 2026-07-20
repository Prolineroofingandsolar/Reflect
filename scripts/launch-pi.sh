#!/bin/bash
# Reflect OS kiosk launcher for Raspberry Pi OS.
# Starts the local server if needed, disables screen blanking, and keeps Chromium
# alive in kiosk mode by relaunching it if it crashes or is closed.
set -u

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_URL="http://127.0.0.1:4173/index.html"
LOG_DIR="${APP_ROOT}/data"
mkdir -p "$LOG_DIR"

# Pick whichever Chromium binary this image ships (Bookworm uses "chromium").
CHROMIUM=""
for candidate in chromium chromium-browser; do
  if command -v "$candidate" >/dev/null 2>&1; then CHROMIUM="$candidate"; break; fi
done
if [ -z "$CHROMIUM" ]; then
  echo "Chromium is not installed. Run: sudo apt install -y chromium" >&2
  exit 1
fi

# Start the server if it is not already answering on the expected version.
if ! curl -fsS http://127.0.0.1:4173/api/health 2>/dev/null | grep -q '"ok":true'; then
  if [ -f /tmp/reflect-os-server.pid ]; then kill "$(cat /tmp/reflect-os-server.pid)" 2>/dev/null || true; sleep 0.5; fi
  ( cd "$APP_ROOT" && node server.js >>"${LOG_DIR}/server.log" 2>&1 & echo $! >/tmp/reflect-os-server.pid )
  sleep 1
fi

# Keep the display awake (X11). On Wayland/labwc these are no-ops and can be ignored.
if command -v xset >/dev/null 2>&1; then
  xset s off || true
  xset -dpms || true
  xset s noblank || true
fi
if command -v unclutter >/dev/null 2>&1; then
  pgrep -x unclutter >/dev/null || unclutter -idle 0.2 -root &
fi

# Relaunch Chromium if it exits, so the mirror recovers from a crash without a reboot.
while true; do
  "$CHROMIUM" \
    --kiosk \
    --incognito \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=Translate \
    --check-for-update-interval=31536000 \
    --overscroll-history-navigation=0 \
    "$APP_URL"
  echo "Chromium exited; restarting in 3s..." >&2
  sleep 3
done
