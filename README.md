# Reflect OS

Reflect OS is a modular smart mirror program for Mac preview and Raspberry Pi deployment. The same interface powers both targets, with a local personal profile for layout, accent colour, greeting, navigation timing, and widget visibility.

## View On Mac

Use either option:

- Open `../Reflect OS.app`
- Run `scripts/launch-mac.command`

The Mac launcher starts the local Reflect server and opens Reflect OS in a Chrome app-style window when Google Chrome is installed. Node.js is required. If Chrome is not installed, it opens the interface with the default browser.

## Customise

- Press `E` to unlock layout edit mode.
- Long-press/touch-hold the mirror to unlock layout edit mode.
- Select a widget, then change its zone or size.
- Hide widgets from edit mode or from Settings.
- Press `Escape` or choose `Done` to return to mirror mode.
- Changes are saved locally on the device.

The home layout uses nine mirror-safe zones: top-left, top-centre, top-right, middle-left, centre, middle-right, bottom-left, bottom-centre, and bottom-right.

## Account And Add-on Store

- Users create or sign in to a device-local Reflect profile with their name, email, and a hashed 4 to 8 digit PIN.
- Discover, search, install, connect, open, and uninstall are separate actions.
- The catalogue is loaded from validated manifests in `addons/catalog.json`; unknown IDs cannot be installed.
- Weather is preinstalled. Spotify, Google Calendar, Smart Home, and Photos are available in the store.
- Photos are resized for mirror performance and stored privately in IndexedDB on that device.
- Spotify and Google Calendar users only need their ordinary accounts. Reflect OS owns the provider app credentials.

## Live Data

- Weather uses Open-Meteo and does not require a user API key. Place name, latitude, and longitude are configurable in Settings.
- Tasks and device-created events persist locally and sync to the signed-in device account.
- Connected Google Calendar accounts load live upcoming events from the primary calendar.
- Spotify supports account connection, live now-playing status, search, recently played tracks, controls, and in-app playback for eligible Spotify Premium accounts.

## Spotify Module

- The home screen includes a configurable Spotify widget.
- Settings control the Spotify widget mode: minimal, standard, or detailed.
- The Music screen includes playback controls, volume, album artwork, playlist selection, device name, and add-on connection status.
- Users should only need their normal Spotify account. They should not need a Spotify Developer account.
- Spotify connects through the local Reflect server using your official Spotify app credentials. See `BACKEND.md` for setup.

## Raspberry Pi Kiosk

1. Copy the `reflect-os` folder to the Pi:

```bash
/home/pi/reflect-os
```

2. Install Chromium and the cursor hider:

```bash
sudo apt update
sudo apt install -y chromium-browser unclutter nodejs
```

3. Test launch:

```bash
/home/pi/reflect-os/scripts/launch-pi.sh
```

4. Enable autostart:

```bash
mkdir -p /home/pi/.config/autostart
cp /home/pi/reflect-os/scripts/reflect-os.desktop /home/pi/.config/autostart/reflect-os.desktop
```

5. Reboot the Pi.

## Shortcuts

- `H` home
- `C` calendar
- `T` tasks
- `M` music
- `W` weather
- `S` smart home
- `A` add-ons
- `,` settings
- `E` edit layout
- `Escape` close navigation or exit edit mode

## Remaining Integration

Smart Home is still a visual Home Assistant placeholder. A production multi-device release also needs a hosted Reflect account service, signed add-on packages, automatic updates, and device pairing.

See `BACKEND.md` for the Reflect Cloud integration contract.
See `ADDON-SDK.md` for the add-on manifest and lifecycle contract.
