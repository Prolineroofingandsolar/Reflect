"use strict";
// The home engine is a Home Assistant that runs hidden on the mirror itself (scripts/install-home-engine.sh
// starts it). Nobody ever sees it: the mirror sets it up on first start, keeps its key, and shows each brand's
// setup steps as its own cards. Everything here talks to it over its normal REST and WebSocket APIs.

const crypto = require("crypto");

const clientId = "http://reflect.local/";

function createHomeEngine({ url, load, save }) {
  const baseUrl = String(url || "").replace(/\/+$/, "");
  let setupError = "", settingUp = null;

  const saved = () => { try { return load(); } catch { return null; } };

  async function onboardingSteps() {
    const response = await fetch(`${baseUrl}/api/onboarding`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null; // already onboarded by someone else
    return response.json();
  }

  // One WebSocket round trip: authenticate, send one command, return its result.
  async function wsCall(token, message, wait = 15000) {
    const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/api/websocket`);
    try {
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("The home engine didn't answer.")), wait);
        socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("The home engine isn't running.")); });
        socket.addEventListener("message", (event) => {
          let data; try { data = JSON.parse(String(event.data)); } catch { return; }
          if (data.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
          else if (data.type === "auth_invalid") { clearTimeout(timer); reject(new Error("The home engine refused the mirror's key.")); }
          else if (data.type === "auth_ok") socket.send(JSON.stringify({ id: 1, ...message }));
          else if (data.id === 1) { clearTimeout(timer); data.success ? resolve(data.result) : reject(new Error(data.error?.message || "The home engine said no.")); }
        });
      });
    } finally { try { socket.close(); } catch {} }
  }

  // First start: create the engine's owner account, finish its welcome steps and make a long-lived key.
  async function onboard() {
    const steps = await onboardingSteps();
    if (!steps) throw new Error("The home engine was already set up by someone else.");
    const password = crypto.randomBytes(24).toString("base64url");
    const json = { "Content-Type": "application/json" };
    let response = await fetch(`${baseUrl}/api/onboarding/users`, { method: "POST", headers: json, body: JSON.stringify({ client_id: clientId, name: "Reflect", username: "reflect", password, language: "en" }) });
    if (!response.ok) throw new Error("The home engine wouldn't create the mirror's account.");
    const { auth_code: code } = await response.json();
    response = await fetch(`${baseUrl}/auth/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId }) });
    if (!response.ok) throw new Error("The home engine wouldn't sign the mirror in.");
    const { access_token: access } = await response.json();
    const auth = { ...json, Authorization: `Bearer ${access}` };
    for (const step of ["core_config", "analytics"]) await fetch(`${baseUrl}/api/onboarding/${step}`, { method: "POST", headers: auth, body: "{}" });
    await fetch(`${baseUrl}/api/onboarding/integration`, { method: "POST", headers: auth, body: JSON.stringify({ client_id: clientId, redirect_uri: `${clientId}?auth_callback=1` }) });
    const token = await wsCall(access, { type: "auth/long_lived_access_token", client_name: "Reflect mirror", lifespan: 3650 });
    save({ baseUrl, token, password });
    return { baseUrl, token };
  }

  // Returns the engine's connection details, setting it up the first time. Null when no engine is running.
  async function ready() {
    if (!baseUrl) return null;
    const known = saved();
    if (known?.baseUrl === baseUrl) return known;
    if (!settingUp) settingUp = onboard().then((c) => { setupError = ""; return c; }, (e) => { setupError = e instanceof TypeError || /fetch|ECONNREFUSED|abort|timeout/i.test(e.message) ? "The home engine isn't installed or running on this mirror." : e.message; return null; }).finally(() => { settingUp = null; });
    return settingUp;
  }

  async function status() {
    if (!baseUrl) return { available: false, reason: "No home engine is set up on this mirror." };
    try {
      const config = await ready();
      if (!config) return { available: false, reason: setupError || "The home engine isn't running." };
      await rest(config, "/api/");
      return { available: true };
    } catch (error) { return { available: false, reason: error.message.includes("fetch") ? "The home engine isn't running." : error.message }; }
  }

  async function rest(config, pathPart, method = "GET", payload) {
    const response = await fetch(`${config.baseUrl}${pathPart}`, { method, signal: AbortSignal.timeout(20000), headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" }, ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!response.ok) throw Object.assign(new Error(typeof data === "object" && data?.message ? data.message : `The home engine said ${response.status}.`), { status: response.status });
    return data;
  }

  // ---------- Setup flows, in the mirror's own words ----------
  const translations = new Map();
  async function words(config, domain) {
    const cached = translations.get(domain);
    if (cached && Date.now() - cached.at < 3600000) return cached.resources;
    let resources = {};
    try { resources = (await wsCall(config.token, { type: "frontend/get_translations", language: "en", category: "config", integration: [domain] })).resources || {}; } catch {}
    translations.set(domain, { at: Date.now(), resources });
    return resources;
  }
  // Setup text is written for Home Assistant's own screens; the mirror reads it as its own.
  const tidy = (text, placeholders) => String(text || "")
    .replace(/\{(\w+)\}/g, (m, k) => (placeholders && placeholders[k] != null ? String(placeholders[k]) : m))
    .replace(/```([\s\S]*?)```/g, "$1").replace(/`([^`]*)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/Home Assistant/g, "the mirror").replace(/\bthe the mirror\b/g, "the mirror").trim();

  function field(entry, t, prefix, placeholders) {
    const sel = entry.selector || {}, kind = Object.keys(sel)[0];
    const out = {
      name: entry.name,
      label: tidy(t[`${prefix}.data.${entry.name}`], placeholders) || entry.name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      help: tidy(t[`${prefix}.data_description.${entry.name}`], placeholders),
      required: Boolean(entry.required), default: entry.default ?? entry.description?.suggested_value ?? null, type: "text"
    };
    if (entry.type === "boolean" || kind === "boolean") out.type = "boolean";
    else if (entry.type === "integer" || entry.type === "float" || kind === "number") { out.type = "number"; out.min = sel.number?.min ?? entry.valueMin; out.max = sel.number?.max ?? entry.valueMax; }
    else if (entry.type === "select" || kind === "select") {
      out.type = "select";
      const options = entry.options || sel.select?.options || [];
      out.options = options.map((o) => (Array.isArray(o) ? { value: o[0], label: o[1] } : typeof o === "object" ? { value: o.value, label: o.label } : { value: o, label: tidy(t[`component.${prefix.split(".")[1]}.selector.${sel.select?.translation_key}.options.${o}`]) || String(o) }));
    } else if (entry.type === "constant") { out.type = "constant"; out.default = entry.value; }
    else if (kind === "text" && sel.text?.type === "password" || /password|pin|secret/i.test(entry.name)) out.type = "password";
    return out;
  }

  // Turns a raw flow step into what the mirror's setup card needs.
  async function describe(config, step) {
    const domain = step.handler, t = await words(config, domain), base = `component.${domain}.config`;
    const ph = step.description_placeholders || {};
    const prefix = `${base}.step.${step.step_id}`;
    const out = { flowId: step.flow_id, domain, type: step.type, step: step.step_id || "" };
    if (step.type === "form") {
      out.title = tidy(t[`${prefix}.title`], ph);
      out.text = tidy(t[`${prefix}.description`], ph);
      out.fields = (step.data_schema || []).map((e) => field(e, t, prefix, ph));
      out.errors = Object.fromEntries(Object.entries(step.errors || {}).map(([k, v]) => [k, tidy(t[`${base}.error.${v}`], ph) || v.replace(/_/g, " ")]));
    } else if (step.type === "menu") {
      out.title = tidy(t[`${prefix}.title`], ph);
      out.text = tidy(t[`${prefix}.description`], ph);
      const options = Array.isArray(step.menu_options) ? step.menu_options.map((k) => [k, k]) : Object.entries(step.menu_options || {});
      out.options = options.map(([value, label]) => ({ value, label: tidy(t[`${prefix}.menu_options.${value}`], ph) || label }));
    } else if (step.type === "progress" || step.type === "external" || step.type === "external_done" || step.type === "progress_done") {
      out.text = tidy(t[`${base}.progress.${step.progress_action}`], ph) || "Waiting…";
      out.url = step.url || ph.url || "";
      out.code = ph.code || ph.user_code || "";
    } else if (step.type === "abort") {
      out.text = tidy(t[`${base}.abort.${step.reason}`], ph) || step.reason.replace(/_/g, " ");
      out.reason = step.reason;
    } else if (step.type === "create_entry") {
      out.text = "Connected.";
      out.title = step.title || "";
      out.entryId = step.result?.entry_id || (typeof step.result === "string" ? step.result : "");
    }
    return out;
  }

  async function startFlow(domain) {
    const config = await ready();
    if (!config) throw new Error(setupError || "The home engine isn't running.");
    return describe(config, await rest(config, "/api/config/config_entries/flow", "POST", { handler: domain, show_advanced_options: false }));
  }
  async function stepFlow(flowId, input) {
    const config = await ready();
    if (!config) throw new Error(setupError || "The home engine isn't running.");
    const step = input === undefined ? await rest(config, `/api/config/config_entries/flow/${flowId}`) : await rest(config, `/api/config/config_entries/flow/${flowId}`, "POST", input);
    return describe(config, step);
  }
  async function cancelFlow(flowId) {
    const config = await ready();
    if (config) await rest(config, `/api/config/config_entries/flow/${flowId}`, "DELETE").catch(() => {});
  }

  // What's connected, and what the engine has spotted on the Wi-Fi by itself.
  async function overview() {
    const config = await ready();
    if (!config) return { entries: [], found: [] };
    const [entries, progress] = await Promise.all([
      rest(config, "/api/config/config_entries/entry").catch(() => []),
      wsCall(config.token, { type: "config_entries/flow/progress" }).catch(() => [])
    ]);
    const found = [];
    for (const f of Array.isArray(progress) ? progress : []) {
      if (!["zeroconf", "ssdp", "dhcp", "homekit", "bluetooth", "discovery", "integration_discovery", "mqtt", "usb"].includes(f.context?.source)) continue;
      const t = await words(config, f.handler);
      found.push({ flowId: f.flow_id, domain: f.handler, name: tidy(t[`component.${f.handler}.config.flow_title`], f.context?.title_placeholders) || f.context?.title_placeholders?.name || f.handler });
    }
    return {
      entries: (Array.isArray(entries) ? entries : []).filter((e) => e.source !== "system" && !["sun", "met", "radio_browser", "shopping_list", "google_translate", "backup", "go2rtc"].includes(e.domain)).map((e) => ({ id: e.entry_id, domain: e.domain, title: e.title, state: e.state })),
      found
    };
  }
  async function removeEntry(entryId) {
    const config = await ready();
    if (!config) throw new Error("The home engine isn't running.");
    await rest(config, `/api/config/config_entries/entry/${encodeURIComponent(entryId)}`, "DELETE");
  }

  // Matter: the code printed on the device or its box (11 or 21 digits, or the MT: QR text).
  async function commissionMatter(code) {
    const config = await ready();
    if (!config) throw new Error("The home engine isn't running.");
    const clean = String(code || "").trim();
    if (!/^MT:[A-Z0-9.\-]+$/i.test(clean) && !/^[\d\s-]{11,26}$/.test(clean)) throw new Error("That doesn't look like a Matter code. It's 11 digits, or the QR code on the device.");
    const entries = await rest(config, "/api/config/config_entries/entry");
    if (!entries.some((e) => e.domain === "matter")) {
      // The Matter server runs beside the engine; connect the two the first time.
      let step = await rest(config, "/api/config/config_entries/flow", "POST", { handler: "matter" });
      if (step.type === "form") step = await rest(config, `/api/config/config_entries/flow/${step.flow_id}`, "POST", { url: "ws://localhost:5580/ws" });
      if (step.type !== "create_entry") {
        if (step.flow_id && step.type !== "abort") await rest(config, `/api/config/config_entries/flow/${step.flow_id}`, "DELETE").catch(() => {});
        throw new Error("Matter isn't switched on for this mirror yet. It needs the Matter server that the Raspberry Pi installer adds.");
      }
    }
    const digits = /^MT:/i.test(clean) ? clean.toUpperCase() : clean.replace(/\D/g, "");
    await wsCall(config.token, { type: "matter/commission", code: digits }, 180000);
  }

  // Rooms: the engine's areas. New devices can be put in a room by name; a room that doesn't exist yet is made.
  async function rooms(entryId) {
    const config = await ready();
    if (!config) throw new Error("The home engine isn't running.");
    const [areas, devices] = await Promise.all([wsCall(config.token, { type: "config/area_registry/list" }), wsCall(config.token, { type: "config/device_registry/list" })]);
    return {
      rooms: areas.map((a) => ({ id: a.area_id, name: a.name })),
      devices: devices.filter((d) => !d.disabled_by && (!entryId || (d.config_entries || []).includes(entryId)) && d.entry_type !== "service")
        .map((d) => ({ id: d.id, name: d.name_by_user || d.name || "Device", room: d.area_id || "" }))
    };
  }
  async function setRoom(deviceId, roomName) {
    const config = await ready();
    if (!config) throw new Error("The home engine isn't running.");
    const name = String(roomName || "").trim().slice(0, 40);
    let areaId = null;
    if (name) {
      const areas = await wsCall(config.token, { type: "config/area_registry/list" });
      const match = areas.find((a) => a.name.toLowerCase() === name.toLowerCase());
      areaId = match ? match.area_id : (await wsCall(config.token, { type: "config/area_registry/create", name })).area_id;
    }
    await wsCall(config.token, { type: "config/device_registry/update", device_id: deviceId, area_id: areaId });
  }

  return { get url() { return baseUrl; }, rooms, setRoom, ready, status, startFlow, stepFlow, cancelFlow, overview, removeEntry, commissionMatter };
}

module.exports = { createHomeEngine };
