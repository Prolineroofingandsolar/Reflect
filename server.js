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
const oauthStates = new Map();
const secret = crypto.createHash("sha256").update(process.env.REFLECT_SECRET || localConfig.reflectSecret || "reflect-os-local-device").digest();
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
  const id = state.sessions?.[cookies(req).reflect_session];
  if (!id) return null;
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

async function api(req, res, url) {
  if (url.pathname === "/api/session" && req.method === "GET") {
    const session = currentAccount(req);
    return json(res, 200, { signedIn: Boolean(session), account: session ? publicAccount(session.account, session.id) : null });
  }
  if (url.pathname === "/api/health" && req.method === "GET") {
    return json(res, 200, { ok: true, version: 9, spotifyConfigured: Boolean(providers.spotify.clientId), googleConfigured: Boolean(providers.googleCalendar.clientId && providers.googleCalendar.clientSecret) });
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
    if (existing?.pinHash && !verifyPin(pin, existing.pinHash)) return json(res, 401, { error: "That PIN is not correct." });
    state.accounts[id] = { name, email, pinHash: existing?.pinHash || hashPin(pin), addOns: existing?.addOns || { weather: { installed: true, enabled: true, connectionStatus: "connected", lastSync: "Live forecast" } }, tokens: existing?.tokens || {}, data: existing?.data || { tasks: [], events: [] } };
    writeState(state);
    const sessionId = crypto.randomBytes(24).toString("hex");
    state.sessions = state.sessions || {};
    state.sessions[sessionId] = id;
    writeState(state);
    return json(res, 200, { signedIn: true, account: publicAccount(state.accounts[id], id) }, { "Set-Cookie": `reflect_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/` });
  }
  if (url.pathname === "/api/session" && req.method === "DELETE") {
    const state = readState();
    if (state.sessions) delete state.sessions[cookies(req).reflect_session];
    writeState(state);
    return json(res, 200, { signedIn: false }, { "Set-Cookie": "reflect_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
  }

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
      spotifyUrl.search = new URLSearchParams({ q: query, type: "track", limit: "12" }).toString();
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
      const requestBody = action === "play" && input.uri ? JSON.stringify({ uris: [input.uri] }) : undefined;
      const response = await fetch(spotifyUrl, { method, headers: { Authorization: `Bearer ${token.access_token}`, ...(requestBody ? { "Content-Type": "application/json" } : {}) }, body: requestBody });
      if (response.ok) return json(res, 200, { ok: true });
      const result = await response.json().catch(() => ({}));
      return json(res, response.status, { error: result.error?.message || "Spotify could not complete that action." });
    } catch (error) { return json(res, 502, { error: error.message }); }
  }
  return json(res, 404, { error: "Not found" });
}

const staticTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".json": "application/json; charset=utf-8" };
// Only these paths may be served. Everything else (config, dotfiles, /data, source-of-truth JSON) is denied,
// so provider secrets in reflect-os.config.json can never be read over HTTP.
const staticAllowList = new Set(["index.html", "app.js", "styles.css", "addons/catalog.json"]);

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
