# Reflect Cloud Backend Contract

Reflect OS includes a local Node server so users connect add-ons through a Reflect account. Users should not provide Spotify or Google developer credentials.

## Start The Server

Copy `reflect-os.config.example.json` to `reflect-os.config.json` and enter the provider credentials once for the device. The real config is ignored by source control. Environment variables can be used instead:

```bash
cd outputs/reflect-os
REFLECT_SECRET="replace-with-a-long-random-value" \
SPOTIFY_CLIENT_ID="your-client-id" \
GOOGLE_CLIENT_ID="your-client-id" \
GOOGLE_CLIENT_SECRET="your-client-secret" \
node server.js
```

Register these callback URLs with the providers:

```text
http://127.0.0.1:4173/api/integrations/spotify/callback
http://127.0.0.1:4173/api/integrations/googleCalendar/callback
```

## Required Backend Responsibilities

- Own provider apps and secrets for Spotify and Google Calendar.
- Start OAuth flows from Reflect OS account context.
- Store access and refresh tokens server-side, encrypted per user.
- Refresh provider tokens server-side.
- Return mirror-safe add-on state to the device.

## Included Endpoints

```text
GET/POST/DELETE /api/session
GET             /api/catalog
GET/PUT         /api/user-data
GET             /api/weather
GET             /api/weather/locations
POST/DELETE     /api/addons/:provider
POST            /api/addons/:provider/disconnect
GET             /api/integrations/:provider/connect
GET             /api/integrations/:provider/callback
GET             /api/spotify/player
POST            /api/spotify/player/:action
POST            /api/spotify/player/transfer
GET             /api/spotify/search
GET             /api/spotify/recent
GET             /api/spotify/sdk-token
GET             /api/google/calendar/events
```

## Provider Notes

- Spotify users sign in with normal Spotify accounts. Reflect Cloud owns the Spotify developer app.
- Spotify uses Authorization Code with PKCE, so the mirror stores only the owner's public Spotify Client ID and no Spotify client secret.
- Google Calendar users sign in with normal Google accounts. Reflect Cloud owns the Google OAuth app.
- Provider tokens are encrypted in `data/state.json` and never exposed to the browser.
- Set a strong `REFLECT_SECRET` before connecting an account; changing it invalidates stored provider tokens.
- A hosted multi-device release should replace the local profile session with a managed account service and short-lived device tokens.
