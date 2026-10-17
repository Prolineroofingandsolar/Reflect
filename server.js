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
const { createHomeEngine } = require("./home-engine");
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
  model: process.env.REFLECT_ASSISTANT_MODEL || localConfig.assistantModel || "claude-haiku-5-5",
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
    scopes: "streaming user-read-email user-read-private user-read-currently-playing user-read-playback-state user-read-recently-played user-modify-playback-state playlist-read-private user-library-modify user-library-read"
  },
  googleCalendar: {
    clientId: process.env.GOOGLE_CLIENT_ID || localConfig.googleClientId,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || localConfig.googleClientSecret,
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scopes: "openid email https://www.googleapis.com/auth/calendar.events"
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

// The hidden home engine (a Home Assistant on this mirror). Its key lives in its own file, so it can
// never be lost to an account save that started before the engine was set up.
const homeEngineFile = path.join(dataDir, "home-engine.json");
const homeEngine = createHomeEngine({
  url: process.env.REFLECT_HOME_ENGINE ?? localConfig.homeEngineUrl ?? "http://127.0.0.1:8123",
  load: () => decrypt(fs.readFileSync(homeEngineFile, "utf8")),
  save: (value) => { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(homeEngineFile, encrypt(value), { mode: 0o600 }); }
});
let homeEngineConfig = null;
// An account's own Home Assistant or Hue Bridge wins; otherwise the mirror's built-in engine.
function homeConfig(session) {
  if (session.account.tokens?.smartHome) return decrypt(session.account.tokens.smartHome);
  return homeEngineConfig;
}
function markHomeConnected(session) {
  const current = session.account.addOns.smartHome || {};
  if (current.connectionStatus === "connected" && current.installed && current.enabled) return;
  session.account.addOns.smartHome = { ...current, installed: true, enabled: true, connectionStatus: "connected", lastSync: new Date().toISOString() };
  writeState(session.state);
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
const haDomains = new Set(["light", "switch", "climate", "lock", "cover", "fan", "scene", "script", "sensor", "binary_sensor", "media_player", "camera", "alarm_control_panel", "event", "person"]);
function haEntity(entity, areas) {
  const domain = String(entity?.entity_id || "").split(".")[0];
  if (!haDomains.has(domain)) return null;
  // Home Assistant's own housekeeping sensors (sunrise times, backups) aren't devices.
  if (/^(sensor|event|binary_sensor)\.(sun|backup)_/.test(entity.entity_id)) return null;
  const a = entity.attributes || {};
  const modes = Array.isArray(a.supported_color_modes) ? a.supported_color_modes : [];
  return {
    id: entity.entity_id, domain, name: a.friendly_name || entity.entity_id, state: entity.state,
    unit: a.unit_of_measurement || "", deviceClass: a.device_class || "",
    brightness: a.brightness ?? null, temperature: a.temperature ?? null,
    currentTemperature: a.current_temperature ?? null, hvacAction: a.hvac_action || "",
    hvacModes: domain === "climate" && Array.isArray(a.hvac_modes) ? a.hvac_modes : null, minTemp: a.min_temp ?? null, maxTemp: a.max_temp ?? null, step: a.target_temp_step ?? null,
    position: a.current_position ?? null,
    media: domain === "media_player" ? { title: a.media_title || "", artist: a.media_artist || "", volume: a.volume_level ?? null, source: a.source || "", sources: Array.isArray(a.source_list) ? a.source_list.slice(0, 40).map(String) : [] } : null,
    percentage: domain === "fan" ? a.percentage ?? null : null,
    areaId: areas[entity.entity_id]?.id || "", area: areas[entity.entity_id]?.name || "",
    rgb: Array.isArray(a.rgb_color) ? a.rgb_color : null,
    colorTemp: a.color_temp_kelvin ?? null,
    canColor: modes.some((m) => ["hs", "rgb", "rgbw", "rgbww", "xy"].includes(m)),
    canTemp: modes.includes("color_temp"),
    canDim: modes.some((m) => m !== "onoff"),
    // Event entities (a doorbell press, motion): the state is when it last happened, this is what.
    eventType: domain === "event" ? String(a.event_type || "") : ""
  };
}

// Live video (WebRTC): some cameras, Ring's among them, only stream live this way. The browser makes an offer,
// the server passes it to Home Assistant with the token, and hands back the camera's answer and network routes.
// The video then flows straight from the camera service to the browser; the server only holds the session open.
const liveSessions = new Map();
function openLiveVideo(config, entityId, offer) {
  return new Promise((resolve, reject) => {
    let socket;
    try { socket = new WebSocket(`${config.baseUrl.replace(/^http/, "ws")}/api/websocket`); } catch (error) { return reject(error); }
    const id = crypto.randomUUID(), candidates = [];
    let answer = null, settled = false, quiet = null;
    const close = () => { clearTimeout(entry.expires); liveSessions.delete(id); try { socket.close(); } catch {} };
    const entry = { socket, close, expires: setTimeout(() => close(), 10 * 60000) };
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timeout); clearTimeout(quiet);
      if (error) { close(); reject(error); } else { liveSessions.set(id, entry); resolve({ id, answer, candidates }); }
    };
    const timeout = setTimeout(() => finish(answer ? null : new Error("The camera didn't answer.")), 20000);
    socket.addEventListener("message", (message) => {
      let data; try { data = JSON.parse(String(message.data)); } catch { return; }
      if (data.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: config.token }));
      else if (data.type === "auth_ok") socket.send(JSON.stringify({ id: 1, type: "camera/webrtc/offer", entity_id: entityId, offer }));
      else if (data.type === "auth_invalid") finish(new Error("Home Assistant refused the mirror's key."));
      else if (data.type === "result" && !data.success) finish(new Error(data.error?.message || "This camera can't stream live."));
      else if (data.type === "event") {
        const e = data.event || {};
        if (e.type === "error") finish(new Error(e.message || "The camera couldn't start."));
        else if (e.type === "answer") { answer = e.answer; clearTimeout(quiet); quiet = setTimeout(() => finish(), 1500); }
        else if (e.type === "candidate" && e.candidate) {
          candidates.push(e.candidate);
          if (answer) { clearTimeout(quiet); quiet = setTimeout(() => finish(), 800); }
        }
      }
    });
    socket.addEventListener("close", () => { liveSessions.delete(id); finish(new Error("The camera connection closed.")); });
    socket.addEventListener("error", () => finish(new Error("Couldn't reach Home Assistant.")));
  });
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


// ---------- Philips Hue ----------
// The mirror can talk straight to a Hue Bridge on the home network instead of Home Assistant. The bridge's
// lights, rooms, scenes and temperature sensors are turned into the same device shape Home Assistant gives,
// so the Smart Home screen, the 3D house and Jarvis all work unchanged.
const hueColours = { red: [255, 0, 0], orange: [255, 140, 0], yellow: [255, 220, 0], gold: [255, 200, 0], lime: [0, 255, 0], green: [0, 200, 0], darkgreen: [0, 120, 0], teal: [0, 160, 160], cyan: [0, 255, 255], aqua: [0, 255, 255], turquoise: [64, 224, 208], skyblue: [135, 206, 235], lightblue: [173, 216, 230], blue: [0, 0, 255], navy: [0, 0, 128], darkblue: [0, 0, 139], royalblue: [65, 105, 225], indigo: [75, 0, 130], violet: [238, 130, 238], purple: [128, 0, 128], magenta: [255, 0, 255], fuchsia: [255, 0, 255], pink: [255, 150, 200], hotpink: [255, 105, 180], deeppink: [255, 20, 147], crimson: [220, 20, 60], coral: [255, 127, 80], salmon: [250, 128, 114], peach: [255, 200, 160], amber: [255, 190, 0], lavender: [200, 170, 255], lilac: [200, 160, 220], mint: [150, 255, 200], white: [255, 255, 255] };
const hueGamma = (c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92);
function rgbToXy([r, g, b]) {
  const [R, G, B] = [r, g, b].map((c) => hueGamma(c / 255));
  const X = R * 0.664511 + G * 0.154324 + B * 0.162028, Y = R * 0.283881 + G * 0.668433 + B * 0.047685, Z = R * 0.000088 + G * 0.07231 + B * 0.986039;
  const sum = X + Y + Z;
  return sum ? [Number((X / sum).toFixed(4)), Number((Y / sum).toFixed(4))] : [0.3127, 0.329];
}
function xyToRgb([x, y]) {
  if (!y) return [255, 255, 255];
  const X = x / y, Z = (1 - x - y) / y;
  let rgb = [X * 1.656492 - 0.354851 - Z * 0.255038, -X * 0.707196 + 1.655397 + Z * 0.036152, X * 0.051713 - 0.121364 + Z * 1.01153];
  rgb = rgb.map((c) => Math.max(0, c)).map((c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055));
  const max = Math.max(...rgb, 1e-6);
  return rgb.map((c) => Math.round((c / max) * 255));
}
const hueSlug = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "room";

let hueDiscovery = { at: 0, ip: "" };
async function findHueBridge() {
  if (hueDiscovery.ip && Date.now() - hueDiscovery.at < 600000) return hueDiscovery.ip;
  const response = await fetch("https://discovery.meethue.com/", { signal: AbortSignal.timeout(6000) });
  const list = response.ok ? await response.json() : [];
  const ip = Array.isArray(list) && list[0]?.internalipaddress ? String(list[0].internalipaddress) : "";
  hueDiscovery = { at: Date.now(), ip };
  return ip;
}
async function hueRequest(config, pathPart, method = "GET", payload) {
  const response = await fetch(`http://${config.bridge}/api/${config.username}${pathPart}`, { method, signal: AbortSignal.timeout(6000), ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error("The Hue Bridge didn't answer.");
  const error = Array.isArray(result) ? result.find((r) => r.error)?.error : null;
  if (error) throw new Error(error.type === 1 ? "The Hue Bridge no longer recognises the mirror. Connect it again." : `Hue: ${error.description}`);
  return result;
}
function hueEntities(all) {
  const lights = all.lights || {}, groups = all.groups || {}, rooms = {};
  for (const [gid, g] of Object.entries(groups)) if (g.type === "Room") for (const lid of g.lights || []) rooms[lid] = { id: hueSlug(g.name), name: g.name, gid };
  const sensorRooms = {};
  for (const g of Object.values(groups)) if (g.type === "Room") for (const sid of g.sensors || []) sensorRooms[sid] = { id: hueSlug(g.name), name: g.name };
  const out = [];
  for (const [id, l] of Object.entries(lights)) {
    const st = l.state || {}, type = String(l.type || "").toLowerCase(), plug = type.includes("plug");
    const canColor = "xy" in st || "hue" in st, canTemp = "ct" in st, on = Boolean(st.on);
    out.push({
      id: `${plug ? "switch" : "light"}.hue_${id}`, domain: plug ? "switch" : "light", name: l.name || `Light ${id}`,
      state: st.reachable === false ? "unavailable" : on ? "on" : "off", unit: "", deviceClass: "",
      brightness: on && "bri" in st ? Math.round((st.bri / 254) * 255) : null, temperature: null, currentTemperature: null, hvacAction: "", position: null, media: null,
      areaId: rooms[id]?.id || "", area: rooms[id]?.name || "",
      rgb: on && canColor && st.colormode !== "ct" && Array.isArray(st.xy) ? xyToRgb(st.xy) : null,
      colorTemp: on && st.colormode === "ct" && st.ct ? Math.round(1e6 / st.ct) : null,
      canColor, canTemp, canDim: "bri" in st
    });
  }
  // Motion sensors carry a thermometer: handy for "how warm is the hallway".
  for (const [id, sn] of Object.entries(all.sensors || {})) {
    if (sn.type !== "ZLLTemperature" || sn.state?.temperature == null) continue;
    const parent = Object.entries(all.sensors).find(([, o]) => o.type === "ZLLPresence" && o.uniqueid && sn.uniqueid && o.uniqueid.slice(0, 26) === sn.uniqueid.slice(0, 26));
    const room = sensorRooms[parent?.[0]] || sensorRooms[id];
    out.push({ id: `sensor.hue_${id}`, domain: "sensor", name: room ? "Temperature" : `${parent?.[1]?.name || sn.name} temperature`, state: String(Math.round(sn.state.temperature / 10) / 10), unit: "°C", deviceClass: "temperature", brightness: null, temperature: null, currentTemperature: null, hvacAction: "", position: null, media: null, areaId: room?.id || "", area: room?.name || "", rgb: null, colorTemp: null, canColor: false, canTemp: false, canDim: false });
  }
  for (const [id, sc] of Object.entries(all.scenes || {})) {
    if (sc.recycle || sc.type !== "GroupScene" || !groups[sc.group]) continue;
    const g = groups[sc.group];
    out.push({ id: `scene.hue_${id}`, domain: "scene", name: `${g.name} ${sc.name}`, state: "scening", unit: "", deviceClass: "", brightness: null, temperature: null, currentTemperature: null, hvacAction: "", position: null, media: null, areaId: g.type === "Room" ? hueSlug(g.name) : "", area: g.type === "Room" ? g.name : "", rgb: null, colorTemp: null, canColor: false, canTemp: false, canDim: false });
  }
  return out;
}
// Turns a Home Assistant style service call (light.turn_on with entity_id/area_id, brightness_pct, colour…)
// into Hue Bridge requests.
async function hueService(config, service, data) {
  const [domain, action] = service.split(".");
  const all = await hueRequest(config, "");
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]).map(String);
  if (domain === "scene" && action === "turn_on") {
    for (const eid of list(data.entity_id)) {
      const id = eid.replace(/^scene\.hue_/, ""), scene = all.scenes?.[id];
      if (!scene) throw new Error("That Hue scene isn't on the bridge.");
      await hueRequest(config, `/groups/${scene.group}/action`, "PUT", { scene: id });
    }
    return;
  }
  if (!["light", "switch", "homeassistant"].includes(domain) || !["turn_on", "turn_off", "toggle"].includes(action)) throw new Error("Hue lights can only be switched on and off, dimmed and coloured.");
  const ids = new Set(list(data.entity_id).filter((e) => /^(light|switch)\.hue_/.test(e)).map((e) => e.replace(/^(light|switch)\.hue_/, "")));
  for (const area of list(data.area_id)) for (const g of Object.values(all.groups || {})) if (g.type === "Room" && hueSlug(g.name) === area) (g.lights || []).forEach((l) => ids.add(String(l)));
  const targets = [...ids].filter((id) => all.lights?.[id]);
  if (!targets.length) throw new Error("There are no Hue lights there.");
  const anyOn = targets.some((id) => all.lights[id].state?.on);
  const on = action === "turn_on" || (action === "toggle" && !anyOn);
  const base = { on, transitiontime: 4 };
  if (on) {
    if (data.brightness_pct != null) base.bri = Math.max(1, Math.min(254, Math.round(Number(data.brightness_pct) * 2.54)));
    else if (data.brightness != null) base.bri = Math.max(1, Math.min(254, Math.round(Number(data.brightness))));
    let rgb = Array.isArray(data.rgb_color) ? data.rgb_color.map(Number) : null;
    if (!rgb && data.color_name) {
      rgb = hueColours[String(data.color_name).toLowerCase().replace(/[^a-z]/g, "")];
      if (!rgb) throw new Error(`Hue doesn't know the colour ${data.color_name}.`);
    }
    if (rgb) base.xy = rgbToXy(rgb);
    else if (data.color_temp_kelvin) base.ct = Math.max(153, Math.min(500, Math.round(1e6 / Number(data.color_temp_kelvin))));
  }
  await Promise.all(targets.map((id) => {
    const st = all.lights[id].state || {}, payload = { ...base };
    if (!("bri" in st)) delete payload.bri;
    if (!("xy" in st)) { if (payload.xy && "ct" in st) payload.ct = 300; delete payload.xy; }
    if (!("ct" in st)) delete payload.ct;
    return hueRequest(config, `/lights/${id}/state`, "PUT", payload);
  }));
}
// Hue's v1 API has no push updates, so the stream checks the bridge every couple of seconds and
// sends only what changed.
function hueStream(req, res, config) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch {} };
  const seen = new Map();
  let live = null, closed = false, timer = null;
  const tick = async () => {
    try {
      const entities = hueEntities(await hueRequest(config, ""));
      if (live !== true) { live = true; send("status", { live: true }); }
      for (const e of entities) { const key = JSON.stringify(e); if (seen.get(e.id) !== key) { if (seen.has(e.id)) send("entity", e); seen.set(e.id, key); } }
    } catch (error) { if (live !== false) { live = false; send("status", { live: false, error: error.message }); } }
    if (!closed) timer = setTimeout(tick, 2000);
  };
  tick();
  req.on("close", () => { closed = true; clearTimeout(timer); });
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

  // The house builder's layout (rooms, floors, sizes) for the 3D House screen. The mirror cleans it again on load.
  if (url.pathname === "/api/house-layout" && req.method === "GET") {
    return json(res, 200, { layout: session.account.houseLayout || null });
  }
  if (url.pathname === "/api/house-layout" && req.method === "PUT") {
    const input = await body(req);
    const layout = input.layout, num = (v, fallback) => (Number.isFinite(Number(v)) ? Math.max(-60, Math.min(60, Number(v))) : fallback);
    if (!layout || !Array.isArray(layout.rooms) || layout.rooms.length > 40 || JSON.stringify(layout).length > 20000) return json(res, 400, { error: "That house layout isn't valid." });
    session.account.houseLayout = { version: 1, floors: Math.max(1, Math.min(4, Number(layout.floors) || 1)), rooms: layout.rooms.map((r) => ({
      key: String(r.key || "").slice(0, 40), type: String(r.type || "other").slice(0, 30), label: String(r.label || "").slice(0, 30), floor: Math.max(0, Math.min(3, Math.round(Number(r.floor) || 0))),
      x: [num(r.x?.[0], 0), num(r.x?.[1], 1)], z: [num(r.z?.[0], 0), num(r.z?.[1], 1)],
      ...(Array.isArray(r.points) && { points: r.points.slice(0, 24).filter(Array.isArray).map((p) => [num(p[0], 0), num(p[1], 0)]) })
    })), stairs: (Array.isArray(layout.stairs) ? layout.stairs : []).slice(0, 8).filter((s) => s && typeof s === "object").map((s) => ({
      floor: Math.max(0, Math.min(3, Math.round(Number(s.floor) || 0))), x: [num(s.x?.[0], 0), num(s.x?.[1], 1)], z: [num(s.z?.[0], 0), num(s.z?.[1], 1)],
      dir: ["n", "s", "e", "w"].includes(s.dir) ? s.dir : "n"
    })) };
    writeState(session.state);
    return json(res, 200, { layout: session.account.houseLayout });
  }

  // Jarvis's long-term memory: facts he's learned about the person, and the last few things said,
  // so he can build on earlier conversations instead of repeating himself.
  if (url.pathname === "/api/jarvis-memory" && req.method === "GET") {
    return json(res, 200, session.account.jarvisMemory || { facts: [], recent: [] });
  }
  if (url.pathname === "/api/jarvis-memory" && req.method === "PUT") {
    const input = await body(req), text = (v, n) => String(v || "").replace(/\s+/g, " ").trim().slice(0, n);
    session.account.jarvisMemory = {
      facts: (Array.isArray(input.facts) ? input.facts : []).map((f) => text(f, 200)).filter(Boolean).slice(-80),
      recent: (Array.isArray(input.recent) ? input.recent : []).filter((r) => r && typeof r === "object").map((r) => ({ q: text(r.q, 300), a: text(r.a, 400), at: Number(r.at) || 0 })).filter((r) => r.q || r.a).slice(-12)
    };
    writeState(session.state);
    return json(res, 200, session.account.jarvisMemory);
  }

  // ---------- Smart Devices store ----------
  if (url.pathname === "/api/devices" && req.method === "GET") {
    let catalog = { categories: [], brands: [] };
    try { catalog = JSON.parse(fs.readFileSync(path.join(root, "smart-devices.json"), "utf8")); } catch {}
    const engine = await homeEngine.status();
    homeEngineConfig = engine.available ? await homeEngine.ready() : null;
    const own = session.account.tokens?.smartHome ? decrypt(session.account.tokens.smartHome) : null;
    let entries = [], found = [];
    if (engine.available) {
      ({ entries, found } = await homeEngine.overview().catch(() => ({ entries: [], found: [] })));
      if (!own && entries.length) markHomeConnected(session);
    }
    return json(res, 200, { engine, own: own ? (own.kind === "hue" ? "hue" : "homeAssistant") : "", catalog, entries, found, addOn: session.account.addOns.smartHome || null });
  }
  if (url.pathname === "/api/devices/flow" && req.method === "POST") {
    const input = await body(req);
    try {
      let step;
      if (input.flowId) step = await homeEngine.stepFlow(String(input.flowId), input.input && typeof input.input === "object" ? input.input : undefined);
      else {
        let catalog = { brands: [] };
        try { catalog = JSON.parse(fs.readFileSync(path.join(root, "smart-devices.json"), "utf8")); } catch {}
        const brand = catalog.brands.find((b) => b.id === input.brand);
        if (!brand) return json(res, 404, { error: "That brand isn't in the catalog." });
        step = await homeEngine.startFlow(brand.domain);
      }
      if (step.type === "create_entry") { homeEngineConfig = await homeEngine.ready(); if (!session.account.tokens?.smartHome) markHomeConnected(session); }
      return json(res, 200, step);
    } catch (error) { return json(res, error.status === 404 ? 410 : 502, { error: error.status === 404 ? "That setup timed out. Start it again." : error.message }); }
  }
  const flowMatch = url.pathname.match(/^\/api\/devices\/flow\/([A-Za-z0-9_-]+)$/);
  if (flowMatch && req.method === "DELETE") {
    await homeEngine.cancelFlow(flowMatch[1]);
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/devices/rooms" && req.method === "GET") {
    try { return json(res, 200, await homeEngine.rooms(String(url.searchParams.get("entry") || ""))); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/devices/rooms" && req.method === "POST") {
    const input = await body(req);
    try { await homeEngine.setRoom(String(input.deviceId || ""), input.room); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/devices/remove" && req.method === "POST") {
    const input = await body(req);
    try { await homeEngine.removeEntry(String(input.entryId || "")); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/devices/matter" && req.method === "POST") {
    const input = await body(req);
    try { await homeEngine.commissionMatter(input.code); if (!session.account.tokens?.smartHome) markHomeConnected(session); return json(res, 200, { ok: true }); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }

  // Hue pairing: the person presses the round button on the bridge, then the mirror asks the bridge
  // for a key. The mirror keeps asking for a little while, so the order doesn't matter.
  if (url.pathname === "/api/integrations/hue/pair" && req.method === "POST") {
    const input = await body(req);
    let bridge = String(input.bridge || "").trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (bridge && !/^[a-z0-9.-]+(:\d+)?$/i.test(bridge)) return json(res, 400, { error: "That bridge address doesn't look right. It should be like 192.168.1.20." });
    try { if (!bridge) bridge = await findHueBridge(); } catch {}
    if (!bridge) return json(res, 404, { error: "I couldn't find a Hue Bridge. Type its address (the Hue app shows it under Settings, My Hue system, the bridge, then the i)." });
    let result;
    try {
      const response = await fetch(`http://${bridge}/api`, { method: "POST", signal: AbortSignal.timeout(6000), headers: { "Content-Type": "application/json" }, body: JSON.stringify({ devicetype: "reflect#mirror" }) });
      result = await response.json();
    } catch { return json(res, 502, { error: `I couldn't reach the Hue Bridge at ${bridge}. Check the mirror is on the same Wi-Fi.` }); }
    const username = Array.isArray(result) ? result.find((r) => r.success)?.success?.username : "";
    if (!username) {
      const waiting = Array.isArray(result) && result.some((r) => r.error?.type === 101);
      return json(res, waiting ? 428 : 502, { error: waiting ? "Press the round button on top of the Hue Bridge." : "The Hue Bridge said no.", bridge, waiting });
    }
    session.account.tokens = session.account.tokens || {};
    session.account.tokens.smartHome = encrypt({ kind: "hue", bridge, username });
    session.account.addOns.smartHome = { ...(session.account.addOns.smartHome || {}), installed: true, enabled: true, connectionStatus: "connected", lastSync: new Date().toISOString() };
    writeState(session.state);
    return json(res, 200, session.account.addOns.smartHome);
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
    const config = homeConfig(session);
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    if (config.kind === "hue") {
      try { return json(res, 200, { entities: hueEntities(await hueRequest(config, "")), syncedAt: new Date().toISOString() }); }
      catch (error) { return json(res, 502, { error: error.message }); }
    }
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
    const config = homeConfig(session);
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    return config.kind === "hue" ? hueStream(req, res, config) : homeAssistantStream(req, res, config);
  }
  // Camera feeds come through the mirror's server so the Home Assistant token never reaches the browser.
  const cameraMatch = url.pathname.match(/^\/api\/homeassistant\/camera\/(camera\.[a-z0-9_]+)$/);
  if (cameraMatch && req.method === "GET") {
    const config = homeConfig(session);
    if (!config || config.kind === "hue") return json(res, 409, { error: "Connect Home Assistant first." });
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
  // What a device has done lately (doorbell presses, motion), for "was anyone at the door today?".
  if (url.pathname === "/api/homeassistant/history" && req.method === "GET") {
    const config = homeConfig(session);
    if (!config || config.kind === "hue") return json(res, 409, { error: "Connect Home Assistant first." });
    const ids = String(url.searchParams.get("ids") || "").split(",").filter((id) => /^[a-z_]+\.[a-z0-9_]+$/.test(id)).slice(0, 10);
    if (!ids.length) return json(res, 400, { error: "Which device?" });
    const hours = Math.max(1, Math.min(168, Number(url.searchParams.get("hours")) || 24));
    try {
      const start = new Date(Date.now() - hours * 3600000).toISOString();
      const historyUrl = new URL(`${config.baseUrl}/api/history/period/${start}`);
      historyUrl.search = new URLSearchParams({ filter_entity_id: ids.join(","), minimal_response: "1", no_attributes: "1" }).toString();
      const response = await fetch(historyUrl, { headers: { Authorization: `Bearer ${config.token}` } });
      if (!response.ok) return json(res, response.status, { error: "Home Assistant history isn't available." });
      const series = await response.json();
      const changes = (Array.isArray(series) ? series : []).flatMap((list, i) => (Array.isArray(list) ? list : []).map((c) => ({ id: list[0]?.entity_id || ids[i], state: c.state, at: c.last_changed || c.lu && new Date(c.lu * 1000).toISOString() || "" })));
      return json(res, 200, { changes: changes.filter((c) => c.state && c.state !== "unknown" && c.state !== "unavailable").slice(-60) });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  if (url.pathname === "/api/homeassistant/live" && req.method === "POST") {
    const config = homeConfig(session);
    if (!config || config.kind === "hue") return json(res, 409, { error: "Connect Home Assistant first." });
    const input = await body(req);
    if (!/^camera\.[a-z0-9_]+$/.test(String(input.entityId || "")) || typeof input.offer !== "string") return json(res, 400, { error: "Invalid camera." });
    try { return json(res, 200, await openLiveVideo(config, input.entityId, input.offer)); }
    catch (error) { return json(res, 502, { error: error.message }); }
  }
  const liveMatch = url.pathname.match(/^\/api\/homeassistant\/live\/([0-9a-f-]+)$/);
  if (liveMatch && req.method === "DELETE") {
    liveSessions.get(liveMatch[1])?.close();
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/homeassistant/service" && req.method === "POST") {
    const config = homeConfig(session);
    if (!config) return json(res, 409, { error: "Connect Home Assistant first." });
    const input = await body(req);
    if (!/^[a-z_]+\.[a-z_0-9]+$/.test(String(input.service || ""))) return json(res, 400, { error: "Invalid service." });
    const [domain, service] = input.service.split(".");
    if (config.kind === "hue") {
      try { await hueService(config, input.service, input.data && typeof input.data === "object" ? input.data : {}); return json(res, 200, { ok: true }); }
      catch (error) { return json(res, 502, { error: error.message }); }
    }
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
  // Adding, moving and cancelling Google Calendar events by voice. Older connections only had read
  // access, so those ask to reconnect once.
  const googleEventMatch = url.pathname.match(/^\/api\/google\/calendar\/events(?:\/([A-Za-z0-9_-]+))?$/);
  if (googleEventMatch && ["POST", "PATCH", "DELETE"].includes(req.method) && (req.method === "POST") === !googleEventMatch[1]) {
    try {
      const token = await refreshProvider(session.account, "googleCalendar");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Google Calendar first." });
      const scopes = new Set(String(token.scope || "").split(/\s+/));
      if (!scopes.has("https://www.googleapis.com/auth/calendar.events") && !scopes.has("https://www.googleapis.com/auth/calendar")) return json(res, 409, { error: "Reconnect Google Calendar once in Settings so I can change your calendar." });
      const input = req.method === "DELETE" ? {} : await body(req);
      const event = {};
      if (input.title) event.summary = String(input.title).slice(0, 200);
      if (input.location !== undefined) event.location = String(input.location || "").slice(0, 200);
      if (input.start) {
        const start = new Date(input.start), minutes = Math.max(5, Math.min(1440, Number(input.minutes) || 60));
        if (Number.isNaN(start.valueOf())) return json(res, 400, { error: "That time isn't valid." });
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        event.start = { dateTime: start.toISOString(), timeZone: zone };
        event.end = { dateTime: new Date(start.getTime() + minutes * 60000).toISOString(), timeZone: zone };
      }
      if (req.method === "POST" && (!event.summary || !event.start)) return json(res, 400, { error: "An event needs a title and a time." });
      const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
      const response = await fetch(googleEventMatch[1] ? `${base}/${googleEventMatch[1]}` : base, { method: req.method, headers: { Authorization: `Bearer ${token.access_token}`, ...(req.method === "DELETE" ? {} : { "Content-Type": "application/json" }) }, body: req.method === "DELETE" ? undefined : JSON.stringify(event) });
      if (response.ok) return json(res, 200, req.method === "DELETE" ? { ok: true } : { ok: true, id: (await response.json().catch(() => ({}))).id || "" });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Google Calendar couldn't make that change." });
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
  // Shuffle and repeat, for "shuffle this" and "put it on repeat".
  const modeMatch = url.pathname.match(/^\/api\/spotify\/player\/(shuffle|repeat)$/);
  if (modeMatch && req.method === "POST") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const input = await body(req);
      const state = modeMatch[1] === "shuffle" ? String(Boolean(input.state)) : ["track", "context", "off"].includes(input.state) ? input.state : "off";
      const spotifyUrl = new URL(`https://api.spotify.com/v1/me/player/${modeMatch[1]}`);
      spotifyUrl.searchParams.set("state", state);
      if (input.deviceId) spotifyUrl.searchParams.set("device_id", String(input.deviceId));
      const response = await fetch(spotifyUrl, { method: "PUT", headers: { Authorization: `Bearer ${token.access_token}` } });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not change that." });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  // Saves a song to Liked Songs ("I like this one").
  if (url.pathname === "/api/spotify/like" && req.method === "POST") {
    try {
      const token = await refreshProvider(session.account, "spotify");
      writeState(session.state);
      if (!token) return json(res, 409, { error: "Connect Spotify first." });
      const input = await body(req);
      const id = String(input.id || "").replace(/^spotify:track:/, "");
      if (!/^[A-Za-z0-9]+$/.test(id)) return json(res, 400, { error: "Nothing is playing to like." });
      const scopes = new Set(String(token.scope || "").split(/\s+/));
      if (!scopes.has("user-library-modify")) return json(res, 409, { error: "Reconnect Spotify once in Settings so I can save songs to your Liked Songs." });
      const response = await fetch(`https://api.spotify.com/v1/me/tracks?ids=${id}`, { method: "PUT", headers: { Authorization: `Bearer ${token.access_token}` } });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not save that song." });
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
- ${assistantConfig.address ? `Say "${assistantConfig.address}" sparingly: at most once in a reply, and leave it out of most replies entirely. It should feel occasional, the way the butler uses it with Tony Stark, never a verbal tic. Use their name only occasionally.` : "Use the person's name now and then, not in every reply."}
- Write for the ear: short sentences with natural punctuation, a full stop where a speaker would breathe, commas only where a speaker would pause.

Each user turn starts with a [Mirror context] block holding the live time, weather, calendar, tasks, music and smart-home devices. It is background you can see, not something to report: answer only what they asked, using only the parts of it that answer that. Never bring up the weather, calendar, tasks or devices unless they asked about them or they change the answer. Text after "They said:" is what the person actually said, transcribed from speech, so allow for misheard words.

When the context says "First conversation today: yes", you may open with a few words of greeting for the time of day, then answer what they said. Give a briefing (weather and what's next) only when they ask for one, such as "good morning" on its own or "what's today looking like".

Use your tools to act on the mirror: change screens and move around inside them (tabs, panels, settings pages, back, close), control smart-home devices, control music, add, change, complete or delete tasks, add, move or cancel calendar events, set timers and reminders (once or repeating), do things later or on a schedule, react to devices changing, run their own routines, look at cameras, change the weather location, arrange the home screen, and adjust the display and your own volume. Use web search for anything live or recent the context does not cover, such as news, sport scores, opening times or prices, and give the answer in a sentence or two without reading out sources. When asked to do something, do it and confirm in a few words. If a device or feature in the request is not in the context, say so briefly rather than guessing. Only act on smart-home devices whose entity id appears in the context. TVs and speakers (media_player) can be paused, played, skipped, muted, have their volume changed and switch input or app with control_device, and heating can be set, turned off or put back on its schedule. A plain "pause", "stop" or "resume" goes to whatever is actually playing: if a TV is playing and Spotify isn't, that's the TV. Anything with a time in it ("at 11", "in half an hour", "for an hour", "every Monday") uses schedule or a repeating reminder; a heating boost is a set_temperature now plus a scheduled heating_schedule. "Who's at the door?" uses look_at_camera; "was anyone at the door" uses device_history on the doorbell. When they say the name of one of their saved routines, run it. Never tell them a device can't do something without calling the tool first: try it, and if it fails the tool result says why. Earlier conversations may mention limits you no longer have; your tools now are what count. The mirror has a 3D House screen (show_screen house): when someone asks to see a room ("show me the bedroom"), the house, a floor ("go downstairs") or a camera ("show the front door camera"), use show_room, show_house or show_camera; when they control a room's devices, also show that room. For "goodnight", "I'm leaving", "movie night" and similar, use run_scene with a scene key from the context. For "what's on", list the lights and devices that are on, briefly, by room. For anything outside what the mirror can do, answer from your own knowledge as a helpful assistant would.

You remember the person between conversations. The context lists "What you've learned about them" and "Earlier conversations". Use them naturally, the way a butler who has known someone for years would, without announcing that you remember. Whenever they tell you something worth keeping (their name, family, work, routines, likes and dislikes, plans, or how they want you to behave), call remember at once with one short sentence, and carry on answering; say nothing about saving it unless they asked you to remember. If they correct something you know, forget the old fact and remember the new one. If they ask you to forget something, use forget.

Never repeat yourself: vary how you open and phrase replies, and don't reuse a line, joke or greeting from "Earlier conversations".`;
}

const assistantTools = [
  { name: "show_screen", description: "Switch the mirror to one of its screens, or back to the screen before. devices is where new smart devices are added (\"add a new light\", \"connect my Tado\"). smart_home is the Rooms list of device tiles; house is the 3D house.", input_schema: { type: "object", properties: { screen: { type: "string", enum: ["home", "calendar", "tasks", "music", "weather", "smart_home", "devices", "house", "settings", "back"] } }, required: ["screen"], additionalProperties: false } },
  { name: "show_room", description: "Show a room on the 3D House screen: the camera flies to it and its controls open. Use a room key or name from the 3D house list in the context.", input_schema: { type: "object", properties: { room: { type: "string" } }, required: ["room"], additionalProperties: false } },
  { name: "show_house", description: "Show the whole 3D house, or just one floor of it.", input_schema: { type: "object", properties: { floor: { type: "string", enum: ["all", "downstairs", "upstairs"] } }, additionalProperties: false } },
  { name: "show_camera", description: "Show a live security camera on the 3D House screen. Use a camera id or name from the context; leave it out for the first camera.", input_schema: { type: "object", properties: { camera: { type: "string" } }, additionalProperties: false } },
  { name: "run_scene", description: "Run a whole-house scene (for example goodnight, away, movie_night, relax, good_morning, party, all_off) using a scene key from the context.", input_schema: { type: "object", properties: { scene: { type: "string" } }, required: ["scene"], additionalProperties: false } },
  { name: "control_device", description: "Control Home Assistant devices listed in the mirror context. Target one device with entity_id, or a whole room with area_id (all its lights by default, or the domain given). Use turn_on/turn_off/toggle for lights, switches and fans; with turn_on on lights, brightness_pct sets brightness, color sets a colour (a CSS colour name like red, blue, purple, orange) and kelvin sets white temperature (2200 warm, 4000 neutral, 6500 cool); transition (seconds) fades lights on or off slowly. set_percentage sets a fan's speed. Use activate for scenes (e.g. Hue scenes), lock/unlock for locks, open/close for covers, set_position (position 0-100) to open blinds part way, and set_temperature (with temperature) for climate (heating); heating_off turns heating off and heating_schedule hands it back to its own schedule. For burglar alarms (alarm_control_panel) use arm_home, arm_away, arm_night or disarm, with code if one is needed. For TVs and speakers (media_player) use play, pause, play_pause, next, previous, volume_up, volume_down, mute, unmute, or set_volume with volume_pct; select_source with source switches input or opens an app (use a name from the device's sources list in the context, e.g. HDMI 2, Netflix, YouTube); turn_on/turn_off switch them on and off. Call it once per room or device; several calls in one turn are fine.", input_schema: { type: "object", properties: { entity_id: { type: "string", description: "Exact entity id from the context, e.g. light.living_room" }, area_id: { type: "string", description: "Room id from the context, e.g. living_room, to control the whole room" }, domain: { type: "string", enum: ["light", "switch", "fan", "cover", "media_player", "climate", "lock"], description: "With area_id: which kind of device in the room. Defaults to light." }, action: { type: "string", enum: ["turn_on", "turn_off", "toggle", "activate", "lock", "unlock", "open", "close", "set_position", "set_temperature", "heating_off", "heating_schedule", "set_percentage", "arm_home", "arm_away", "arm_night", "disarm", "play", "pause", "play_pause", "next", "previous", "volume_up", "volume_down", "mute", "unmute", "set_volume", "select_source"] }, volume_pct: { type: "integer", minimum: 0, maximum: 100 }, brightness_pct: { type: "integer", minimum: 1, maximum: 100 }, color: { type: "string" }, kelvin: { type: "integer", minimum: 2000, maximum: 6500 }, temperature: { type: "number" }, transition: { type: "number", minimum: 0, maximum: 3600 }, percentage: { type: "integer", minimum: 0, maximum: 100 }, position: { type: "integer", minimum: 0, maximum: 100 }, source: { type: "string" }, code: { type: "string" } }, required: ["action"], additionalProperties: false } },
  { name: "music", description: "Control Spotify (for a TV or speaker in the device list, use control_device instead). play resumes, pause pauses, next/previous skip, play_search finds and plays a song, artist or album from query, play_playlist plays one of their own playlists by name (query). volume sets volume_pct; volume_up and volume_down nudge it. shuffle_on/shuffle_off, repeat_on/repeat_off, like saves the current song to Liked Songs. Give device (a Spotify speaker or app name, e.g. Kitchen) to play there, or use move_to with device to move what's playing; list_devices says where Spotify can play.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["play", "pause", "next", "previous", "play_search", "play_playlist", "volume", "volume_up", "volume_down", "shuffle_on", "shuffle_off", "repeat_on", "repeat_off", "like", "move_to", "list_devices"] }, query: { type: "string" }, volume_pct: { type: "integer", minimum: 0, maximum: 100 }, device: { type: "string" } }, required: ["action"], additionalProperties: false } },
  { name: "add_task", description: "Add a task to the mirror's task list.", input_schema: { type: "object", properties: { title: { type: "string" }, category: { type: "string", enum: ["Home", "Work", "Health", "Personal"] }, when: { type: "string", enum: ["Today", "Upcoming"] }, high_priority: { type: "boolean" } }, required: ["title"], additionalProperties: false } },
  { name: "complete_task", description: "Mark a task from the context as done.", input_schema: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"], additionalProperties: false } },
  { name: "add_event", description: "Add a calendar event. calendar google puts it in their Google Calendar (when connected); mirror keeps it on the mirror only. Default to google when Google Calendar is connected.", input_schema: { type: "object", properties: { title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24-hour" }, minutes: { type: "integer", minimum: 5, maximum: 1440 }, location: { type: "string" }, calendar: { type: "string", enum: ["google", "mirror"] } }, required: ["title", "date", "time"], additionalProperties: false } },
  { name: "update_task", description: "Change a task from the context: mark it done or not done, rename it, move it between Today and Upcoming, change priority, or delete it.", input_schema: { type: "object", properties: { task_id: { type: "string" }, done: { type: "boolean" }, title: { type: "string" }, when: { type: "string", enum: ["Today", "Upcoming"] }, high_priority: { type: "boolean" }, delete: { type: "boolean" } }, required: ["task_id"], additionalProperties: false } },
  { name: "delete_event", description: "Cancel a calendar event from the context by its id, on the mirror or in Google Calendar.", input_schema: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"], additionalProperties: false } },
  { name: "set_timer", description: "Start a countdown timer. The mirror chimes and you announce it when it ends.", input_schema: { type: "object", properties: { minutes: { type: "number", minimum: 0 }, seconds: { type: "number", minimum: 0 }, label: { type: "string", description: "Short name, e.g. pasta" } }, additionalProperties: false } },
  { name: "set_reminder", description: "Remind the person about something at a set time today or on a date, once or on repeat. The mirror chimes and you say the reminder out loud at that time.", input_schema: { type: "object", properties: { text: { type: "string", description: "What to remind them about" }, time: { type: "string", description: "HH:MM, 24-hour" }, date: { type: "string", description: "YYYY-MM-DD; omit for the next time that clock time comes round" }, repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekends", "weekly"], description: "weekly repeats on the same weekday as the first one" } }, required: ["text", "time"], additionalProperties: false } },
  { name: "cancel_timer", description: "Cancel a running timer, reminder, scheduled action or device rule from the context by id, or all of them.", input_schema: { type: "object", properties: { id: { type: "string", description: "Id from the context, or \"all\"" } }, required: ["id"], additionalProperties: false } },
  { name: "set_weather_location", description: "Change the town or city the mirror shows weather for.", input_schema: { type: "object", properties: { place: { type: "string" } }, required: ["place"], additionalProperties: false } },
  { name: "show_widget", description: "Show or hide a widget on the mirror's home screen.", input_schema: { type: "object", properties: { widget: { type: "string", enum: ["clock", "weather", "calendar", "tasks", "affirmations", "music", "smartHome", "photos"] }, visible: { type: "boolean" } }, required: ["widget", "visible"], additionalProperties: false } },
  { name: "change_voice", description: "Change the voice you speak with, when asked. Without a name, moves to the next available voice; with a name, picks the voice whose name contains it. Tell the person the new voice's name in a few words.", input_schema: { type: "object", properties: { name: { type: "string", description: "Part of a voice name, such as Daniel or Jamie. Leave out to try the next voice." } }, additionalProperties: false } },
  { name: "set_display", description: "Adjust the mirror display: brightness (30-100), night mode, warmth (0 neutral to 100 candle-warm), appearance (dark, light, auto), accent colour (a colour name or #hex), clock format (12 or 24 hour), and screen off (sleep) or on (wake). The screen wakes by itself when they speak to you or touch it.", input_schema: { type: "object", properties: { brightness: { type: "integer", minimum: 30, maximum: 100 }, night_mode: { type: "boolean" }, warmth: { type: "integer", minimum: 0, maximum: 100 }, appearance: { type: "string", enum: ["dark", "light", "auto"] }, accent_color: { type: "string" }, clock_format: { type: "string", enum: ["12", "24"] }, screen: { type: "string", enum: ["off", "on"] } }, additionalProperties: false } },
  { name: "update_event", description: "Move or rename a calendar event from the context: give a new date and/or time (and length in minutes), title or location.", input_schema: { type: "object", properties: { event_id: { type: "string" }, title: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM, 24-hour" }, minutes: { type: "integer", minimum: 5, maximum: 1440 }, location: { type: "string" } }, required: ["event_id"], additionalProperties: false } },
  { name: "navigate", description: "Move around inside the mirror's screens. calendar_view: value day, week or upcoming. calendar_date: value YYYY-MM-DD to show that day/week/month (value today to come back). task_filter: value today, upcoming, completed, work or home. music_section: value playlists, recent or search. weather_section: value hourly, daily or details. settings_page: value general, home, affirmations, photos, weather, music, connections, phone, about, privacy or profile (account). connect: value spotify, google_calendar or smart_home opens where to connect it. find_device: value a brand (Hue, Tado, Ring...) opens Devices filtered to it. open_controls: value an entity id opens its control panel (light, heating, TV remote). open_add: value event or task opens the add box. close: closes whatever pop-up, panel, camera or settings page is open. scroll: value up or down.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["calendar_view", "calendar_date", "task_filter", "music_section", "weather_section", "settings_page", "connect", "find_device", "open_controls", "open_add", "close", "scroll"] }, value: { type: "string" } }, required: ["action"], additionalProperties: false } },
  { name: "home_screen", description: "Change the home screen. arrange moves a widget to a zone and/or resizes it (and shows it). edit_layout starts arrange mode; done_editing ends it; reset_layout puts everything back to normal. next_quote changes the affirmation or quote now; next_photo moves the photo slideshow on; slideshow starts the photo slideshow full screen.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["arrange", "edit_layout", "done_editing", "reset_layout", "next_quote", "next_photo", "slideshow"] }, widget: { type: "string", enum: ["clock", "weather", "calendar", "tasks", "affirmations", "music", "smartHome", "photos"] }, zone: { type: "string", enum: ["top-left", "top-centre", "top-right", "middle-left", "centre", "middle-right", "bottom-left", "bottom-centre", "bottom-right"] }, size: { type: "string", enum: ["small", "medium", "large"] } }, required: ["action"], additionalProperties: false } },
  { name: "schedule", description: "Do things later, or on repeat: lights off at 11, heating off in 30 minutes, show the calendar for 10 seconds then go home, a wake-up routine at 7 every weekday. Give a delay (in_minutes / in_seconds) or a clock time (at, plus date for another day), an optional repeat, a short label, and the actions to run. For a heating boost, set the temperature now and schedule heating_schedule for when the boost ends.", input_schema: { type: "object", properties: { label: { type: "string" }, in_minutes: { type: "number", minimum: 0 }, in_seconds: { type: "number", minimum: 0 }, at: { type: "string", description: "HH:MM, 24-hour" }, date: { type: "string", description: "YYYY-MM-DD" }, repeat: { type: "string", enum: ["none", "daily", "weekdays", "weekends", "weekly"] }, say: { type: "string", description: "Optional thing to say out loud when it runs" }, actions: { type: "array", description: "Mirror tool calls to run, in order. Each is {tool, input}: the name of one of your other tools and the input you would give it.", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool", "input"], additionalProperties: false } } }, required: ["label", "actions"], additionalProperties: false } },
  { name: "when_device", description: "Run actions automatically when a smart home device changes to a state, e.g. lights on when person.will becomes home, or a notice when the back door opens. once removes the rule after it runs the first time.", input_schema: { type: "object", properties: { label: { type: "string" }, entity_id: { type: "string" }, state: { type: "string", description: "The state to watch for, e.g. home, on, open, unlocked" }, once: { type: "boolean" }, say: { type: "string", description: "Optional thing to say out loud when it happens" }, actions: { type: "array", description: "Mirror tool calls to run, in order. Each is {tool, input}: the name of one of your other tools and the input you would give it.", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool", "input"], additionalProperties: false } } }, required: ["label", "entity_id", "state", "actions"], additionalProperties: false } },
  { name: "routine", description: "Their own named routines: save (name plus steps, e.g. bedtime = lights off, heating 17, TV off), run by name, or delete. When they say a saved routine's name (see the context), run it.", input_schema: { type: "object", properties: { action: { type: "string", enum: ["save", "run", "delete"] }, name: { type: "string" }, steps: { type: "array", description: "Mirror tool calls to run, in order. Each is {tool, input}: the name of one of your other tools and the input you would give it.", items: { type: "object", properties: { tool: { type: "string" }, input: { type: "object" } }, required: ["tool", "input"], additionalProperties: false } } }, required: ["action", "name"], additionalProperties: false } },
  { name: "look_at_camera", description: "Look at a security camera's current picture (e.g. the Ring doorbell) to say who or what is there. Use a camera id from the context; leave it out for the doorbell or first camera.", input_schema: { type: "object", properties: { camera: { type: "string" } }, additionalProperties: false } },
  { name: "device_history", description: "What a device did recently: doorbell presses, motion, a door opening, when the heating came on. Give entity ids from the context and how many hours back.", input_schema: { type: "object", properties: { entity_ids: { type: "array", items: { type: "string" }, maxItems: 10 }, hours: { type: "integer", minimum: 1, maximum: 168 } }, required: ["entity_ids"], additionalProperties: false } },
  { name: "voice_settings", description: "Change how loud you speak: volume_pct (10-100), or louder / quieter.", input_schema: { type: "object", properties: { volume_pct: { type: "integer", minimum: 10, maximum: 100 }, change: { type: "string", enum: ["louder", "quieter"] } }, additionalProperties: false } },
  { name: "check_for_updates", description: "Check whether a newer version of the mirror's software is installed and ready, and say which version is running.", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  // Runs on Anthropic's servers: news, sport, opening times, prices and anything else live.
  { name: "remember", description: "Save a lasting fact about the person or how they want you to behave, as one short sentence, e.g. \"Will takes his coffee black\" or \"Will prefers short answers\". Don't save things already in the list.", input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"], additionalProperties: false } },
  { name: "forget", description: "Remove a saved fact that is wrong, out of date, or that they asked you to forget. Give the fact's wording, or close to it.", input_schema: { type: "object", properties: { fact: { type: "string" } }, required: ["fact"], additionalProperties: false } },
  { type: "web_search_20260209", name: "web_search", max_uses: 3 }
];

// What the chosen model needs to answer quickly. Thinking is switched off so Jarvis starts talking straight
// away (Sonnet 5.5 still thinks between tool calls; Opus can't switch it off, so it keeps low effort).
// Haiku uses the older web search tool and has no refusal fallback.
let fastReplies = true, lastWarm = 0;
function modelOptions(model, fast = true) {
  const haiku = /haiku/.test(model);
  const thinking = model === "claude-sonnet-5-5" ? { type: "between_tools" } : /haiku-5-5/.test(model) ? { type: "disabled" } : null;
  const tools = assistantTools.map((t) => (t.name === "web_search" && haiku ? { ...t, type: "web_search_20250305" } : t));
  return { tools, ...(thinking && fast ? { thinking } : {}), ...(haiku ? {} : { fallbacks: "default" }) };
}

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
    return json(res, 200, { configured: Boolean(assistantConfig.anthropicKey), name: assistantConfig.name, wakeWord: assistantConfig.wakeWord, serverVoice: Boolean(voiceProvider()), voiceProvider: assistantConfig.builtInVoice ? "built-in" : voiceProvider(), builtInVoice: assistantConfig.builtInVoice, serverTranscription: Boolean(assistantConfig.openaiKey), address: assistantConfig.address });
  }
  if (req.method !== "POST") return json(res, 404, { error: "Not found" });
  if (!sameOriginRequest(req)) return json(res, 403, { error: "Forbidden" });
  // Called the moment the wake word is heard: opens the connection to Claude while you're still
  // talking, so the real question doesn't wait for it. Listing models is free.
  if (url.pathname === "/api/assistant/warm") {
    if (assistantConfig.anthropicKey && Date.now() - lastWarm > 3000) {
      lastWarm = Date.now();
      fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": assistantConfig.anthropicKey, "anthropic-version": "2023-06-01", ...(assistantConfig.anthropicWorkspaceId ? { "anthropic-workspace-id": assistantConfig.anthropicWorkspaceId } : {}) } }).then((r) => r.arrayBuffer()).catch(() => {});
    }
    res.writeHead(204); return res.end();
  }
  const type = String(req.headers["content-type"] || "");

  if (url.pathname === "/api/assistant/chat") {
    if (!type.startsWith("application/json")) return json(res, 415, { error: "Send JSON." });
    if (!assistantConfig.anthropicKey) return json(res, 503, { error: `Add an anthropicApiKey to reflect-os.config.json to wake ${assistantConfig.name}.` });
    const input = await body(req);
    const messages = Array.isArray(input.messages) ? input.messages : [];
    if (!messages.length || messages.length > 60 || messages.some((m) => !m || !["user", "assistant"].includes(m.role) || !Array.isArray(m.content))) return json(res, 400, { error: "Invalid conversation." });
    try {
      const started = Date.now();
      const send = (fast) => fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": assistantConfig.anthropicKey, "anthropic-version": "2023-06-01", ...(/haiku/.test(assistantConfig.model) ? {} : { "anthropic-beta": "server-side-fallback-2026-07-01" }), ...(assistantConfig.anthropicWorkspaceId ? { "anthropic-workspace-id": assistantConfig.anthropicWorkspaceId } : {}) },
        // The system prompt and tools are the same on every request, so they're cached (the explicit
        // marker), and the growing conversation is cached too (the top-level field). Both make replies quicker.
        body: JSON.stringify({ model: assistantConfig.model, max_tokens: 4096, output_config: { effort: "low" }, ...modelOptions(assistantConfig.model, fast), cache_control: { type: "ephemeral" }, system: [{ type: "text", text: assistantSystemPrompt(), cache_control: { type: "ephemeral" } }], messages, ...(input.stream ? { stream: true } : {}) })
      });
      // If the API ever turns down the quick no-thinking setting, ask again the standard way and stop using it.
      let response = await send(fastReplies);
      if (response.status === 400 && fastReplies) {
        const detail = await response.text().catch(() => "");
        if (/thinking/i.test(detail)) {
          console.log(`${assistantConfig.name}: quick replies were refused (${detail.slice(0, 200)}), using standard replies instead.`);
          fastReplies = false;
          response = await send(false);
        } else response = new Response(detail, { status: 400, headers: { "Content-Type": "application/json" } });
      }
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

const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8", ".glb": "model/gltf-binary" };
// Only these paths may be served. Everything else (config, dotfiles, /data, source-of-truth JSON) is denied,
// so provider secrets in reflect-os.config.json can never be read over HTTP.
const staticAllowList = new Set(["index.html", "app.js", "styles.css", "assistant.js", "hud-motion.js", "voice-worker.js", "smarthome/house-map.json", "assistant.css", "addons/catalog.json", "devices.js", "vendor/qrcode.js", "doorbell.js", "live-camera.js"]);

function serveStatic(req, res, url) {
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)).replace(/\/+$/, "");
  const file = path.resolve(root, relative);
  const withinRoot = file === root || file.startsWith(`${root}${path.sep}`);
  const ext = path.extname(file).toLowerCase();
  const isAsset = [".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico"].includes(ext);
  const hasDotSegment = relative.split("/").some((part) => part.startsWith("."));
  // The 3D Smart Home screen's built files and house model.
  const isSmartHome = (relative.startsWith("smarthome/dist/") && [".js", ".css"].includes(ext)) || (relative.startsWith("smarthome/models/") && ext === ".glb");
  const allowed = withinRoot && !hasDotSegment && (staticAllowList.has(relative) || isAsset || isSmartHome);
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
  // Find (and the first time, set up) the built-in home engine, and keep looking while it starts up.
  const findEngine = async () => {
    homeEngineConfig = await homeEngine.ready().catch(() => null);
    if (homeEngineConfig) console.log("Home engine ready: smart devices can be added from the Smart Devices screen.");
    else if (homeEngine.url) setTimeout(findEngine, 30000);
  };
  findEngine();
}

module.exports = { handleRequest };
