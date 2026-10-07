#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const root = __dirname;
const port = Number(process.env.REFLECT_PORT || 4173);
const dataDir = path.join(root, "data");
const stateFile = path.join(dataDir, "state.json");
const catalogFile = path.join(root, "addons", "catalog.json");
let localConfig = {};
try { localConfig = JSON.parse(fs.readFileSync(path.join(root, "reflect-os.config.json"), "utf8")); } catch {}
let appVersion = "0.0.0";
try { appVersion = fs.readFileSync(path.join(root, "VERSION"), "utf8").trim() || appVersion; } catch {}
const oauthStates = new Map();
const pinAttempts = new Map();

function resolveSecret() {
  const configured = process.env.REFLECT_SECRET || localConfig.reflectSecret;
  if (configured && configured !== "replace-with-a-long-random-value") return configured;
  // No real secret configured: generate one once and persist it outside the web root (0600) so provider
  // tokens are never encrypted with a public constant. Removing this file invalidates stored tokens.
  const keyFile = path.join(dataDir, "secret.key");
  try { return fs.readFileSync(keyFile, "utf8").trim(); } catch {}
  const generated = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyFile, generated, { mode: 0o600 });
  console.warn("Reflect OS generated a device secret at data/secret.key. Set REFLECT_SECRET to override.");
  return generated;
}
const secret = crypto.createHash("sha256").update(resolveSecret()).digest();
const assistantConfig = {
  name: String(process.env.REFLECT_ASSISTANT_NAME || localConfig.assistantName || "Jarvis").trim() || "Jarvis",
  anthropicKey: process.env.ANTHROPIC_API_KEY || localConfig.anthropicApiKey || "",
  // Only needed for an organisation-level key that is not scoped to a workspace.
  anthropicWorkspaceId: String(process.env.ANTHROPIC_WORKSPACE_ID || localConfig.anthropicWorkspaceId || "").trim(),
  // How the assistant addresses you, Jarvis-style. Set "assistantAddress" to "ma'am", a name, or "" to use your name.
  address: String(localConfig.assistantAddress ?? "sir").trim(),
  model: process.env.REFLECT_ASSISTANT_MODEL || localConfig.assistantModel || "claude-sonnet-5-5",
  wakeWord: localConfig.assistantWakeWord !== false,
  // Optional: an OpenAI key upgrades the spoken voice and enables server-side speech recognition
  // for browsers without the Web Speech API (Chromium on Raspberry Pi).
  openaiKey: process.env.OPENAI_API_KEY || localConfig.openaiApiKey || "",
  // Optional: a voice that runs inside the mirror's browser (Kokoro), fast and free with no other app.
  // Set builtInVoice to one of bm_george, bm_fable, bm_lewis, bm_daniel, bf_emma, bf_isabella, bf_alice, bf_lily.
  builtInVoice: String(localConfig.builtInVoice || "").trim(),
  // Optional: VoiceStudio (github.com/debpalash/VoiceStudio) runs a natural voice free on this computer.
  // Set voiceStudioUrl (its app serves http://127.0.0.1:3900) and voiceStudioVoice to a saved voice profile.
  // It takes priority over ElevenLabs and OpenAI.
  voiceStudioUrl: String(localConfig.voiceStudioUrl || "").trim().replace(/\/+$/, ""),
  voiceStudioVoice: String(localConfig.voiceStudioVoice || "").trim(),
  voiceStudioModel: String(localConfig.voiceStudioModel || "").trim(),
  voiceStudioKey: String(localConfig.voiceStudioApiKey || "").trim(),
  // Optional: an ElevenLabs key gives the most natural, film-like voice. It takes priority over OpenAI's voice.
  elevenLabsKey: process.env.ELEVENLABS_API_KEY || localConfig.elevenLabsApiKey || "",
  elevenLabsVoice: String(localConfig.elevenLabsVoiceId || "").trim() || "JBFqnCBsd6RMkjVDRZzb",
  elevenLabsModel: localConfig.elevenLabsModel || "eleven_flash_v2_5",
  voice: localConfig.assistantVoice || "fable",
  ttsModel: localConfig.assistantTtsModel || "gpt-4o-mini-tts",
  sttModel: localConfig.assistantSttModel || "whisper-1"
};

const providers = {
  spotify: {
    clientId: process.env.SPOTIFY_CLIENT_ID || localConfig.spotifyClientId,
    authorize: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scopes: "streaming user-read-email user-read-private user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state"
  },
  googleCalendar: {
    clientId: process.env.GOOGLE_CLIENT_ID || localConfig.googleClientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || localConfig.googleClientSecret,
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: "openid email https://www.googleapis.com/auth/calendar.readonly"
  }
};

function readCatalog() {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
  if (!Array.isArray(catalog)) throw new Error("Add-on catalogue is invalid");
  return catalog.filter((addon) => addon && /^[A-Za-z0-9_-]+$/.test(addon.id));
}

function catalogEntry(id) {
  return readCatalog().find((addon) => addon.id === id);
}

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
}

function verifyPin(pin, saved) {
  const [salt, expected] = String(saved || "").split(":");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(pin, salt, 32);
  const target = Buffer.from(expected, "hex");
  return actual.length === target.length && crypto.timingSafeEqual(actual, target);
}

let lastStateSerialized = null;
function readState() {
  let raw;
  try { raw = fs.readFileSync(stateFile, "utf8"); }
  catch { return { accounts: {}, sessions: {} }; }
  try { const parsed = JSON.parse(raw); lastStateSerialized = raw; return parsed; }
  catch {
    // Never silently discard a corrupt state file (that would wipe every account/token). Preserve it
    // for recovery and start clean. Atomic writes below make this path very unlikely in practice.
    try { fs.renameSync(stateFile, `${stateFile}.corrupt-${Date.now()}`); } catch {}
    return { accounts: {}, sessions: {} };
  }
}

function writeState(state) {
  const serialized = JSON.stringify(state, null, 2);
  if (serialized === lastStateSerialized) return; // unchanged: skip the write to reduce SD-card wear
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${stateFile}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, serialized); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, stateFile); // atomic: readers see either the old or the new file, never a partial write
  lastStateSerialized = serialized;
}

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(".");
}

function decrypt(value) {
  const [iv, tag, body] = String(value || "").split(".").map((item) => Buffer.from(item, "base64"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret, iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8"));
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter((pair) => pair[0]));
}

function currentAccount(req) {
  const state = readState();
  const entry = state.sessions?.[cookies(req).reflect_session];
  const id = typeof entry === "string" ? entry : entry?.id; // support legacy string sessions
  if (!id) return null;
  if (entry && typeof entry === "object" && entry.expires && entry.expires < Date.now()) return null;
  return state.accounts[id] ? { id, state, account: state.accounts[id] } : null;
}

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}

function redirect(res, url) {
  res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
  res.end();
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function publicAccount(record, id) {
  return { id, name: record.name, email: record.email, addOns: record.addOns || {} };
}

async function refreshProvider(accountRecord, providerId) {
  const provider = providers[providerId];
  const saved = accountRecord.tokens?.[providerId];
  if (!saved) return null;
  let token = decrypt(saved);
  if (token.expiresAt > Date.now() + 60000) return token;
  if (!token.refresh_token) throw new Error("Provider session expired");
  const refreshParams = { grant_type: "refresh_token", refresh_token: token.refresh_token, client_id: provider.clientId };
  if (providerId !== "spotify") refreshParams.client_secret = provider.clientSecret;
  const response = await fetch(provider.token, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(refreshParams)
  });
  if (!response.ok) throw new Error("Could not refresh provider session");
  const refreshed = await response.json();
  token = { ...token, ...refreshed, expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000 };
  accountRecord.tokens[providerId] = encrypt(token);
  return token;
}

// The devices the mirror shows, and the parts of each one it needs, in one compact shape.
const haDomains = new Set(["light", "switch", "climate", "lock", "cover", "fan", "scene", "script", "sensor", "binary_sensor", "media_player", "camera", "alarm_control_panel"]);
function haEntity(entity, areas) {
  const domain = String(entity?.entity_id || "").split(".")[0];
  if (!haDomains.has(domain)) return null;
  const a = entity.attributes || {};
  const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
  return {
    id: entity.entity_id, domain, name: a.friendly_name || entity.entity_id, state: entity.state,
    unit: a.unit_of_measurement || "", deviceClass: a.device_class || "",
    brightness: a.brightness ?? null, temperature: a.temperature ?? null,
    currentTemperature: a.current_temperature ?? null, hvacAction: a.hvac_action || "",
    position: a.current_position ?? null,
    media: domain === "media_player" ? { title: a.media_title || "", artist: a.media_artist || "", volume: a.volume_level ?? null, source: a.source || "" } : null,
    areaId: areas[entity.entity_id]?.id || "", area: areas[entity.entity_id]?.name || "",
    rgb: Array.isArray(a.rgb_color) ? a.rgb_color : null,
    colorTemp: a.color_temp_kelvin ?? null,
    canColor: modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m)),
    canTemp: modes.includes("color_temp"),
    canDim: modes.some((m) => m !== "onoff")
  };
}

// Live updates: the server keeps the Home Assistant token, opens Home Assistant's WebSocket, and passes each
// device change on to the mirror's browser as a server-sent event, so the screen changes the moment the house does.
function homeAssistantStream(req, res, config) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  let socket = null, closed = false, nextId = 1, retry = null;
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25000);
  const connect = () => {
    if (closed) return;
    try { socket = new WebSocket(`${config.baseUrl.replace(/^http/, "ws")}/api/websocket`); } catch (error) { send("status", { live: false, error: error.message }); return; }
    socket.addEventListener("message", async (message) => {
      let data; try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: config.token }));
      else if (data.type === "auth_invalid") { send("status", { live: false, error: "Home Assistant refused the token." }); socket.close(); }
      else if (data.type === "auth_ok") { socket.send(JSON.stringify({ id: nextId++, type: "subscribe_events", event_type: "state_changed" })); send("status", { live: true }); }
      else if (data.type === "event" && data.event?.data?.new_state) {
        const entity = haEntity(data.event.data.new_state, await homeAssistantAreas(config));
        if (entity) send("entity", entity);
      } else if (data.type === "event" && data.event?.data && !data.event.data.new_state) send("removed", { id: data.event.data.entity_id });
    });
    socket.addEventListener("close", () => { if (closed) return; send("status", { live: false }); retry = setTimeout(connect, 5000); });
    socket.addEventListener("error", () => {});
  };
  connect();
  req.on("close", () => { closed = true; clearInterval(keepAlive); clearTimeout(retry); try { socket?.close(); } catch {} });
}

// Rooms come from Home Assistant's areas. The REST API has no area list, so a template prints
// "entity|area id|area name" lines. Older servers without area support just get no rooms.
let haAreaCache = { key: "", at: 0, map: {} };
async function homeAssistantAreas(config) {
  if (haAreaCache.key === config.baseUrl && Date.now() - haAreaCache.at < 300000) return haAreaCache.map;
  const template = "{% for s in states %}{% set a = area_id(s.entity_id) %}{% if a %}{{ s.entity_id }}|{{ a }}|{{ area_name(a) }}\n{% endif %}{% endfor %}";
  const map = {};
  try {
    const response = await fetch(`${config.baseUrl}/api/template`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ template }) });
    if (response.ok) for (const line of (await response.text()).split("\n")) {
      const [entity, id, name] = line.split("|");
      if (entity && id) map[entity.trim()] = { id: id.trim(), name: (name || id).trim() };
    }
  } catch {}
  haAreaCache = { key: config.baseUrl, at: Date.now(), map };
  return map;
}

async function api(req, res, url) {
  if (url.pathname === "/api/session" && req.method === "GET") {
    const session = currentAccount(req);
    return json(res, 200, { signedIn: Boolean(session), account: session ? publicAccount(session.account, session.id) : null });
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, { ok: true, version: appVersion, spotifyConfigured: Boolean(providers.spotify.clientId), googleConfigured: Boolean(providers.googleCalendar.clientId && providers.googleCalendar.clientSecret) });
  }
  if (url.pathname === "/api/catalog" && req.method === "GET") {
    return json(res, 200, { addOns: readCatalog() });
  }
  if (url.pathname === "/api/weather/locations" && req.method === "GET") {
    const query = String(url.searchParams.get("q") || "").trim();
    if (query.length < 2) return json(res, 400, { error: "Type at least two letters." });
    try {
      const locationUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
      locationUrl.search = new URLSearchParams({ name: query, count: "6", language: "en", format: "json" }).toString();
      const response = await fetch(locationUrl);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: "Location search is temporarily unavailable." });
      const locations = (result.results || []).map((place) => ({ id: place.id, name: place.name, region: place.admin1 || "", country: place.country || "", latitude: place.latitude, longitude: place.longitude, timezone: place.timezone || "" }));
      return json(res, 200, { locations });
    } catch { return json(res, 502, { error: "Location search is temporarily unavailable." }); }
  }
  if (url.pathname === "/api/weather" && req.method === "GET") {
    const latitude = Number(url.searchParams.get("lat"));
    const longitude = Number(url.searchParams.get("lon"));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return json(res, 400, { error: "Choose a valid weather location." });
    try {
      const weatherUrl = new URL("https://api.open-meteo.com/v1/forecast");
      weatherUrl.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: "temperature_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m,wind_direction_10m", hourly: "temperature_2m,precipitation_probability,weather_code", daily: "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max", timezone: "auto", forecast_days: "7" }).toString();
      const response = await fetch(weatherUrl);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: "Live weather is temporarily unavailable." });
      return json(res, 200, result);
    } catch { return json(res, 502, { error: "Live weather is temporarily unavailable." }); }
  }
  if (url.pathname === "/api/session" && req.method === "POST") {
    const input = await body(req);
    const email = String(input.email || "").trim().toLowerCase();
    const name = String(input.name || "").trim();
    const pin = String(input.pin || "").trim();
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !/^\d{4,8}$/.test(pin)) return json(res, 400, { error: "Enter your name, email and a 4 to 8 digit PIN." });
    const id = crypto.createHash("sha256").update(email).digest("hex").slice(0, 20);
    const state = readState();
    const existing = state.accounts[id];
    const attempt = pinAttempts.get(id);
    if (attempt && attempt.until > Date.now()) return json(res, 429, { error: "Too many incorrect PIN attempts. Wait a moment and try again." });
    if (existing?.pinHash && !verifyPin(pin, existing.pinHash)) {
      const count = (attempt?.count || 0) + 1;
      pinAttempts.set(id, { count, until: count >= 5 ? Date.now() + Math.min(15 * 60000, (count - 4) * 30000) : 0 });
      return json(res, 401, { error: "That PIN is not correct." });
    }
    pinAttempts.delete(id);
    state.accounts[id] = { name, email, pinHash: existing?.pinHash || hashPin(pin), addOns: existing?.addOns || { weather: { installed: true, enabled: true, connectionStatus: "connected", lastSync: "Live forecast" } }, tokens: existing?.tokens || {}, data: existing?.data || { tasks: [], events: [] } };
    writeState(state);
    const sessionId = crypto.randomBytes(24).toString("hex");
    state.sessions = state.sessions || {};
    const now = Date.now();
    const maxAge = 60 * 60 * 24 * 365; // 1 year: survive kiosk reboots without forcing a re-PIN
    for (const [key, value] of Object.entries(state.sessions)) { if (value && typeof value === "object" && value.expires && value.expires < now) delete state.sessions[key]; }
    state.sessions[sessionId] = { id, expires: now + maxAge * 1000 };
    writeState(state);
    return json(res, 200, { signedIn: true, account: publicAccount(state.accounts[id], id) }, { "Set-Cookie": `reflect_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}` });
  }
  if (url.pathname === "/api/session" && req.method === "DELETE") {
    const state = readState();
    if (state.sessions) delete state.sessions[cookies(req).reflect_session];
    writeState(state);
    return json(res, 200, { signedIn: false }, { "Set-Cookie": "reflect_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

  if (url.pathname.startsWith("/api/assistant/")) return assistantApi(req, res, url);

  const session = currentAccount(req);
  if (!session) return json(res, 401, { error: "Sign in to Reflect OS first." });
  if (url.pathname === "/api/user-data" && req.method === "GET") {
    return json(res, 200, session.account.data || { tasks: [], events: [] });
  }
  if (url.pathname === "/api/user-data" && req.method === "PUT") {
    const input = await body(req);
    const tasks = Array.isArray(input.tasks) ? input.tasks.slice(0, 100) : [];
    const events = Array.isArray(input.events) ? input.events.slice(0, 100) : [];
    session.account.data = { tasks, events };
    writeState(session.state);
    return json(res, 200, session.account.data);
  }

  // Home Assistant uses a user-pasted long-lived access token rather than OAuth.
  if (url.pathname === "/api/integrations/homeAssistant/config" && req.method === "POST") {
    const input = await body(req);
    const baseUrl = String(input.baseUrl || "").trim().replace(/\/+$/, "");
    const token = String(input.token || "").trim();
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl) || !token) return json(res, 400, { error: "Enter your Home Assistant URL and a long-lived access token." });
    let ok = false;
    try { const check = await fetch(`${baseUrl}/api/`, { headers: { Authorization: `Bearer ${token}` } }); ok = check.ok; } catch {}
    if (!ok) return json(res, 502, { error: "Could not reach Home Assistant with those details. Check the URL and token." });
    session.account.tokens = session.account.tokens || {};
    session.account.tokens.smartHome = encrypt({ baseUrl, token });
    session.account.addOns.smartHome = { ...(session.account.addOns.smartHome || {}), installed: true, enabled: true, connectionStatus: "connected", lastSync: new Date().toISOString() };
    writeState(session.state);
    return json(res, 200, session.account.addOns.smartHome);
  }
  if (url.pathname === "/api/homeassistant/states" && req.method === "GET") {
    const config = session.account.tokens?.smartHome ? decrypt(session.account.tokens.smartHome) : null;
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    try {
      const response = await fetch(`${config.baseUrl}/api/states`, { headers: { Authorization: `Bearer ${config.token}` } });
      if (!response.ok) return json(res, response.status, { error: "Home Assistant sync failed." });
      const all = await response.json();
      const areas = await homeAssistantAreas(config);
      const entities = (Array.isArray(all) ? all : []).map((entity) => haEntity(entity, areas)).filter(Boolean);
      return json(res, 200, { entities, syncedAt: new Date().toISOString() });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/homeassistant/stream" && req.method === "GET") {
    const config = session.account.tokens?.smartHome ? decrypt(session.account.tokens.smartHome) : null;
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    return homeAssistantStream(req, res, config);
  }
  // Camera feeds come through the mirror's server so the Home Assistant token never reaches the browser.
  const cameraMatch = url.pathname.match(/^\/api\/homeassistant\/camera\/(camera\.[a-z0-9_]+)$/);
  if (cameraMatch && req.method === "GET") {
    const config = session.account.tokens?.smartHome ? decrypt(session.account.tokens.smartHome) : null;
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    const still = url.searchParams.get("still") === "1";
    const controller = new AbortController();
    req.on("close", () => controller.abort());
    try {
      const response = await fetch(`${config.baseUrl}/api/${still ? "camera_proxy" : "camera_proxy_stream"}/${cameraMatch[1]}`, { headers: { Authorization: `Bearer ${config.token}` }, signal: controller.signal });
      if (!response.ok || !response.body) return json(res, response.status || 502, { error: "That camera isn't available." });
      res.writeHead(200, { "Content-Type": response.headers.get("content-type") || "image/jpeg", "Cache-Control": "no-store" });
      for await (const chunk of response.body) { if (!res.write(chunk)) await new Promise((r) => res.once("drain", r)); }
      return res.end();
    } catch (error) { if (!res.headersSent) return json(res, 502, { error: error.message }); return res.end(); }
  }
  if (url.pathname === "/api/homeassistant/service" && req.method === "POST") {
    const config = session.account.tokens?.smartHome ? decrypt(session.account.tokens.smartHome) : null;
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    const input = await body(req);
    if (!/^[a-z_]+\.[a-z_0-9]+$/.test(String(input.service || ""))) return json(res, 400, { error: "Invalid service." });
    const [domain, service] = input.service.split(".");
    try {
      const response = await fetch(`${config.baseUrl}/api/services/${domain}/${service}`, { method: "POST", headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input.data && typeof input.data === "object" ? input.data : {}) });
      if (!response.ok) return json(res, response.status, { error: "Home Assistant could not run that action." });
      return json(res, 200, { ok: true });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  const addonMatch = url.pathname.match(/^\/api\/addons\/([A-Za-z0-9_-]+)$/);
  if (addonMatch && req.method === "POST") {
    const id = addonMatch[1];
    const addon = catalogEntry(id);
    if (!addon) return json(res, 404, { error: "That add-on is not available." });
    session.account.addOns[id] = { ...(session.account.addOns[id] || {}), installed: true, enabled: true, connectionStatus: id === "weather" || id === "photos" ? "connected" : "disconnected", lastSync: id === "photos" ? "Stored on this mirror" : "" };
    writeState(session.state);
    return json(res, 200, session.account.addOns[id]);
  }
  if (addonMatch && req.method === "DELETE") {
    const id = addonMatch[1];
    const addon = catalogEntry(id);
    if (!addon) return json(res, 404, { error: "That add-on is not available." });
    if (addon.preinstalled) return json(res, 409, { error: "This system add-on cannot be uninstalled." });
    delete session.account.addOns[id];
    if (session.account.tokens) delete session.account.tokens[id];
    writeState(session.state);
    return json(res, 200, { installed: false });
  }
  const disconnectMatch = url.pathname.match(/^\/api\/addons\/([A-Za-z0-9_-]+)\/disconnect$/);
  if (disconnectMatch && req.method === "POST") {
    const id = disconnectMatch[1];
    if (session.account.tokens) delete session.account.tokens[id];
    session.account.addOns[id] = { ...(session.account.addOns[id] || {}), installed: true, enabled: true, connectionStatus: "disconnected", lastSync: "" };
    writeState(session.state);
    return json(res, 200, session.account.addOns[id]);
  }

  const connectMatch = url.pathname.match(/^\/api\/integrations\/(spotify|googleCalendar)\/connect$/);
  if (connectMatch && req.method === "GET") {
    const id = connectMatch[1];
    const provider = providers[id];
    const configured = id === "spotify" ? provider.clientId : provider.clientId && provider.clientSecret;
    if (!configured) return json(res, 503, { error: id === "spotify" ? "Spotify needs the Reflect owner's Client ID before accounts can connect." : "Google Calendar is not configured on this Reflect device." });
    for (const [key, value] of oauthStates) { if (Date.now() - value.createdAt > 600000) oauthStates.delete(key); }
    const stateValue = crypto.randomBytes(24).toString("hex");
    const verifier = id === "spotify" ? crypto.randomBytes(64).toString("base64url") : "";
    oauthStates.set(stateValue, { accountId: session.id, providerId: id, verifier, createdAt: Date.now() });
    const redirectUri = `http://127.0.0.1:${port}/api/integrations/${id}/callback`;
    const params = new URLSearchParams({ response_type: "code", client_id: provider.clientId, redirect_uri: redirectUri, scope: provider.scopes, state: stateValue });
    if (id === "spotify") {
      params.set("code_challenge_method", "S256");
      params.set("code_challenge", crypto.createHash("sha256").update(verifier).digest("base64url"));
    }
    if (id === "googleCalendar") { params.set("access_type", "offline"); params.set("prompt", "consent"); }
    return redirect(res, `${provider.authorize}?${params}`);
  }
  const callbackMatch = url.pathname.match(/^\/api\/integrations\/(spotify|googleCalendar)\/callback$/);
  if (callbackMatch && req.method === "GET") {
    const id = callbackMatch[1];
    const pending = oauthStates.get(url.searchParams.get("state"));
    oauthStates.delete(url.searchParams.get("state"));
    if (!pending || pending.providerId !== id || Date.now() - pending.createdAt > 600000) return redirect(res, "/index.html?integration=failed");
    const provider = providers[id];
    const redirectUri = `http://127.0.0.1:${port}/api/integrations/${id}/callback`;
    const tokenParams = { grant_type: "authorization_code", code: url.searchParams.get("code") || "", redirect_uri: redirectUri, client_id: provider.clientId };
    if (id === "spotify") tokenParams.code_verifier = pending.verifier;
    else tokenParams.client_secret = provider.clientSecret;
    const tokenResponse = await fetch(provider.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(tokenParams) });
    if (!tokenResponse.ok) return redirect(res, `/index.html?integration=${id}&status=failed`);
    const token = await tokenResponse.json();
    token.expiresAt = Date.now() + (token.expires_in || 3600) * 1000;
    const state = readState();
    const account = state.accounts[pending.accountId];
    account.tokens = account.tokens || {};
    account.tokens[id] = encrypt(token);
    account.addOns[id] = { installed: true, enabled: true, connectionStatus: "connected", lastSync: new Date().toISOString() };
    writeState(state);
    return redirect(res, `/index.html?integration=${id}&status=connected`);
  }

  if (url.pathname === "/api/spotify/player" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const response = await fetch("https://api.spotify.com/v1/me/player", { headers: { Authorization: `Bearer ${token.access_token}` } });
      if (response.status === 204) return json(res, 200, { item: null });
      return json(res, response.status, await response.json());
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/google/calendar/events" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "googleCalendar");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Google Calendar first." });
      const calendarUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
      calendarUrl.search = new URLSearchParams({ timeMin: new Date().toISOString(), maxResults: "20", singleEvents: "true", orderBy: "startTime" }).toString();
      const response = await fetch(calendarUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: result.error?.message || "Google Calendar sync failed." });
      const events = (result.items || []).map((event) => ({ id: event.id, start: event.start?.dateTime || event.start?.date || "", end: event.end?.dateTime || event.end?.date || "", title: event.summary || "Untitled event", location: event.location || "", allDay: Boolean(event.start?.date) }));
      return json(res, 200, { events, syncedAt: new Date().toISOString() });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/spotify/sdk-token" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const scopes = new Set(String(token.scope || "").split(/\s+/));
      if (!scopes.has("streaming")) return json(res, 409, { error: "Reconnect Spotify once to enable playback through Reflect OS.", code: "streaming_permission_required" });
      return json(res, 200, { access_token: token.access_token, expires_at: token.expiresAt });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/spotify/search" && req.method === "GET") {
    try {
      const query = String(url.searchParams.get("q") || "").trim();
      if (!query) return json(res, 400, { error: "Enter a song or artist." });
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const spotifyUrl = new URL("https://api.spotify.com/v1/search");
      spotifyUrl.search = new URLSearchParams({ q: query, type: "track", limit: "10" }).toString();
      const response = await fetch(spotifyUrl, { headers: { Authorization: `Bearer ${token.access_token}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: result.error?.message || "Spotify search failed." });
      const tracks = (result.tracks?.items || []).map((track) => ({ id: track.id, uri: track.uri, name: track.name, artists: track.artists?.map((artist) => artist.name).join(", ") || "Spotify", album: track.album?.name || "", artwork: track.album?.images?.find((image) => image.width <= 300)?.url || track.album?.images?.at(-1)?.url || "", spotifyUrl: track.external_urls?.spotify || "" }));
      return json(res, 200, { tracks });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/spotify/recent" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const scopes = new Set(String(token.scope || "").split(/\s+/));
      if (!scopes.has("user-read-recently-played")) return json(res, 409, { error: "Reconnect Spotify once to show recently played tracks.", code: "recent_permission_required" });
      const response = await fetch("https://api.spotify.com/v1/me/player/recently-played?limit=12", { headers: { Authorization: `Bearer ${token.access_token}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: result.error?.message || "Recently played could not be loaded." });
      const seen = new Set();
      const tracks = (result.items || []).map((item) => item.track).filter((track) => track?.id && !seen.has(track.id) && seen.add(track.id)).map((track) => ({ id: track.id, uri: track.uri, name: track.name, artists: track.artists?.map((artist) => artist.name).join(", ") || "Spotify", album: track.album?.name || "", artwork: track.album?.images?.find((image) => image.width <= 300)?.url || track.album?.images?.at(-1)?.url || "", spotifyUrl: track.external_urls?.spotify || "" }));
      return json(res, 200, { tracks });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/spotify/player/transfer" && req.method === "POST") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const input = await body(req);
      if (!input.deviceId) return json(res, 400, { error: "Reflect OS player is not ready yet." });
      const response = await fetch("https://api.spotify.com/v1/me/player", { method: "PUT", headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ device_ids: [input.deviceId], play: true }) });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not move playback to this mirror." });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  // Every place Spotify can play right now (the Spotify app on a computer or phone, a speaker, this
  // mirror's own player), so Jarvis can send music somewhere that is actually switched on.
  if (url.pathname === "/api/spotify/devices" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const response = await fetch("https://api.spotify.com/v1/me/player/devices", { headers: { Authorization: `Bearer ${token.access_token}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: result.error?.message || "Spotify devices could not be loaded." });
      return json(res, 200, { devices: (result.devices || []).filter((d) => d.id && !d.is_restricted).map((d) => ({ id: d.id, name: d.name, type: d.type, active: Boolean(d.is_active), volume: d.supports_volume === false ? null : d.volume_percent ?? null })) });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  // Turns music down while Jarvis listens and talks, and back up afterwards.
  if (url.pathname === "/api/spotify/player/volume" && req.method === "POST") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const input = await body(req);
      const volume = Math.max(0, Math.min(100, Math.round(Number(input.volume))));
      if (!Number.isFinite(volume)) return json(res, 400, { error: "Invalid volume." });
      const spotifyUrl = new URL("https://api.spotify.com/v1/me/player/volume");
      spotifyUrl.searchParams.set("volume_percent", String(volume));
      if (input.deviceId) spotifyUrl.searchParams.set("device_id", String(input.deviceId));
      const response = await fetch(spotifyUrl, { method: "PUT", headers: { Authorization: `Bearer ${token.access_token}` } });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not change the volume." });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/spotify/playlists" && req.method === "GET") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const response = await fetch("https://api.spotify.com/v1/me/playlists?limit=30", { headers: { Authorization: `Bearer ${token.access_token}` } });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, response.status, { error: result.error?.message || "Your playlists could not be loaded." });
      const playlists = (result.items || []).filter((item) => item && item.uri).map((item) => ({ id: item.id, uri: item.uri, name: item.name || "Playlist", owner: item.owner?.display_name || "", tracks: item.tracks?.total ?? 0, artwork: item.images?.find((image) => (image.width || 0) <= 300)?.url || item.images?.at(-1)?.url || "" }));
      return json(res, 200, { playlists });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  const playerMatch = url.pathname.match(/^\/api\/spotify\/player\/(play|pause|next|previous)$/);
  if (playerMatch && req.method === "POST") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const action = playerMatch[1];
      const method = action === "next" || action === "previous" ? "POST" : "PUT";
      const input = await body(req);
      const spotifyUrl = new URL(`https://api.spotify.com/v1/me/player/${action}`);
      if (input.deviceId) spotifyUrl.searchParams.set("device_id", input.deviceId);
      const requestBody = action === "play" ? (input.uri ? JSON.stringify({ uris: [input.uri] }) : input.contextUri ? JSON.stringify({ context_uri: input.contextUri }) : undefined) : undefined;
      const response = await fetch(spotifyUrl, { method, headers: { Authorization: `Bearer ${token.access_token}`, ...(requestBody ? { "Content-Type": "application/json" } : {}) }, body: requestBody });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not complete that action." });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  return json(res, 404, { error: "Not found" });
}

function voiceProvider() {
  return assistantConfig.voiceStudioUrl ? "VoiceStudio" : assistantConfig.elevenLabsKey ? "ElevenLabs" : assistantConfig.openaiKey ? "OpenAI" : "";
}

function assistantSystemPrompt() {
  const name = assistantConfig.name;
  return `You are ${name}, the AI that lives in a smart mirror called Reflect. Think of the AI butler from the Iron Man films: calm, quick, quietly witty and unfailingly competent, with a dry British manner.

Everything you write is spoken aloud by a text-to-speech voice and shown briefly on the mirror, so:
- Answer in one to three short spoken sentences. Lead with the answer. No lists, no markdown, no emoji, no URLs.
- Say numbers, times and temperatures the way a person would say them out loud.
- A touch of dry humour is welcome; never let it get in the way of the answer.
- ${assistantConfig.address ? `Address the person as "${assistantConfig.address}" now and then, the way the butler addresses Tony Stark; use their name only occasionally.` : "Use the person's name now and then, not in every reply."}

Each user turn starts with a [Mirror context] block holding the live time, weather, calendar, tasks, music and smart-home devices. Treat it as what you can see right now and answer from it directly. Text after "They said:" is what the person actually said, transcribed from speech, so allow for misheard words.

When the context says "First conversation today: yes", open with a one-sentence greeting for the time of day that mentions the weather and the next thing on the calendar or task list, then answer what they said.

Use your tools to act on the mirror: change screens, control smart-home devices, control music, add, change, complete or delete tasks, add or delete calendar events, set timers and reminders, change the weather location, show or hide home widgets, and adjust the display. Use web search for anything live or recent the context does not cover, such as news, sport scores, opening times or prices, and give the answer in a sentence or two without reading out sources. When asked to do something, do it and confirm in a few words. If a device or feature in the request is not in the context, say so briefly rather than guessing. Only act on smart-home devices whose entity id appears in the context. For anything outside what the mirror can do, answer from your own knowledge as a helpful assistant would.`;
}

const assistantTools = [
  { name: "show_screen", description: "Switch the mirror to one of its screens.", input_schema: { type: "object", properties: { screen: { type: "string", enum: ["home", "calendar", "tasks", "music", "weather", "smart_home", "settings"] } }, required: ["screen"], additionalProperties: false } },
  { name: "control_device", description: "Control Home Assistant devices listed in the mirror context. Target one device with entity_id, or a whole room with area_id (all its lights by default, or the domain given). Use turn_on/turn_off/toggle for lights, switches and fans; with turn_on on lights, brightness_pct sets brightness, color sets a colour (a CSS colour name like red, blue, purple, orange) and kelvin sets white temperature (2200 warm, 4000 neutral, 6500 cool). Use activate for scenes (e.g. Hue scenes), lock/unlock for locks, open/close for covers and set_temperature (with temperature) for climate. Call it once per room or device; several calls in one turn are fine.", input_schema: { type: "object", properties: { entity_id: { type: "string", description: "Exact entity id from the context, e.g. light.living_room" }, area_id: { type: "string", description: "Room id from the context, e.g. living_room, to control the whole room" }, domain: { type: "string", enum: ["light", "switch", "fan", "cover"], description: "With area_id: which kind of device in the room. Defaults to light." }, action: { type: "string", enum: ["turn_on", "turn_off", "toggle", "activate", "lock", "unlock", "open", "close", "set_temperature"] }, brightness_pct: { type: "integer", minimum: 1, maximum: 100 }, color: { type: "string" }, kelvin: { type: "integer", minimum: 2000, maximum: 6500 }, temperature: { type: "number" } }, required: ["action"], additionalProperties: false } },
  { name: "music", description: "Control Spotify on the mirror. play resumes, pause pauses, next/previous skip, play_search finds and plays a song, artist or album from query.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "next", "previous", "play_search"] }, query: { type: "string" } }, required: ["action"], additionalProperties: false } },
  { name: "add_task", description: "Add a task to the mirror's task list.", input_schema: { type: "object", properties: { title: { type: "string" }, category: { type: "string", enum: ["Home", "Work", "Health", "Personal"] }, when: { type: "string", enum: ["Today", "Upcoming"] }, high_priority: { type: "boolean" } }, required: ["title"], additionalProperties: false } },
  { name: "complete_task", description: "Mark a task from the context as done.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } },
  { name: "add_event", description: "Add an event to the mirror's on-device calendar.", input_schema: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24-hour" }, location: { type: "string" } }, required: ["title", "date", "time"], additionalProperties: false } },
  { name: "update_task", description: "Change a task from the context: mark it done or not done, rename it, move it between Today and Upcoming, change priority, or delete it.", input_schema: { type: "object", properties: { task_id: { type: "string" }, done: { type: "boolean" }, title: { type: "string" }, when: { type: "string", enum: ["Today", "Upcoming"] }, high_priority: { type: "boolean" }, delete: { type: "boolean" } }, required: ["task_id"], additionalProperties: false } },
  { name: "delete_event", description: "Delete an on-device calendar event from the context by its id. Google Calendar events cannot be deleted from the mirror.", input_schema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false } },
  { name: "set_timer", description: "Start a countdown timer. The mirror chimes and you announce it when it ends.", input_schema: { type: "object", properties: { minutes: { type: "number", minimum: 0 }, seconds: { type: "number", minimum: 0 }, label: { type: "string", description: "Short name, e.g. pasta" } }, additionalProperties: false } },
  { name: "set_reminder", description: "Remind the person about something at a set time today or on a date. The mirror chimes and you say the reminder out loud at that time.", input_schema: { type: "object", properties: { text: { type: "string", description: "What to remind them about" }, time: { type: "string", description: "HH:MM, 24-hour" }, date: { type: "string", description: "YYYY-MM-DD; omit for the next time that clock time comes round" } }, required: ["text", "time"], additionalProperties: false } },
  { name: "cancel_timer", description: "Cancel a running timer or reminder from the context by id, or all of them.", input_schema: { type: "object", properties: { id: { type: "string", description: "Timer or reminder id, or \"all\"" } }, required: ["id"], additionalProperties: false } },
  { name: "set_weather_location", description: "Change the town or city the mirror shows weather for.", input_schema: { type: "object", properties: { place: { type: "string" } }, required: ["place"], additionalProperties: false } },
  { name: "show_widget", description: "Show or hide a widget on the mirror's home screen.", input_schema: { type: "object", properties: { widget: { type: "string", enum: ["clock", "weather", "calendar", "tasks", "affirmations", "music", "smartHome", "photos"] }, visible: { type: "boolean" } }, required: ["widget", "visible"], additionalProperties: false } },
  { name: "change_voice", description: "Change the voice you speak with, when asked. Without a name, moves to the next available voice; with a name, picks the voice whose name contains it. Tell the person the new voice's name in a few words.", input_schema: { type: "object", properties: { name: { type: "string", description: "Part of a voice name, such as Daniel or Jamie. Leave out to try the next voice." } }, additionalProperties: false } },
  { name: "set_display", description: "Adjust the mirror display: brightness from 30 to 100, and night mode on or off.", input_schema: { type: "object", properties: { brightness: { type: "integer", minimum: 30, maximum: 100 }, night_mode: { type: "boolean" } }, additionalProperties: false } },
  // Runs on Anthropic's servers: news, sport, opening times, prices and anything else live.
  { type: "web_search_20260209", name: "web_search", max_uses: 3 }
];

function sameOriginRequest(req) {
  // Browsers only allow cross-site requests without a CORS preflight for "simple" content types,
  // so requiring JSON/audio bodies plus a loopback Origin keeps other websites from spending API credit.
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return allowedHost({ headers: { host: new URL(origin).host } }); } catch { return false; }
}

async function rawBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("That recording is too long."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function assistantApi(req, res, url) {
  if (url.pathname === "/api/assistant/status" && req.method === "GET") {
    return json(res, 200, { configured: Boolean(assistantConfig.anthropicKey), name: assistantConfig.name, wakeWord: assistantConfig.wakeWord, serverVoice: Boolean(voiceProvider()), voiceProvider: assistantConfig.builtInVoice ? "built-in" : voiceProvider(), builtInVoice: assistantConfig.builtInVoice, serverTranscription: Boolean(assistantConfig.openaiKey) });
  }
  if (req.method !== "POST") return json(res, 404, { error: "Not found" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "Forbidden" });
  const type = String(req.headers["content-type"] || "");

  if (url.pathname === "/api/assistant/chat") {
    if (!type.startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
    if (!assistantConfig.anthropicKey) return json(res, 503, { error: `Add an anthropicApiKey to reflect-os.config.json to wake ${assistantConfig.name}.` });
    const input = await body(req);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (!messages.length || messages.length > 60 || messages.some((m) => !m || !["user", "assistant"].includes(m.role) || !Array.isArray(m.content))) return json(res, 400, { error: "Invalid conversation." });
    try {
      const started = Date.now();
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": assistantConfig.anthropicKey, "anthropic-version": "2023-06-01", "anthropic-beta": "server-side-fallback-2026-07-01", ...(assistantConfig.anthropicWorkspaceId ? { "anthropic-workspace-id": assistantConfig.anthropicWorkspaceId } : {}) },
        // The system prompt and tools are the same on every request, so they're cached (the explicit
        // marker), and the growing conversation is cached too (the top-level field). Both make replies quicker.
        body: JSON.stringify({ model: assistantConfig.model, max_tokens: 4096, output_config: { effort: "low" }, fallbacks: "default", cache_control: { type: "ephemeral" }, system: [{ type: "text", text: assistantSystemPrompt(), cache_control: { type: "ephemeral" } }], tools: assistantTools, messages, ...(input.stream ? { stream: true } : {}) })
      });
      // Streaming: the reply is passed straight through to the mirror as it's written, so Jarvis
      // can start speaking his first sentence while the rest is still on its way.
      if (input.stream && response.ok && response.body) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store" });
        let firstWord = 0, tail = "", usage = {}, model = "", stop = "";
        for await (const chunk of response.body) {
          res.write(chunk);
          const text = tail + Buffer.from(chunk).toString("utf8");
          const lines = text.split("\n");
          tail = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const event = JSON.parse(line.slice(5));
              if (event.type === "message_start") { model = event.message?.model || ""; usage = { ...event.message?.usage }; }
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && !firstWord) firstWord = Date.now();
              if (event.type === "message_delta") { Object.assign(usage, event.usage); stop = event.delta?.stop_reason || stop; }
            } catch {}
          }
        }
        res.end();
        console.log(`${assistantConfig.name}: first words in ${firstWord ? ((firstWord - started) / 1000).toFixed(1) : "-"}s, done in ${((Date.now() - started) / 1000).toFixed(1)}s, ${model || assistantConfig.model}, ${usage.cache_read_input_tokens || 0} cached / ${usage.input_tokens || 0} new input tokens, ${usage.output_tokens || 0} output tokens${stop ? `, ${stop}` : ""}`);
        return;
      }
      const result = await response.json().catch(() => ({}));
      const usage = result.usage || {};
      console.log(`${assistantConfig.name}: ${((Date.now() - started) / 1000).toFixed(1)}s, ${result.model || assistantConfig.model}, ${usage.cache_read_input_tokens || 0} cached / ${usage.input_tokens || 0} new input tokens, ${usage.output_tokens || 0} output tokens${result.stop_reason ? `, ${result.stop_reason}` : ""}`);
      if (!response.ok) return json(res, response.status === 401 ? 503 : 502, { error: response.status === 401 ? "The Anthropic API key in reflect-os.config.json was rejected." : result.error?.message || "The assistant is unavailable right now." });
      return json(res, 200, { content: result.content || [], stop_reason: result.stop_reason });
    } catch {
      if (res.headersSent) return res.end();
      return json(res, 502, { error: "The assistant could not reach Claude. Check the internet connection." });
    }
  }

  if (url.pathname === "/api/assistant/speak") {
    if (!type.startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
    const provider = voiceProvider(), voiceStarted = Date.now();
    if (!provider) return json(res, 409, { error: "Server voice is not configured." });
    const text = String((await body(req)).text || "").trim().slice(0, 1500);
    if (!text) return json(res, 400, { error: "Nothing to say." });
    try {
      const response = provider === "VoiceStudio"
        // VoiceStudio speaks the OpenAI speech API on this computer: a saved profile as `voice`, an engine as `model`.
        ? await fetch(`${assistantConfig.voiceStudioUrl}/v1/audio/speech`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(assistantConfig.voiceStudioKey ? { Authorization: `Bearer ${assistantConfig.voiceStudioKey}` } : {}) },
          body: JSON.stringify({ input: text, response_format: "mp3", ...(assistantConfig.voiceStudioVoice ? { voice: assistantConfig.voiceStudioVoice } : {}), ...(assistantConfig.voiceStudioModel ? { model: assistantConfig.voiceStudioModel } : {}) })
        })
        : provider === "ElevenLabs"
        ? await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(assistantConfig.elevenLabsVoice)}?output_format=mp3_44100_128`, {
          method: "POST",
          headers: { "xi-api-key": assistantConfig.elevenLabsKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: assistantConfig.elevenLabsModel, voice_settings: { stability: 0.55, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true } })
        })
        : await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: { Authorization: `Bearer ${assistantConfig.openaiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: assistantConfig.ttsModel, voice: assistantConfig.voice, input: text, response_format: "mp3", instructions: "Calm, warm and precise, with a refined British accent and a hint of dry wit, like a capable AI butler." })
        });
      if (!response.ok) { console.log(`Voice: ${provider} returned ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`); return json(res, 502, { error: "The server voice is unavailable." }); }
      const audio = Buffer.from(await response.arrayBuffer());
      console.log(`Voice: ${provider}, ${((Date.now() - voiceStarted) / 1000).toFixed(1)}s for ${text.length} characters`);
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "Content-Length": audio.length });
      return res.end(audio);
    } catch { if (provider === "VoiceStudio") console.log(`Voice: couldn't reach VoiceStudio at ${assistantConfig.voiceStudioUrl}. Is the app open?`); return json(res, 502, { error: "The server voice is unavailable." }); }
  }

  // The mirror reports how long each reply took to start talking, so the delay can be read here.
  if (url.pathname === "/api/assistant/timing") {
    const t = await body(req).catch(() => ({}));
    const secs = (ms) => (Number.isFinite(Number(ms)) && Number(ms) >= 0 ? `${(Number(ms) / 1000).toFixed(1)}s` : "-");
    console.log(`${assistantConfig.name}: started speaking ${secs(t.firstSound)} after you stopped talking (first words from Claude ${secs(t.firstText)}, voice took ${secs(t.voice)} for the first ${Number(t.chars) || 0} characters, ${String(t.engine || "unknown voice").slice(0, 60)})`);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === "/api/assistant/transcribe") {
    if (!type.startsWith("audio/")) return json(res, 415, { error: "Send audio." });
    if (!assistantConfig.openaiKey) return json(res, 409, { error: "Server speech recognition is not configured." });
    try {
      const audio = await rawBody(req, 8 * 1024 * 1024);
      const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "mp4" : type.includes("wav") ? "wav" : "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: type.split(";")[0] }), `speech.${ext}`);
      form.append("model", assistantConfig.sttModel);
      form.append("language", "en");
      const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${assistantConfig.openaiKey}` }, body: form });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) return json(res, 502, { error: "Speech recognition is unavailable." });
      return json(res, 200, { text: String(result.text || "").trim() });
    } catch (error) { return json(res, error.status || 502, { error: error.status ? error.message : "Speech recognition is unavailable." }); }
  }
  return json(res, 404, { error: "Not found" });
}

const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };
// Only these paths may be served. Everything else (config, dotfiles, /data, source-of-truth JSON) is denied,
// so provider secrets in reflect-os.config.json can never be read over HTTP.
const staticAllowList = new Set(["index.html", "app.js", "styles.css", "assistant.js", "hud-motion.js", "house.js", "voice-worker.js", "assistant.css", "addons/catalog.json"]);

function serveStatic(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, "");
  const file = path.resolve(root, relative);
  const withinRoot = file === root || file.startsWith(`${root}${path.sep}`);
  const ext = path.extname(file).toLowerCase();
  const isAsset = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"].includes(ext);
  const hasDotSegment = relative.split("/").some((part) => part.startsWith("."));
  const allowed = withinRoot && !hasDotSegment && (staticAllowList.has(relative) || isAsset);
  if (!allowed) return json(res, 403, { error: "Forbidden" });
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: "Not found" });
    res.writeHead(200, { "Content-Type": staticTypes[ext] || "application/octet-stream", "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=300" });
    res.end(data);
  });
}

function allowedHost(req) {
  // The server binds to loopback only; reject any other Host header to block DNS-rebinding attacks
  // that would otherwise reach these endpoints as a "same-origin" request from a malicious page.
  const name = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]" || name === "::1" || name === "";
}

function handleRequest(req, res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  if (!allowedHost(req)) return json(res, 403, { error: "Forbidden" });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  Promise.resolve(url.pathname.startsWith("/api/") ? api(req, res, url) : serveStatic(req, res, url)).catch((error) => json(res, 500, { error: error.message }));
}

if (require.main === module) {
  http.createServer(handleRequest).listen(port, "127.0.0.1", () => console.log(`Reflect OS running at http://127.0.0.1:${port}`));
}

module.exports = { handleRequest };
