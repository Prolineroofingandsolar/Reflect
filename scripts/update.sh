#!/bin/bash
# Pull the latest Reflect OS code and apply it.
# On a Pi with the systemd service installed, this restarts the service (the running
# mirror then auto-reloads when it notices the new version). On a Mac, relaunch afterwards.
set -e

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_ROOT"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "Updating Reflect OS on branch ${BRANCH}..."
git pull --ff-only origin "$BRANCH"

echo "Now on version: $(cat VERSION 2>/dev/null || echo unknown)"

if systemctl list-units --type=service 2>/dev/null | grep -q reflect-os-server; then
  echo "Restarting the server service..."
  sudo systemctl restart reflect-os-server.service
  echo "Done. The mirror will auto-reload to the new version within a couple of minutes."
else
  # Restart a locally-launched server if one is running.
  OLD_PID="$(lsof -tiTCP:4173 -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$OLD_PID" ]; then kill $OLD_PID 2>/dev/null || true; sleep 0.5; fi
  echo "Done. Relaunch the mirror (e.g. ./scripts/launch-mac.command) to load the new version."
fi
