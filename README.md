# Reflect OS

Reflect OS is a modular smart mirror program for Mac preview and Raspberry Pi deployment. The same interface powers both targets, with a local personal profile for layout, accent colour, greeting, navigation timing, and widget visibility.

## View On Mac

Easiest: **double-click `Reflect OS.app`** in this folder. It starts the local server and opens the mirror in a Chrome app-style window (or your default browser). No Terminal needed.

The first time you open it after downloading, macOS may say it's from an unidentified developer — **right-click the app → Open → Open** once to allow it (this app is not yet code-signed).

Alternative: run `scripts/launch-mac.command`.

Node.js must be installed (from nodejs.org). The app will prompt you if it's missing.

## First-Run Setup

The first time Reflect OS opens on a device, a short setup wizard collects your name and greeting, your weather location, and creates a device account with a PIN. You can skip it and configure everything later in Settings.

## Affirmations

Add an Affirmations widget to the home screen from Settings or edit mode. Choose built-in affirmations, inspirational quotes, both, or your own lines, and set how often they rotate. Custom lines are entered one per line in Settings and stay on the device.

## Smart Home (Home Assistant)

Install the Smart Home add-on, then connect your Home Assistant server URL and a long-lived access token (Home Assistant → your profile → Security → Long-lived access tokens). Lights, switches, fans, locks, covers, and scenes become controllable from the mirror, with climate and sensor readouts. The token is encrypted on the device and never sent to the browser.

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

## Voice Assistant (Jarvis)

Reflect has a built-in voice assistant in the style of Iron Man's Jarvis. Say **"Jarvis"** (or "Hey Jarvis, what's on today?"), press `J`, or tap the glowing orb at the bottom of the screen. It answers out loud, shows its reply on the mirror, and can act on the mirror: switch screens, control Home Assistant lights, switches, locks, covers, scenes and heating, play, pause, skip or search Spotify, add and complete tasks, add calendar events, and change display brightness or night mode. It can see the live weather, calendar, tasks, music and devices, so questions like "do I need an umbrella?" just work. After it answers it keeps listening for a few seconds, so you can follow up without saying its name again.

Setup: add your Anthropic API key to `reflect-os.config.json` (copy `reflect-os.config.example.json` if you don't have one yet), then restart Reflect OS:

```json
{
  "anthropicApiKey": "sk-ant-...",
  "assistantName": "Jarvis",
  "assistantWakeWord": true
}
```

- **Workspace keys:** if Claude replies that your key "is not scoped to a workspace", either create the key inside a workspace in the Claude Console, or add `"anthropicWorkspaceId": "wrkspc_..."` with the workspace's ID.
- **Manner:** it calls you "sir" now and then; set `"assistantAddress"` to "ma'am", a name, or "" to use your first name. The first conversation each day opens with a one-line briefing on the weather and what's next. Replies type out on the glass, with a short readout of anything it did (lights, tasks, music).
- **What it can do:** answer live questions with a web search (scores, news, opening times); set timers and reminders ("pasta timer ten minutes", "remind me to call the supplier at 3") which show at the top of the mirror and are announced with a chime; add, tick off, rename, reschedule and delete tasks; add and delete on-device calendar events; change the weather location; show or hide home widgets; control Home Assistant lights and switches; and play music.
- **Animation:** the mirror powers up on start (corners lock on, widgets draw in with a scan line), the clock glitches as each minute turns, and Jarvis opens like a hologram projector with his words decoding onto the glass letter by letter. Turn on "reduce motion" in the operating system to switch all of this off.
- **Brain:** Claude (`claude-opus-5-5` by default; set `assistantModel` to change it), called from the local server so the key never reaches the browser.
- **Hearing:** the browser's built-in speech recognition (works in Chrome on a Mac; Chrome sends the audio to Google for recognition). The wake word listens continuously while the mirror is open; set `"assistantWakeWord": false` to only listen after a tap or `J`.
- **Voice:** the browser's built-in voice, preferring a British male voice such as "Daniel" on macOS.
- **Optional upgrade:** add an `openaiApiKey` for a natural-sounding server voice (`assistantVoice`, default `fable`) and for server-side speech recognition. Raspberry Pi Chromium has no built-in speech recognition, so on a Pi this key is what lets it hear you (tap or `J` to talk; the wake word needs browser speech recognition).
- No microphone, or just want to type? The assistant screen has a text box.

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
- `J` talk to the voice assistant
- `Escape` close navigation or exit edit mode

## Remaining Integration

Smart Home is still a visual Home Assistant placeholder. A production multi-device release also needs a hosted Reflect account service, signed add-on packages, automatic updates, and device pairing.

See `BACKEND.md` for the Reflect Cloud integration contract.
See `ADDON-SDK.md` for the add-on manifest and lifecycle contract.
