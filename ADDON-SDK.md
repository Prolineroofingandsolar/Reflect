# Reflect OS Add-on Contract

Reflect add-ons are declared in `addons/catalog.json`. The local server owns installation state and rejects IDs that are not present in this catalogue.

## Manifest

Every entry must provide:

```json
{
  "id": "providerName",
  "name": "Provider Name",
  "icon": "P",
  "description": "One clear sentence.",
  "category": "productivity",
  "version": "1.0.0",
  "screens": ["Provider"],
  "widgets": ["Provider Summary"],
  "permissions": ["Read selected data"],
  "requiresConnection": true,
  "view": "provider"
}
```

`preinstalled` may be set for trusted system add-ons. A preinstalled add-on cannot be removed through the API.

## Lifecycle

1. `GET /api/catalog` returns safe public manifest data.
2. `POST /api/addons/:id` installs a known manifest for the signed-in account.
3. Provider OAuth is a separate connection action.
4. Widgets and screens become available only while the add-on is installed and enabled.
5. `DELETE /api/addons/:id` removes its account state and encrypted provider token.

## Next Runtime Boundary

The next SDK version should add signed packages, declarative widget schemas, isolated server adapters, capability-scoped events, compatibility ranges, automatic updates, and store validation. Add-ons should supply data and actions while Reflect OS retains control of mirror rendering.
