#!/bin/bash
# Installs the mirror's home engine: a Home Assistant that runs hidden in the background (plus a Matter
# server on the Raspberry Pi) and starts again by itself after a reboot. Nobody needs to open it: the mirror
# finds it, sets it up on first start and shows every brand's pairing on its own Devices screen.
#   bash scripts/install-home-engine.sh
set -e

DATA="${HOME}/.reflect-home"
mkdir -p "${DATA}"

if [ "$(uname)" = "Linux" ]; then
  if ! command -v docker >/dev/null 2>&1; then
    echo "Installing Docker..."
    curl -fsSL https://get.docker.com | sudo sh
  fi
  TZ_NAME="$(cat /etc/timezone 2>/dev/null || echo Europe/London)"
  sudo docker rm -f reflect-home reflect-matter >/dev/null 2>&1 || true
  echo "Starting the Matter server..."
  sudo docker run -d --name reflect-matter --restart=unless-stopped --network=host \
    --security-opt apparmor=unconfined -v "${DATA}/matter:/data" -v /run/dbus:/run/dbus:ro \
    ghcr.io/home-assistant-libs/python-matter-server:stable \
    --storage-path /data --paa-root-cert-dir /data/credentials --bluetooth-adapter 0
  echo "Starting the home engine..."
  sudo docker run -d --name reflect-home --restart=unless-stopped --privileged --network=host \
    -e TZ="${TZ_NAME}" -v "${DATA}/config:/config" -v /run/dbus:/run/dbus:ro \
    ghcr.io/home-assistant/home-assistant:stable
else
  # macOS: a Python install kept up by launchd. Matter needs the Raspberry Pi.
  export PATH="${HOME}/.local/bin:${PATH}"
  if ! command -v uv >/dev/null 2>&1; then
    echo "Installing uv (Python installer)..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  echo "Installing the home engine (a few minutes the first time)..."
  uv venv --allow-existing -p 3.13 "${DATA}/venv"
  uv pip install --python "${DATA}/venv/bin/python" --upgrade homeassistant
  mkdir -p "${DATA}/config" "${HOME}/Library/LaunchAgents"
  PLIST="${HOME}/Library/LaunchAgents/com.reflect.home-engine.plist"
  cat > "${PLIST}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.reflect.home-engine</string>
  <key>ProgramArguments</key><array><string>${DATA}/venv/bin/hass</string><string>-c</string><string>${DATA}/config</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${DATA}/venv/bin:${HOME}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${DATA}/engine.log</string><key>StandardErrorPath</key><string>${DATA}/engine.log</string>
</dict></plist>
PLIST
  launchctl unload "${PLIST}" >/dev/null 2>&1 || true
  launchctl load -w "${PLIST}"
fi

echo "Waiting for the home engine to start..."
for _ in $(seq 1 120); do
  if curl -s -o /dev/null http://127.0.0.1:8123/api/onboarding; then
    echo "Done. The mirror will pick it up within a minute: open Devices on the mirror to add your smart home."
    exit 0
  fi
  sleep 5
done
echo "The home engine is still starting. Give it a few more minutes, then open Devices on the mirror."
