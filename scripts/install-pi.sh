#!/bin/bash
# One-shot installer for Reflect OS on Raspberry Pi OS.
# Installs dependencies, registers the server as an always-on systemd service,
# and enables the kiosk to autostart on login. Run from the reflect-os folder:
#   bash scripts/install-pi.sh
set -e

APP_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Installing dependencies (chromium, unclutter, nodejs)..."
sudo apt update
sudo apt install -y chromium unclutter nodejs curl || sudo apt install -y chromium-browser unclutter nodejs curl

echo "Installing the Reflect OS server service..."
# Render the unit with this checkout's real path and current user.
sudo bash -c "sed -e 's#/home/pi/reflect-os#${APP_ROOT}#g' -e 's/^User=pi/User=${USER}/' '${APP_ROOT}/scripts/reflect-os-server.service' > /etc/systemd/system/reflect-os-server.service"
sudo systemctl daemon-reload
sudo systemctl enable --now reflect-os-server.service

echo "Enabling the kiosk autostart..."
mkdir -p "${HOME}/.config/autostart"
sed "s#Exec=/home/pi/reflect-os/scripts/launch-pi.sh#Exec=${APP_ROOT}/scripts/launch-pi.sh#" \
  "${APP_ROOT}/scripts/reflect-os.desktop" > "${HOME}/.config/autostart/reflect-os.desktop"
chmod +x "${APP_ROOT}/scripts/launch-pi.sh"

echo
echo "Done. Reboot to start the mirror:  sudo reboot"
echo "Server logs:  journalctl -u reflect-os-server -f"
