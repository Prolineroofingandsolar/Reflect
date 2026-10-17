"use strict";

// Reflect assistant: a Jarvis-style voice assistant for the mirror.
// Listens for a wake word (or a tap / the J key), sends what it hears to Claude through the local
// server, acts on the mirror with tools, and answers out loud with an animated on-screen presence.
// Runs alongside app.js and uses its globals (profile, sampleData, showView, api, ...).
(() => {
  const A = {
    status: null, state: "idle", open: false, busy: false,
    conversation: [], lastTurn: 0, convStart: 0, memory: null, lastAck: -1,
    recognition: null, srPaused: false, srUnavailable: false, srBlocked: false, awaitingCommand: false, commandTimer: null,
    audioCtx: null, micAnalyser: null, outAnalyser: null, micBuffer: null, outBuffer: null,
    level: 0, speakPulse: 0, currentAudio: null, voice: null, closeTimer: null, recording: false,
    turn: 0, queued: "", heardFinal: "", endTimer: null, ducked: null
  };
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.className = "jv";
  root.dataset.state = "idle";
  root.innerHTML = `
    <button class="jv-mini" type="button" aria-label="Talk to the assistant"><span class="jv-mini-core"></span></button>
    <div class="jv-stage" role="dialog" aria-modal="false" aria-label="Assistant">
      <button class="jv-close" type="button" aria-label="Close">×</button>
      <i class="jv-br tl"></i><i class="jv-br tr"></i><i class="jv-br bl"></i><i class="jv-br br"></i>
      <div class="jv-tele jv-tele-l" aria-hidden="true"></div>
      <div class="jv-tele jv-tele-r" aria-hidden="true"></div>
      <div class="jv-name"></div>
      <canvas class="jv-orb" width="560" height="560" aria-hidden="true"></canvas>
      <div class="jv-state" aria-live="polite"></div>
      <p class="jv-heard"></p>
      <p class="jv-reply" aria-hidden="true"></p>
      <p class="jv-sr" aria-live="polite"></p>
      <ol class="jv-log" aria-label="Actions taken"></ol>
      <form class="jv-type" autocomplete="off"><input type="text" maxlength="300" aria-label="Type a request"><button type="submit">Send</button></form>
    </div>`;
  document.body.appendChild(root);
  const el = (s) => root.querySelector(s);
  const mini = el(".jv-mini"), stage = el(".jv-stage"), canvas = el(".jv-orb"), stateLabel = el(".jv-state");
  const heardEl = el(".jv-heard"), replyEl = el(".jv-reply"), logEl = el(".jv-log"), srEl = el(".jv-sr"), teleL = el(".jv-tele-l"), teleR = el(".jv-tele-r"), typeForm = el(".jv-type"), typeInput = el(".jv-type input");
  const ctx = canvas.getContext("2d");

  const name = () => A.status?.name || "Jarvis";
  const stateText = { idle: "Standing by", listening: "Listening", thinking: "Thinking", speaking: "", error: "" };

  // The 3D House screen draws its own voice states (waveform, pulse, words) from these events.
  const emit = (detail) => window.dispatchEvent(new CustomEvent("reflect:assistant", { detail }));
  function setState(state) {
    A.state = state;
    emit(state === "listening" ? { state, heard: "", reply: "", error: "" } : state === "thinking" ? { state, reply: "", error: "" } : { state });
    if (state === "idle") unduckMusic(); else duckMusic();
    root.dataset.state = state;
    const label = stateText[state] ?? "";
    if (stateLabel.dataset.text !== label) { stateLabel.dataset.text = label; HUD.glitch(stateLabel, label, 320); }
    telemetry();
  }
  function openStage() {
    clearTimeout(A.closeTimer);
    clearTimeout(A.closingTimer);
    root.classList.remove("is-closing");
    if (A.open) return;
    A.open = true;
    // Power-up: the stage projects open from a line of light while the orb assembles itself.
    A.bootAt = performance.now();
    A.dockRect = null;
    dock(null, true);
    root.classList.add("is-open", "is-booting");
    clearTimeout(A.bootTimer);
    A.bootTimer = setTimeout(() => root.classList.remove("is-booting"), 1400);
    HUD.decode(el(".jv-name"), name().toUpperCase().split("").join(" "), { cps: 14, scramble: 200, caret: false, delay: 250 });
    telemetry(true);
    clearInterval(A.teleTimer);
    A.teleTimer = setInterval(telemetry, 1000);
    requestAnimationFrame(draw);
  }
  function closeStage() {
    clearTimeout(A.closeTimer);
    clearTimeout(A.commandTimer);
    A.awaitingCommand = false;
    stopSpeaking();
    A.open = false;
    clearInterval(A.teleTimer);
    // Power-down: the stage folds back into a line and fades.
    if (root.classList.contains("is-open") && !HUD.reduced()) {
      root.classList.add("is-closing");
      clearTimeout(A.closingTimer);
      A.closingTimer = setTimeout(() => root.classList.remove("is-open", "is-closing"), 380);
    } else root.classList.remove("is-open");
    heardEl.textContent = "";
    showReply("");
    clearLog();
    typeInput.blur();
    setState("idle");
  }
  function closeSoon(ms = 6000) {
    clearTimeout(A.closeTimer);
    A.closeTimer = setTimeout(() => { if (!A.busy && A.state !== "speaking" && A.state !== "listening") closeStage(); }, ms);
  }
  // ---------- Corner panel ----------
  // The panel sits in a corner while Jarvis talks. Given the area of the screen he is showing, it
  // moves to the corner that covers the least of it (bottom right when nothing is in the way).
  const GAP = 16;
  function corners() {
    const w = stage.offsetWidth || 360, h = stage.offsetHeight || 260;
    const vw = window.innerWidth, vh = window.innerHeight;
    return [[vw - w - GAP, vh - h - GAP], [GAP, vh - h - GAP], [vw - w - GAP, GAP + 56], [GAP, GAP + 56]]
      .map(([x, y]) => [Math.max(GAP, x), Math.max(GAP, y), w, h]);
  }
  function dock(avoid, instant) {
    const spots = corners();
    const overlap = ([x, y, w, h]) => !avoid ? 0
      : Math.max(0, Math.min(x + w, avoid.right) - Math.max(x, avoid.left)) * Math.max(0, Math.min(y + h, avoid.bottom) - Math.max(y, avoid.top));
    A.corner = spots.reduce((best, spot, i) => overlap(spot) < overlap(spots[best]) - 1 ? i : best, 0);
    place(instant);
  }
  // Keeps the panel in its corner as the reply grows or the window changes size.
  function place(instant) {
    const [x, y] = corners()[A.corner || 0];
    stage.classList.toggle("is-placing", !!instant);
    stage.style.setProperty("--jv-x", `${Math.round(x)}px`);
    stage.style.setProperty("--jv-y", `${Math.round(y)}px`);
    if (instant) { void stage.offsetWidth; stage.classList.remove("is-placing"); }
  }
  // What Jarvis should fly to after a tool runs: the panel, tile or screen it just brought up.
  function targetFor(tool, input) {
    const shown = (n) => { if (!n || n.closest(".jv")) return null; const r = n.getBoundingClientRect(); return r.width > 24 && r.height > 24 && r.bottom > 0 && r.top < window.innerHeight ? n : null; };
    const q = (s) => shown(document.querySelector(s));
    const popup = () => q("dialog[open]") || [...document.querySelectorAll(".is-open")].map(shown).find((n) => n && getComputedStyle(n).position === "fixed");
    const view = document.querySelector(".view.is-active");
    const main = () => {
      if (!view) return null;
      if (view.id === "view-settings") return q("#settingsDetail:not([hidden])") || q(".settings-view .settings-main") || shown(view);
      return shown(view.querySelector("#layoutGrid, .cal-main, .mu-player, .homekit-grid, .dv-catalog, .wx-hourly-panel, #house3dRoot")) || shown(view);
    };
    switch (tool) {
      case "show_screen": return main();
      case "navigate":
        if (input.action === "close" || input.action === "scroll") return null;
        if (input.action === "open_controls" || input.action === "open_add") return popup() || main();
        if (input.action === "find_device") return q("#dvCatalog") || main();
        return q(".jv-spotlight") || main();
      case "show_widget": return (input.widget && q(`[data-widget="${CSS.escape(String(input.widget))}"]`)) || q("#layoutGrid");
      case "home_screen":
        if (input.action === "next_quote") return q('[data-widget="affirmations"]');
        if (input.action === "next_photo" || input.action === "slideshow") return q('[data-widget="photos"]');
        return input.action === "done_editing" ? null : q("#layoutGrid");
      case "control_device": {
        const id = input.entity_id || input.id;
        return id ? q(`[data-ha-toggle="${CSS.escape(String(id))}"]`) : null;
      }
      case "show_room": case "show_house": case "show_camera": return q("#house3dRoot") || main();
      case "look_at_camera": return popup();
      case "set_weather_location": return view?.id === "view-weather" ? main() : q('[data-widget="weather"]');
      default: return null;
    }
  }
  // A spark leaves the orb, arcs across the glass to the target and brackets lock onto it.
  function pointAt(target) {
    if (!target || !A.open) return;
    const r = target.getBoundingClientRect();
    const o = canvas.getBoundingClientRect();
    const from = o.width ? [o.left + o.width / 2, o.top + o.height / 2] : [window.innerWidth - 60, window.innerHeight - 60];
    const to = [Math.min(Math.max(r.left + r.width / 2, 20), window.innerWidth - 20), Math.min(Math.max(r.top + r.height / 2, 20), window.innerHeight - 20)];
    A.dockRect = r;
    dock(r);
    if (HUD.reduced() || !Element.prototype.animate) return lockOn(r);
    const bend = Math.min(220, Math.hypot(to[0] - from[0], to[1] - from[1]) * 0.35);
    const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2 - bend];
    const path = (s) => [
      { transform: `translate(${from[0]}px, ${from[1]}px) scale(${0.4 * s})`, opacity: 0 },
      { transform: `translate(${from[0]}px, ${from[1]}px) scale(${1.4 * s})`, opacity: 1, offset: 0.1 },
      { transform: `translate(${mid[0]}px, ${mid[1]}px) scale(${s})`, opacity: 1, offset: 0.55 },
      { transform: `translate(${to[0]}px, ${to[1]}px) scale(${1.8 * s})`, opacity: 1, offset: 0.92 },
      { transform: `translate(${to[0]}px, ${to[1]}px) scale(${3 * s})`, opacity: 0 }
    ];
    [0, 1, 2, 3].forEach((i) => {
      const dot = document.createElement("i");
      dot.className = `jv-flyer${i ? " is-trail" : ""}`;
      root.appendChild(dot);
      const run = dot.animate(path(i ? 1 - i * 0.2 : 1), { duration: 720, delay: i * 45, easing: "cubic-bezier(.55, 0, .3, 1)", fill: "both" });
      run.onfinish = () => dot.remove();
      if (!i) setTimeout(() => lockOn(target.getBoundingClientRect()), 640);
    });
  }
  function lockOn(r) {
    document.querySelectorAll(".jv-lock").forEach((n) => n.remove());
    const pad = 6, box = document.createElement("div");
    box.className = "jv-lock";
    const left = Math.max(4, r.left - pad), top = Math.max(4, r.top - pad);
    Object.assign(box.style, { left: `${left}px`, top: `${top}px`, width: `${Math.min(window.innerWidth - 4, r.right + pad) - left}px`, height: `${Math.min(window.innerHeight - 4, r.bottom + pad) - top}px` });
    box.innerHTML = "<i></i><i></i><i></i><i></i>";
    root.appendChild(box);
    setTimeout(() => box.remove(), 1900);
  }
  window.addEventListener("resize", () => { if (A.open) place(true); });
  if (window.ResizeObserver) new ResizeObserver(() => { if (A.open) place(); }).observe(stage);

  function showHeard(text) { emit({ heard: text || "" }); HUD.decode(heardEl, text ? `“${text}”` : "", { cps: 160, scramble: 60, caret: false }); }
  // Replies decode onto the glass: each letter flickers through HUD glyphs, then locks in with a flash.
  function showReply(text) {
    text = String(text || "");
    srEl.textContent = text;
    emit({ reply: text });
    HUD.decode(replyEl, text, { cps: Math.max(70, Math.min(140, text.length / 2)), scramble: 120 });
  }
  // Adds a sentence to the reply as it arrives; each one decodes onto the glass on its own.
  function showReplyPart(text) {
    const part = document.createElement("span");
    if (replyEl.childNodes.length) replyEl.append(" ");
    replyEl.append(part);
    srEl.textContent = `${srEl.textContent} ${text}`.trim();
    emit({ reply: srEl.textContent });
    HUD.decode(part, text, { cps: Math.max(70, Math.min(140, text.length / 2)), scramble: 120 });
  }
  // A short log of what Jarvis just did ("Lights on", "Task added"), shown under the reply.
  // Lines arrive one after another, each sliding in and decoding like a system readout.
  let logSlot = 0;
  function logAction(text, failed = false) {
    const item = document.createElement("li");
    item.className = failed ? "is-error" : "";
    const now = performance.now();
    logSlot = Math.max(now, logSlot) + 160;
    const delay = logSlot - now - 160;
    item.style.animationDelay = `${delay}ms`;
    logEl.append(item);
    HUD.decode(item, text.replace(/\.$/, ""), { cps: 120, scramble: 90, caret: false, delay });
    while (logEl.children.length > 5) logEl.firstElementChild.remove();
  }
  function clearLog() { logEl.replaceChildren(); logSlot = 0; }

  // Side readouts on the stage: live time, link status and what Jarvis is doing.
  function telemetry(fresh = false) {
    if (!A.open && !fresh) return;
    const now = new Date(), pad = (n) => String(n).padStart(2, "0");
    const turns = A.conversation.filter((m) => m.role === "user" && m.content.some?.((b) => b.type === "text")).length;
    const left = [
      `T ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
      now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" }).toUpperCase(),
      `MIC · ${SR && !A.srUnavailable ? "ACTIVE" : A.status?.serverTranscription ? "RELAY" : "TYPE"}`,
      `TIMERS · ${pad(loadTimers().length)}`
    ];
    const right = [
      `CORE · ${A.status?.configured ? "ONLINE" : "OFFLINE"}`,
      `MODE · ${(A.state === "speaking" ? "VOICE" : A.state).toUpperCase()}`,
      `TURN · ${pad(turns)}`,
      `LINK · ${navigator.onLine === false ? "LOST" : "SECURE"}`
    ];
    [[teleL, left], [teleR, right]].forEach(([box, lines]) => {
      if (fresh || box.children.length !== lines.length) {
        box.replaceChildren(...lines.map(() => document.createElement("div")));
        lines.forEach((line, i) => HUD.decode(box.children[i], line, { cps: 50, scramble: 120, caret: false, delay: 500 + i * 120 }));
      } else lines.forEach((line, i) => { const row = box.children[i]; if (!row.classList.contains("hud-writing") && row.textContent !== line) row.textContent = line; });
    });
  }

  // The first conversation of the day opens with a short briefing.
  const briefKey = "reflect-os-assistant-briefed";
  function today() { return new Date().toISOString().slice(0, 10); }
  function firstToday() { try { return localStorage.getItem(briefKey) !== today(); } catch { return false; } }
  function markBriefed() { try { localStorage.setItem(briefKey, today()); } catch {} }

  // ---------- Mirror context ----------
  function activeScreen() {
    const id = document.querySelector(".view.is-active")?.id || "view-home";
    return id.replace("view-", "").replace("homekit", "smart_home");
  }
  function weatherLines() {
    const w = typeof weatherData !== "undefined" ? weatherData : null;
    if (!w?.current) return ["Weather: not loaded yet."];
    const c = w.current, d = w.daily || {};
    const lines = [`Weather in ${profile.weather.place} now: ${Math.round(c.temperature_2m)}°C (feels like ${Math.round(c.apparent_temperature)}°C), ${weatherLabel(c.weather_code).toLowerCase()}, wind ${Math.round(c.wind_speed_10m)} km/h.`];
    (d.time || []).slice(0, 7).forEach((day, i) => {
      lines.push(`${i === 0 ? "Today" : i === 1 ? "Tomorrow" : new Date(`${day}T12:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" })}: ${weatherLabel(d.weather_code[i]).toLowerCase()}, high ${Math.round(d.temperature_2m_max[i])}°C, low ${Math.round(d.temperature_2m_min[i])}°C, ${d.precipitation_probability_max?.[i] ?? 0}% chance of rain${i === 0 && d.sunset?.[0] ? `, sunset ${String(d.sunset[0]).slice(11, 16)}` : ""}.`);
    });
    // The next 24 hours, hour by hour, for "will it rain at three?".
    const h = w.hourly || {}, nowHour = new Date().toISOString().slice(0, 13);
    const local = (t) => new Date(t).toISOString().slice(0, 13);
    const start = (h.time || []).findIndex((t) => { try { return local(t) >= nowHour; } catch { return false; } });
    if (start >= 0) lines.push(`Next 24 hours (time temp rain%): ${h.time.slice(start, start + 24).map((t, i) => `${String(t).slice(11, 16)} ${Math.round(h.temperature_2m[start + i])}° ${h.precipitation_probability?.[start + i] ?? 0}%`).join(", ")}.`);
    return lines;
  }
  // The devices Jarvis is told about. Things he can act on come first, and the housekeeping sensors
  // (battery, signal, firmware...) that Ring, Tado and Hue add by the dozen are left out, so a long
  // list can never push the TV or the lights out of sight.
  const deviceOrder = ["media_player", "light", "climate", "switch", "fan", "cover", "lock", "alarm_control_panel", "scene", "script", "camera", "person", "event", "binary_sensor", "sensor"];
  const noisyClasses = new Set(["battery", "signal_strength", "voltage", "current", "timestamp", "duration", "data_rate", "data_size", "power_factor", "frequency", "enum", "update"]);
  const noisyIds = /battery|signal|rssi|linkquality|wi_?fi|firmware|uptime|last_(seen|update|activity|ding|motion)|voltage|ip_address|update_available|tamper/i;
  function jarvisDevices() {
    const rank = (e) => { const i = deviceOrder.indexOf(e.domain); return i < 0 ? deviceOrder.length : i; };
    const usable = homeAssistantEntities
      .filter((e) => e.state !== "unavailable" && e.state !== "unknown")
      .filter((e) => !["sensor", "binary_sensor"].includes(e.domain) || (!noisyClasses.has(e.deviceClass) && !noisyIds.test(e.id)))
      .sort((a, b) => rank(a) - rank(b));
    const info = (e) => ["event", "binary_sensor", "sensor"].includes(e.domain);
    return [...usable.filter((e) => !info(e)).slice(0, 160), ...usable.filter(info).slice(0, 60)];
  }
  async function mirrorContext() {
    if (connected("smartHome") && !homeAssistantEntities.length) { try { await loadHomeAssistant(); } catch {} }
    const now = new Date();
    const lines = [
      `Time: ${now.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      `Person: ${profile.personName || "unknown"}`,
      `Screen showing: ${activeScreen()}${activeScreen() === "calendar" ? ` (${calendarView} view${calendarFocus ? `, showing ${calendarFocus}` : ""})` : activeScreen() === "tasks" ? ` (${taskFilter} tasks)` : ""}${document.body.classList.contains("jv-asleep") ? " (screen asleep)" : ""}`,
      `First conversation today: ${firstToday() ? "yes" : "no"}`,
      ...weatherLines()
    ];
    const events = sortedEvents().filter((e) => {
      const raw = e.start || `${e.date || ""}T${e.time || "00:00"}`;
      const date = new Date(raw);
      return Number.isNaN(date.valueOf()) || date >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }).slice(0, 10);
    lines.push(`Google Calendar: ${connected("googleCalendar") ? "connected (new events go there)" : "not connected (events stay on the mirror)"}.`);
    lines.push(events.length ? "Calendar (id | source | title | when | location):" : "Calendar: nothing coming up.");
    events.forEach((e) => lines.push(`- ${e.id || "?"} | ${e.source === "google" ? "Google" : "on-device"} | ${e.title} | ${e.allDay ? `${String(e.start).slice(0, 10)} all day` : (e.start || `${e.date} ${e.time}`)}${e.location ? ` | ${e.location}` : ""}`));
    const tasks = sampleData.tasks.filter((t) => !t.done).slice(0, 20);
    lines.push(tasks.length ? "Open tasks (id | title | when | category):" : "Open tasks: none.");
    tasks.forEach((t) => lines.push(`- ${t.id} | ${t.title} | ${t.when || "Today"} | ${t.category || "Personal"}${t.priority ? " | high priority" : ""}`));
    if (!connected("spotify")) lines.push("Music: Spotify not connected.");
    else { const tr = sampleData.track || {}; lines.push(`Music: ${tr.playing ? "playing" : "paused"} ${tr.title && tr.title !== "Nothing playing" ? `"${tr.title}" by ${tr.artist}` : "(nothing loaded)"}.`); }
    if (!connected("smartHome")) lines.push("Smart home: Home Assistant not connected.");
    else {
      const rooms = [...new Map(homeAssistantEntities.filter((e) => e.areaId).map((e) => [e.areaId, e.area])).entries()];
      lines.push(rooms.length ? `Rooms (area id = name): ${rooms.map(([id, name]) => `${id} = ${name}`).join(", ")}.` : "Rooms: none set up in Home Assistant.");
      lines.push("Smart home devices (entity id | name | room | state):");
      jarvisDevices().forEach((e) => lines.push(`- ${e.id} | ${e.name} | ${e.area || "no room"} | ${e.state}${e.unit ? ` ${e.unit}` : ""}${e.brightness != null && e.state === "on" ? ` | brightness ${Math.round(e.brightness / 2.55)}%` : ""}${e.rgb && e.state === "on" ? ` | colour rgb(${e.rgb.join(",")})` : ""}${e.canColor ? " | colour bulb" : ""}${e.temperature != null ? ` | target ${e.temperature}` : ""}${e.percentage != null ? ` | speed ${e.percentage}%` : ""}${e.domain === "media_player" ? ` | TV/speaker${e.media?.title ? `, playing ${e.media.title}` : ""}${e.media?.volume != null ? `, volume ${Math.round(e.media.volume * 100)}%` : ""}${e.media?.source ? `, on ${e.media.source}` : ""}${e.media?.sources?.length ? `, sources: ${e.media.sources.slice(0, 25).join(" / ")}` : ""}` : ""}${e.domain === "alarm_control_panel" ? " | burglar alarm" : ""}${e.domain === "event" ? " | last happened at this time" : ""}`));
    }
    if (connected("smartHome")) { try { lines.push(...(window.ReflectHome3D?.describe() || [])); } catch {} }
    const timers = loadTimers();
    lines.push(timers.length ? "Timers, reminders and scheduled actions (id | kind | label | due | repeat):" : "Timers, reminders and scheduled actions: none.");
    timers.forEach((t) => lines.push(`- ${t.id} | ${t.kind === "action" ? "scheduled action" : t.kind} | ${t.label} | ${new Date(t.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", second: t.kind === "timer" ? "2-digit" : undefined })}${t.repeat && t.repeat !== "none" ? ` | ${t.repeat}` : ""}`));
    const rules = loadRules();
    if (rules.length) { lines.push("Device rules (id | label | when):"); rules.forEach((r) => lines.push(`- ${r.id} | ${r.label} | ${r.entity_id} becomes ${r.state}${r.once ? ", once" : ""}`)); }
    const routines = loadRoutines();
    lines.push(routines.length ? `Their saved routines: ${routines.map((r) => `${r.name} (${r.steps.length} steps)`).join(", ")}.` : "Their saved routines: none yet.");
    const shown = Object.entries(profile.widgets || {}).filter(([, w]) => w.visible).map(([id]) => id);
    lines.push(`Home widgets showing: ${shown.join(", ") || "none"}.`);
    lines.push(`Display: brightness ${profile.brightness}%, night mode ${profile.nightMode ? "on" : "off"}, warmth ${profile.warmth || 0}%, appearance ${profile.theme}, accent ${profile.accentColor}, ${profile.clockFormat}-hour clock. Your speaking volume: ${Math.round(voiceVolume() * 100)}%.`);
    const layout = Object.entries(profile.widgets || {}).filter(([, w]) => w.visible).map(([id, w]) => `${id} ${w.zone} ${w.size}`);
    lines.push(`Home layout (widget zone size): ${layout.join(", ") || "empty"}.`);
    const memory = await loadMemory();
    lines.push(memory.facts.length ? "What you've learned about them:" : "What you've learned about them: nothing yet.");
    memory.facts.forEach((f) => lines.push(`- ${f}`));
    // Only exchanges from before this conversation; the ones in it are already in the history.
    const earlier = memory.recent.filter((r) => r.at < A.convStart).slice(-8);
    if (earlier.length) {
      lines.push("Earlier conversations (oldest first):");
      earlier.forEach((r) => lines.push(`- ${new Date(r.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}: they said "${r.q}"; you said "${r.a}"`));
    }
    return lines.join("\n");
  }

  // ---------- Memory ----------
  // What Jarvis has learned and the last few exchanges live in the person's account on the server,
  // so they survive restarts and updates.
  // A copy is also kept in the browser, for when nobody is signed in.
  async function loadMemory() {
    if (A.memory) return A.memory;
    let d = null;
    try { const r = await fetch("/api/jarvis-memory", { credentials: "same-origin" }); if (r.ok) d = await r.json(); } catch {}
    if (!d) { try { d = JSON.parse(localStorage.getItem("reflect-jarvis-memory") || "null"); } catch {} }
    A.memory = { facts: Array.isArray(d?.facts) ? d.facts : [], recent: Array.isArray(d?.recent) ? d.recent : [] };
    return A.memory;
  }
  function saveMemory() {
    if (!A.memory) return;
    try { localStorage.setItem("reflect-jarvis-memory", JSON.stringify(A.memory)); } catch {}
    fetch("/api/jarvis-memory", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(A.memory) }).catch(() => {});
  }
  function rememberExchange(q, a) {
    if (!A.memory || !q || !a) return;
    A.memory.recent = [...A.memory.recent, { q: q.slice(0, 300), a: a.slice(0, 400), at: Date.now() }].slice(-12);
    saveMemory();
  }
  const words = (t) => new Set(String(t).toLowerCase().match(/[a-z0-9']+/g) || []);

  // ---------- Tools ----------
  // Opens the 3D House screen and waits (briefly) for the house to load before Jarvis drives it.
  async function house3d() {
    if (!connected("smartHome")) throw new Error("Home Assistant is not connected.");
    const H = window.ReflectHome3D;
    if (!H) throw new Error("The 3D house isn't available.");
    showView("house3d", false);
    H.ensure?.();
    for (let i = 0; i < 50 && !H.describe().length; i++) await new Promise((r) => setTimeout(r, 100));
    if (!H.describe().length) throw new Error("The 3D house is still loading.");
    return H;
  }
  async function runTool(tool, input) {
    if (tool === "show_room" || tool === "show_house" || tool === "show_camera" || tool === "run_scene") {
      const house = await house3d();
      if (tool === "show_room") return `Showing the ${house.showRoom(input.room)}.`;
      if (tool === "show_house") {
        if (input.floor === "downstairs" || input.floor === "upstairs") { house.showFloor(input.floor); return `Showing ${input.floor}.`; }
        house.showHouse(); return "Showing the whole house.";
      }
      if (tool === "show_camera") return `Showing the ${house.showCamera(input.camera)} camera.`;
      return `${await house.runScene(input.scene)} scene running.`;
    }
    if (tool === "show_screen") {
      if (input.screen === "back") { const prev = goBack(); if (!prev) throw new Error("There's no screen to go back to."); return `Back to ${prev.replace("homekit", "smart home").replace("house3d", "the 3D house")}.`; }
      const view = input.screen === "smart_home" ? "homekit" : input.screen === "house" ? "house3d" : input.screen;
      if (!document.getElementById(`view-${view}`)) throw new Error(`There is no ${input.screen} screen.`);
      showView(view, false);
      return `Now showing ${input.screen}.`;
    }
    if (tool === "control_device") {
      if (!connected("smartHome")) throw new Error("Home Assistant is not connected.");
      let d, data, label;
      if (input.entity_id) {
        const entity = homeAssistantEntities.find((e) => e.id === input.entity_id);
        if (!entity) throw new Error(`No device with id ${input.entity_id}.`);
        d = entity.domain; data = { entity_id: entity.id }; label = entity.name;
      } else if (input.area_id) {
        const inRoom = homeAssistantEntities.filter((e) => e.areaId === input.area_id);
        if (!inRoom.length) throw new Error(`No room with id ${input.area_id}.`);
        d = input.domain || "light";
        if (!inRoom.some((e) => e.domain === d)) throw new Error(`There is no ${d} in ${inRoom[0].area}.`);
        data = { area_id: input.area_id }; label = `the ${inRoom[0].area} ${d === "light" ? "lights" : `${d} devices`}`;
      } else throw new Error("Say which device or room.");
      const service = { turn_on: `${d}.turn_on`, turn_off: `${d}.turn_off`, toggle: `${d}.toggle`, activate: "scene.turn_on", lock: "lock.lock", unlock: "lock.unlock", open: "cover.open_cover", close: "cover.close_cover", set_temperature: "climate.set_temperature", heating_off: "climate.set_hvac_mode", heating_schedule: "climate.set_hvac_mode",
        play: "media_player.media_play", pause: "media_player.media_pause", play_pause: "media_player.media_play_pause", next: "media_player.media_next_track", previous: "media_player.media_previous_track",
        volume_up: "media_player.volume_up", volume_down: "media_player.volume_down", mute: "media_player.volume_mute", unmute: "media_player.volume_mute", set_volume: "media_player.volume_set", select_source: "media_player.select_source",
        set_position: "cover.set_cover_position", set_percentage: "fan.set_percentage", arm_home: "alarm_control_panel.alarm_arm_home", arm_away: "alarm_control_panel.alarm_arm_away", arm_night: "alarm_control_panel.alarm_arm_night", disarm: "alarm_control_panel.alarm_disarm" }[input.action];
      if (!service) throw new Error(`Unknown action ${input.action}.`);
      Object.assign(data, lightOptions(d, input));
      if (service.startsWith("media_player.") && d !== "media_player" && !["turn_on", "turn_off", "toggle"].includes(input.action)) throw new Error(`${label} isn't a TV or speaker.`);
      if (input.action === "mute" || input.action === "unmute") data.is_volume_muted = input.action === "mute";
      if (input.action === "set_volume") { if (!Number.isFinite(input.volume_pct)) throw new Error("A volume is needed."); data.volume_level = Math.max(0, Math.min(100, input.volume_pct)) / 100; }
      if (input.action === "select_source") {
        const entity = homeAssistantEntities.find((e) => e.id === data.entity_id), wanted = String(input.source || "").trim();
        if (!wanted) throw new Error("Which input or app?");
        const list = entity?.media?.sources || [], low = wanted.toLowerCase();
        data.source = list.find((x) => x.toLowerCase() === low) || list.find((x) => x.toLowerCase().includes(low)) || list.find((x) => low.includes(x.toLowerCase())) || wanted;
      }
      if (input.action === "set_position") { if (!Number.isFinite(input.position)) throw new Error("How far open?"); data.position = Math.max(0, Math.min(100, Math.round(input.position))); }
      if (input.action === "set_percentage") { if (!Number.isFinite(input.percentage)) throw new Error("What speed?"); data.percentage = Math.max(0, Math.min(100, Math.round(input.percentage))); }
      if (input.action.startsWith("arm_") || input.action === "disarm") { if (input.code) data.code = String(input.code); }
      if (Number.isFinite(input.transition) && d === "light" && ["turn_on", "turn_off"].includes(input.action)) data.transition = Math.max(0, Math.min(3600, input.transition));
      if (input.action === "heating_off") data.hvac_mode = "off";
      if (input.action === "heating_schedule") data.hvac_mode = "auto";
      if (input.action === "set_temperature") { if (!Number.isFinite(input.temperature)) throw new Error("A temperature is needed."); data.temperature = input.temperature; }
      try { await api("/api/homeassistant/service", { method: "POST", body: JSON.stringify({ service, data }) }); }
      catch (error) {
        // Some TVs only understand the one play/pause button, the same one the mirror's own controls press.
        if (!["play", "pause"].includes(input.action)) throw error;
        await api("/api/homeassistant/service", { method: "POST", body: JSON.stringify({ service: "media_player.media_play_pause", data }) });
      }
      window.dispatchEvent(new CustomEvent("reflect:home-action", { detail: { entityIds: data.entity_id ? [data.entity_id] : [], areaIds: data.area_id ? [data.area_id] : [] } }));
      setTimeout(loadHomeAssistant, 700);
      return `${service} sent to ${label}.`;
    }
    if (tool === "music") {
      // "Pause" with no Spotify means whatever is playing on a TV or speaker.
      const tv = homeAssistantEntities.filter((e) => e.domain === "media_player").sort((a, b) => (b.state === "playing") - (a.state === "playing") || (b.state === "paused") - (a.state === "paused"))[0];
      const tvAction = ["play", "pause", "next", "previous"].includes(input.action);
      if (!connected("spotify") && tv && tvAction) return runTool("control_device", { entity_id: tv.id, action: input.action });
      if (!connected("spotify") && tv && /^volume/.test(input.action)) return runTool("control_device", { entity_id: tv.id, action: input.action === "volume" ? "set_volume" : input.action, volume_pct: input.volume_pct });
      if (!connected("spotify")) throw new Error("Spotify isn't connected. Connect it in Settings, Connections.");
      // Spotify connected but quiet while the TV is playing: "pause" means the TV.
      if (connected("spotify") && tv && tvAction && !sampleData.track?.playing && (input.action === "pause" ? tv.state === "playing" : tv.state === "paused")) return runTool("control_device", { entity_id: tv.id, action: input.action });
      const done = await spotifyCommand(input);
      setTimeout(loadSpotify, 900);
      return done;
    }
    if (tool === "add_task") {
      const title = String(input.title || "").trim().slice(0, 80);
      if (!title) throw new Error("The task needs a title.");
      sampleData.tasks.unshift({ id: crypto.randomUUID(), title, category: input.category || "Personal", when: input.when || "Today", priority: Boolean(input.high_priority), done: false });
      saveDeviceData(); renderTaskPage(); renderHome();
      return `Added task "${title}".`;
    }
    if (tool === "complete_task") {
      const task = sampleData.tasks.find((t) => t.id === input.task_id);
      if (!task) throw new Error("That task is not on the list.");
      task.done = true;
      saveDeviceData(); renderTaskPage(); renderHome();
      return `Completed "${task.title}".`;
    }
    if (tool === "add_event") {
      const title = String(input.title || "").trim().slice(0, 80);
      if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(input.date || "") || !/^\d{2}:\d{2}$/.test(input.time || "")) throw new Error("The event needs a title, a YYYY-MM-DD date and an HH:MM time.");
      if (input.calendar !== "mirror" && connected("googleCalendar")) {
        await api("/api/google/calendar/events", { method: "POST", body: JSON.stringify({ title, start: new Date(`${input.date}T${input.time}:00`).toISOString(), minutes: input.minutes, location: input.location || "" }) });
        await loadGoogleCalendar();
        return `Added "${title}" to Google Calendar on ${input.date} at ${input.time}.`;
      }
      sampleData.events.push({ id: crypto.randomUUID(), title, date: input.date, time: input.time, location: String(input.location || "").trim().slice(0, 80), source: "device" });
      saveDeviceData(); renderCalendarPage(); renderHome();
      return `Added "${title}" on ${input.date} at ${input.time}.`;
    }
    if (tool === "update_task") {
      const task = sampleData.tasks.find((t) => t.id === input.task_id);
      if (!task) throw new Error("That task is not on the list.");
      if (input.delete) {
        sampleData.tasks = sampleData.tasks.filter((t) => t !== task);
        saveDeviceData(); renderTaskPage(); renderHome();
        return `Deleted task "${task.title}".`;
      }
      if (typeof input.done === "boolean") task.done = input.done;
      if (input.title) task.title = String(input.title).trim().slice(0, 80) || task.title;
      if (input.when) task.when = input.when;
      if (typeof input.high_priority === "boolean") task.priority = input.high_priority;
      saveDeviceData(); renderTaskPage(); renderHome();
      return `Updated task "${task.title}".`;
    }
    if (tool === "update_event") {
      const event = sampleData.events.find((e) => e.id === input.event_id);
      if (!event) throw new Error("That event is not on the calendar.");
      if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("The date must be YYYY-MM-DD.");
      if (input.time && !/^\d{2}:\d{2}$/.test(input.time)) throw new Error("The time must be HH:MM.");
      const old = new Date(event.start || `${event.date}T${event.time || "09:00"}`);
      const pad = (n) => String(n).padStart(2, "0");
      const date = input.date || (Number.isNaN(old.valueOf()) ? "" : `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`);
      const time = input.time || (Number.isNaN(old.valueOf()) ? "09:00" : `${pad(old.getHours())}:${pad(old.getMinutes())}`);
      const moved = Boolean(input.date || input.time || input.minutes);
      if (event.source === "google") {
        const length = input.minutes || (event.end && !Number.isNaN(old.valueOf()) ? Math.round((new Date(event.end) - old) / 60000) : 60);
        await api(`/api/google/calendar/events/${encodeURIComponent(event.id)}`, { method: "PATCH", body: JSON.stringify({ ...(input.title ? { title: input.title } : {}), ...(input.location !== undefined ? { location: input.location } : {}), ...(moved ? { start: new Date(`${date}T${time}:00`).toISOString(), minutes: length } : {}) }) });
        await loadGoogleCalendar();
      } else {
        if (input.title) event.title = String(input.title).trim().slice(0, 80) || event.title;
        if (input.location !== undefined) event.location = String(input.location || "").slice(0, 80);
        if (moved) { event.date = date; event.time = time; delete event.start; }
        saveDeviceData(); renderCalendarPage(); renderHome();
      }
      return `Updated "${input.title || event.title}"${moved ? ` to ${date} at ${time}` : ""}.`;
    }
    if (tool === "delete_event") {
      const event = sampleData.events.find((e) => e.id === input.event_id);
      if (!event) throw new Error("That event is not on the calendar.");
      if (event.source === "google") {
        await api(`/api/google/calendar/events/${encodeURIComponent(event.id)}`, { method: "DELETE" });
        await loadGoogleCalendar();
        return `Cancelled "${event.title}" in Google Calendar.`;
      }
      sampleData.events = sampleData.events.filter((e) => e !== event);
      saveDeviceData(); renderCalendarPage(); renderHome();
      return `Deleted "${event.title}".`;
    }
    if (tool === "set_timer") {
      const ms = (Number(input.minutes) || 0) * 60000 + (Number(input.seconds) || 0) * 1000;
      if (ms < 1000 || ms > 24 * 3600000) throw new Error("Timers can run from one second to 24 hours.");
      const label = String(input.label || "").trim().slice(0, 40) || durationText(ms);
      addTimer({ kind: "timer", label, at: Date.now() + ms });
      return `Timer set: ${label}, ${durationText(ms)}.`;
    }
    if (tool === "set_reminder") {
      const text = String(input.text || "").trim().slice(0, 120);
      if (!text || !/^\d{2}:\d{2}$/.test(input.time || "")) throw new Error("A reminder needs some text and an HH:MM time.");
      let at;
      if (input.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("The date must be YYYY-MM-DD.");
        at = new Date(`${input.date}T${input.time}:00`).getTime();
      } else {
        const [h, m] = input.time.split(":").map(Number);
        const next = new Date(); next.setHours(h, m, 0, 0);
        if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
        at = next.getTime();
      }
      if (!Number.isFinite(at) || at <= Date.now()) throw new Error("That time has already passed.");
      const repeat = ["daily", "weekdays", "weekends", "weekly"].includes(input.repeat) ? input.repeat : "none";
      if (repeat !== "none") at = nextRepeat(at, repeat, true);
      addTimer({ kind: "reminder", label: text, at, repeat });
      if (repeat !== "none") return `Reminder set ${repeat === "weekly" ? `every ${new Date(at).toLocaleDateString("en-GB", { weekday: "long" })}` : repeat === "daily" ? "every day" : `on ${repeat}`} at ${input.time}: ${text}.`;
      return `Reminder set for ${new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${text}.`;
    }
    if (tool === "cancel_timer") {
      const timers = loadTimers(), rules = loadRules();
      const keep = input.id === "all" ? [] : timers.filter((t) => t.id !== input.id);
      const keepRules = input.id === "all" ? [] : rules.filter((r) => r.id !== input.id);
      if (keep.length === timers.length && keepRules.length === rules.length) throw new Error("Nothing with that id is set.");
      saveTimers(keep); saveRules(keepRules);
      return input.id === "all" ? "Cancelled every timer and reminder." : "Cancelled.";
    }
    if (tool === "set_weather_location") {
      const query = String(input.place || "").trim();
      if (query.length < 2) throw new Error("Which place?");
      const { locations = [] } = await api(`/api/weather/locations?q=${encodeURIComponent(query)}`);
      if (!locations.length) throw new Error(`I couldn't find ${query}.`);
      await selectWeatherLocation(locations[0]);
      return `Weather now set to ${[locations[0].name, locations[0].country].filter(Boolean).join(", ")}.`;
    }
    if (tool === "show_widget") {
      const widget = profile.widgets?.[input.widget], addOn = baseWidgets[input.widget]?.addOn;
      if (!widget || (addOn && !addOnInstalled(addOn))) throw new Error(`The ${input.widget} widget needs its add-on installed first, in Settings.`);
      if (input.widget === "photos" && input.visible && !photoRecords.length) throw new Error("There are no photos on the mirror yet. Add some in Settings, Photos.");
      widget.visible = Boolean(input.visible);
      saveProfile(); renderHome(); renderWidgetSettings();
      return `${input.widget} widget ${widget.visible ? "shown" : "hidden"}.`;
    }
    if (tool === "change_voice") {
      if (A.status?.builtInVoice) {
        const wanted = String(input.name || "").toLowerCase();
        const current = kokoroVoices.indexOf(kokoroVoice());
        const next = wanted ? kokoroVoices.find((v) => v.includes(wanted)) : kokoroVoices[(current + 1) % kokoroVoices.length];
        if (!next) throw new Error(`There's no voice called ${input.name}. I have ${kokoroVoices.map((v) => v.slice(3)).join(", ")}.`);
        try { localStorage.setItem(kokoroKey, next); } catch {}
        return `Voice changed to ${next.slice(3)} (${next.startsWith("bf") ? "British woman" : "British man"}). Voices: ${kokoroVoices.map((v) => v.slice(3)).join(", ")}.`;
      }
      if (A.status?.serverVoice) throw new Error(`I'm using the ${A.status.voiceProvider || "server"} voice, which is set in reflect-os.config.json.`);
      const voices = britishVoices();
      if (!voices.length) throw new Error("This browser has no British voices to choose from.");
      const current = voices.findIndex((v) => v.name === (A.voice || pickVoice())?.name);
      const wanted = String(input.name || "").toLowerCase();
      const next = wanted ? voices.find((v) => v.name.toLowerCase().includes(wanted)) : voices[(current + 1) % voices.length];
      if (!next) throw new Error(`There's no voice called ${input.name}. I have ${voices.map((v) => v.name).join(", ")}.`);
      A.voice = next;
      try { localStorage.setItem(voiceKey, next.name); } catch {}
      return `Voice changed to ${next.name}, ${voices.indexOf(next) + 1} of ${voices.length}: ${voices.map((v) => v.name).join(", ")}.`;
    }
    if (tool === "remember" || tool === "forget") {
      const memory = await loadMemory(), fact = String(input.fact || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!fact) throw new Error("Nothing to remember.");
      const want = words(fact), score = (f) => { const have = words(f); let n = 0; want.forEach((w) => { if (have.has(w)) n++; }); return n / Math.max(want.size, have.size, 1); };
      if (tool === "remember") {
        if (memory.facts.some((f) => f.toLowerCase() === fact.toLowerCase())) return "Already known.";
        memory.facts = [...memory.facts, fact].slice(-80);
        saveMemory();
        return `Remembered: ${fact}`;
      }
      const best = memory.facts.map((f) => [f, score(f)]).sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] < 0.3) throw new Error("I don't have that saved.");
      memory.facts = memory.facts.filter((f) => f !== best[0]);
      saveMemory();
      return `Forgot: ${best[0]}`;
    }
    if (tool === "set_display") {
      if (input.screen === "off") { setTimeout(sleepScreen, 2500); return "Screen going to sleep. Say my name or touch the glass to wake it."; }
      if (input.screen === "on") wakeScreen();
      if (Number.isFinite(input.brightness)) profile.brightness = Math.max(30, Math.min(100, Math.round(input.brightness)));
      if (typeof input.night_mode === "boolean") profile.nightMode = input.night_mode;
      if (Number.isFinite(input.warmth)) profile.warmth = Math.max(0, Math.min(100, Math.round(input.warmth)));
      if (["dark", "light", "auto"].includes(input.appearance)) profile.theme = input.appearance;
      if (input.clock_format === "12" || input.clock_format === "24") profile.clockFormat = input.clock_format;
      if (input.accent_color) {
        const hex = colourHex(input.accent_color);
        if (!hex) throw new Error(`I don't know the colour ${input.accent_color}.`);
        profile.accentColor = hex;
      }
      saveProfile(); applyProfile(); renderHome(); renderSettings();
      return `Display brightness ${profile.brightness}%, night mode ${profile.nightMode ? "on" : "off"}, warmth ${profile.warmth || 0}%, ${profile.theme} appearance, ${profile.clockFormat}-hour clock, accent ${profile.accentColor}.`;
    }
    if (tool === "navigate") return navigate(input);
    if (tool === "say") { const text = String(input.text || "").trim(); if (text) announce(text); return "Said it."; }
    if (tool === "home_screen") return homeScreen(input);
    if (tool === "schedule") {
      const actions = checkSteps(input.actions);
      const label = String(input.label || "").trim().slice(0, 60) || "Scheduled";
      const repeat = ["daily", "weekdays", "weekends", "weekly"].includes(input.repeat) ? input.repeat : "none";
      let at;
      if (input.at) {
        if (!/^\d{2}:\d{2}$/.test(input.at)) throw new Error("The time must be HH:MM.");
        if (input.date && !/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("The date must be YYYY-MM-DD.");
        const when = input.date ? new Date(`${input.date}T${input.at}:00`) : (() => { const [h, m] = input.at.split(":").map(Number), n = new Date(); n.setHours(h, m, 0, 0); if (n <= new Date()) n.setDate(n.getDate() + 1); return n; })();
        at = when.getTime();
      } else {
        const ms = (Number(input.in_minutes) || 0) * 60000 + (Number(input.in_seconds) || 0) * 1000;
        if (ms < 1000) throw new Error("When should I do it?");
        at = Date.now() + ms;
      }
      if (!Number.isFinite(at) || at <= Date.now()) throw new Error("That time has already passed.");
      if (repeat !== "none") at = nextRepeat(at, repeat, true);
      addTimer({ kind: "action", label, at, repeat, actions, say: String(input.say || "").slice(0, 200) });
      return `Scheduled "${label}" for ${new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", second: at - Date.now() < 120000 ? "2-digit" : undefined })}${repeat !== "none" ? `, repeating ${repeat}` : ""}.`;
    }
    if (tool === "when_device") {
      const actions = checkSteps(input.actions);
      if (!homeAssistantEntities.some((e) => e.id === input.entity_id)) throw new Error(`No device with id ${input.entity_id}.`);
      const state = String(input.state || "").trim().toLowerCase();
      if (!state) throw new Error("Which state should I watch for?");
      const rule = { id: `r${Date.now().toString(36)}`, label: String(input.label || "").slice(0, 60) || `When ${input.entity_id} is ${state}`, entity_id: input.entity_id, state, once: Boolean(input.once), actions, say: String(input.say || "").slice(0, 200) };
      saveRules([...loadRules(), rule].slice(-30));
      return `Rule saved: ${rule.label}.`;
    }
    if (tool === "routine") {
      const key = String(input.name || "").trim().toLowerCase();
      if (!key) throw new Error("Which routine?");
      const list = loadRoutines(), found = list.find((r) => r.name.toLowerCase() === key) || list.find((r) => r.name.toLowerCase().includes(key) || key.includes(r.name.toLowerCase()));
      if (input.action === "save") {
        const steps = checkSteps(input.steps);
        saveRoutines([...list.filter((r) => r.name.toLowerCase() !== key), { name: String(input.name).trim().slice(0, 40), steps }].slice(-30));
        return `Routine "${input.name}" saved with ${steps.length} step${steps.length === 1 ? "" : "s"}.`;
      }
      if (!found) throw new Error(`There's no routine called ${input.name}.`);
      if (input.action === "delete") { saveRoutines(list.filter((r) => r !== found)); return `Deleted the ${found.name} routine.`; }
      const done = await runSteps(found.steps);
      return `Ran ${found.name}: ${done}`;
    }
    if (tool === "look_at_camera") {
      if (!connected("smartHome")) throw new Error("Home Assistant is not connected.");
      const cams = homeAssistantEntities.filter((e) => e.domain === "camera");
      if (!cams.length) throw new Error("There are no cameras connected.");
      const want = String(input.camera || "").toLowerCase();
      const cam = (want && (cams.find((c) => c.id === want) || cams.find((c) => `${c.id} ${c.name}`.toLowerCase().includes(want)))) || cams.find((c) => /door|ring|bell/i.test(`${c.id} ${c.name}`) && !/live_view/.test(c.id)) || cams.find((c) => /door|ring|bell/i.test(`${c.id} ${c.name}`)) || cams[0];
      const response = await fetch(`/api/homeassistant/camera/${encodeURIComponent(cam.id)}?still=1&t=${Date.now()}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`The ${cam.name} camera isn't sending a picture right now.`);
      const blob = await response.blob();
      if (!/^image\/(jpeg|png|webp|gif)/.test(blob.type) || blob.size > 4.5e6) throw new Error(`The ${cam.name} camera picture couldn't be read.`);
      const data = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1]); r.onerror = reject; r.readAsDataURL(blob); });
      return { text: `Looked at the ${cam.name} camera.`, content: [{ type: "text", text: `The ${cam.name} camera's picture right now (${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}). Describe briefly who or what is there.` }, { type: "image", source: { type: "base64", media_type: blob.type.split(";")[0], data } }] };
    }
    if (tool === "device_history") {
      if (!connected("smartHome")) throw new Error("Home Assistant is not connected.");
      const ids = (Array.isArray(input.entity_ids) ? input.entity_ids : []).filter((id) => homeAssistantEntities.some((e) => e.id === id));
      if (!ids.length) throw new Error("None of those devices are in the list.");
      const hours = Math.max(1, Math.min(168, Number(input.hours) || 24));
      const { changes = [] } = await api(`/api/homeassistant/history?ids=${encodeURIComponent(ids.join(","))}&hours=${hours}`);
      const name = (id) => homeAssistantEntities.find((e) => e.id === id)?.name || id;
      const fmt = (iso) => new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
      if (!changes.length) return `Nothing recorded for ${ids.map(name).join(", ")} in the last ${hours} hours.`;
      // An event entity's state is the time it happened; anything else, what it changed to.
      return `In the last ${hours} hours: ${changes.slice(-25).map((c) => Number.isFinite(Date.parse(c.state)) && /T/.test(c.state) ? `${name(c.id)} at ${fmt(c.state)}` : `${name(c.id)} ${c.state} at ${fmt(c.at)}`).join("; ")}.`;
    }
    if (tool === "voice_settings") {
      let v = voiceVolume();
      if (Number.isFinite(input.volume_pct)) v = input.volume_pct / 100;
      else if (input.change === "louder") v += 0.2;
      else if (input.change === "quieter") v -= 0.2;
      v = Math.max(0.1, Math.min(1, v));
      try { localStorage.setItem(volumeKey, String(v)); } catch {}
      if (A.outGain) A.outGain.gain.value = v;
      return `Speaking volume ${Math.round(v * 100)}%.`;
    }
    if (tool === "check_for_updates") {
      const before = appVersionText;
      const health = await api("/api/health");
      if (health.version && before && health.version !== before) { setTimeout(() => location.reload(), 6000); return `Version ${health.version} is installed. Restarting into it in a few seconds (was ${before}).`; }
      return `Running the latest installed version, ${health.version || before || "unknown"}. New versions arrive when the mirror's software is updated, then load by themselves.`;
    }
    throw new Error(`Unknown tool ${tool}.`);
  }

  // ---------- Steps, schedules, rules and routines ----------
  // Scheduled actions, device rules and routines all hold a list of ordinary tool calls, run in turn.
  const stepTools = new Set(["show_screen", "show_room", "show_house", "show_camera", "run_scene", "control_device", "music", "add_task", "set_timer", "set_reminder", "set_weather_location", "show_widget", "set_display", "navigate", "home_screen", "routine", "voice_settings", "say"]);
  function checkSteps(steps) {
    const list = (Array.isArray(steps) ? steps : []).filter((st) => st && typeof st.tool === "string" && st.input && typeof st.input === "object").slice(0, 20);
    if (!list.length) throw new Error("There's nothing to do in that.");
    const bad = list.find((st) => !stepTools.has(st.tool) || (st.tool === "routine" && st.input.action !== "run"));
    if (bad) throw new Error(`${bad.tool} can't be part of a schedule or routine.`);
    return list.map((st) => ({ tool: st.tool, input: st.input }));
  }
  let stepDepth = 0;
  async function runSteps(steps) {
    if (stepDepth > 3) throw new Error("Those routines call each other too many times.");
    stepDepth++;
    const done = [];
    try {
      for (const st of steps) {
        try { const out = await runTool(st.tool, st.input); done.push(typeof out === "string" ? out : out.text); }
        catch (error) { done.push(`(${st.tool} failed: ${error.message})`); }
      }
    } finally { stepDepth--; }
    return done.join(" ");
  }
  // The next time a repeating reminder or action is due, keeping its clock time.
  function nextRepeat(at, repeat, includeSame) {
    const d = new Date(at);
    const ok = (x) => { const day = x.getDay(); return repeat === "weekdays" ? day > 0 && day < 6 : repeat === "weekends" ? day === 0 || day === 6 : true; };
    if (!includeSame) d.setDate(d.getDate() + (repeat === "weekly" ? 7 : 1));
    while (!ok(d) || d.getTime() <= Date.now()) d.setDate(d.getDate() + (repeat === "weekly" ? 7 : 1));
    return d.getTime();
  }
  const rulesKey = "reflect-os-assistant-rules", routinesKey = "reflect-os-assistant-routines";
  const loadList = (key) => { try { const list = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(list) ? list : []; } catch { return []; } };
  const saveList = (key, list) => { try { localStorage.setItem(key, JSON.stringify(list)); } catch {} };
  const loadRules = () => loadList(rulesKey), saveRules = (list) => saveList(rulesKey, list);
  const loadRoutines = () => loadList(routinesKey), saveRoutines = (list) => saveList(routinesKey, list);
  // Device rules: when a watched device changes to the wanted state, its actions run.
  const lastStates = new Map();
  window.ReflectBridge?.onChange?.((changed) => {
    const rules = loadRules();
    for (const e of changed || homeAssistantEntities) {
      const before = lastStates.get(e.id), now = String(e.state).toLowerCase();
      lastStates.set(e.id, now);
      if (!changed || before === undefined || before === now) continue;
      rules.filter((r) => r.entity_id === e.id && r.state === now).forEach((r) => {
        if (r.once) saveRules(loadRules().filter((x) => x.id !== r.id));
        runSteps(r.actions).catch(() => {});
        if (r.say) announce(r.say);
      });
    }
  });

  // ---------- Getting around ----------
  function scrollArea() {
    const view = document.querySelector(".view.is-active");
    if (!view) return document.scrollingElement;
    const all = [view, ...view.querySelectorAll("*")].filter((x) => x.scrollHeight > x.clientHeight + 40 && /(auto|scroll)/.test(getComputedStyle(x).overflowY));
    return all.sort((a, b) => b.clientHeight - a.clientHeight)[0] || document.scrollingElement;
  }
  function spotlight(id) {
    const target = document.getElementById(id);
    if (!target) throw new Error("That part isn't on the screen.");
    (target.closest(".cal-panel") || target).scrollIntoView({ behavior: "smooth", block: "center" });
    const panel = target.closest(".cal-panel") || target;
    panel.classList.remove("jv-spotlight"); void panel.offsetWidth; panel.classList.add("jv-spotlight");
    setTimeout(() => panel.classList.remove("jv-spotlight"), 2200);
  }
  function navigate(input) {
    const v = String(input.value || "").trim(), low = v.toLowerCase();
    switch (input.action) {
      case "calendar_view":
        if (!["day", "week", "upcoming"].includes(low)) throw new Error("The calendar has day, week and upcoming views.");
        showView("calendar", false);
        calendarView = low;
        document.querySelectorAll("[data-calendar-view]").forEach((b) => b.classList.toggle("is-selected", b.dataset.calendarView === low));
        renderCalendarPage();
        return `Showing the calendar's ${low} view.`;
      case "calendar_date":
        if (low && low !== "today" && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error("The date must be YYYY-MM-DD.");
        showView("calendar", false);
        calendarFocus = !low || low === "today" ? "" : v;
        renderCalendarPage();
        return calendarFocus ? `Showing ${new Date(`${v}T12:00`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}.` : "Back to today.";
      case "task_filter":
        if (!["today", "upcoming", "completed", "work", "home"].includes(low)) throw new Error("Tasks can show today, upcoming, completed, work or home.");
        showView("tasks", false);
        taskFilter = low;
        document.querySelectorAll("[data-task-filter]").forEach((b) => b.classList.toggle("is-selected", b.dataset.taskFilter === low));
        renderTaskPage();
        return `Showing ${low} tasks.`;
      case "music_section": {
        const id = { playlists: "spotifyPlaylists", recent: "spotifyRecent", search: "spotifyResults" }[low];
        if (!id) throw new Error("Music has playlists, recently played and search results.");
        showView("music", false);
        if (low === "recent") loadSpotifyRecent?.();
        setTimeout(() => spotlight(id), 350);
        return `Showing ${low === "recent" ? "recently played" : low}.`;
      }
      case "weather_section": {
        const id = { hourly: "weatherHourly", daily: "weatherDaily", details: "weatherOutlook" }[low];
        if (!id) throw new Error("Weather has hourly, daily and details.");
        showView("weather", false);
        setTimeout(() => spotlight(id), 350);
        return `Showing the ${low === "daily" ? "seven-day" : low} forecast.`;
      }
      case "settings_page": {
        const page = { account: "profile", layout: "home", widgets: "home", connections: "connections", services: "connections" }[low] || low;
        if (!document.querySelector(`.settings-page[data-page="${page}"]`)) throw new Error(`There's no ${v} settings page.`);
        showView("settings", false);
        openSettingsPage(page);
        return `Opened ${settingsTitles[page] || page} settings.`;
      }
      case "connect": {
        if (/smart|home|hue|assistant/.test(low)) { showView("devices", false); return "Opened Devices, where smart home things are added."; }
        if (!/spotify|google|calendar/.test(low)) throw new Error("I can open the connections for Spotify, Google Calendar or the smart home.");
        showView("settings", false);
        openSettingsPage("connections");
        return `Opened Connections. Tap Connect next to ${/spotify/.test(low) ? "Spotify" : "Google Calendar"}.`;
      }
      case "find_device": {
        showView("devices", false);
        const box = document.getElementById("dvSearch");
        if (box) { box.value = v; box.dispatchEvent(new Event("input")); }
        return v ? `Showing ${v} in Devices.` : "Opened Devices.";
      }
      case "open_controls": {
        const e = homeAssistantEntities.find((x) => x.id === v) || homeAssistantEntities.find((x) => x.name.toLowerCase() === low);
        if (!e) throw new Error(`No device called ${v}.`);
        if (e.domain === "light") openLightPanel(e.id);
        else if (e.domain === "climate") openHeatPanel(e.id);
        else if (e.domain === "media_player") openMediaPanel(e.id);
        else throw new Error(`${e.name} has no control panel; I can switch it for you instead.`);
        return `Opened the ${e.name} controls.`;
      }
      case "open_add":
        if (low !== "event" && low !== "task") throw new Error("I can open the add event or add task box.");
        showView(low === "event" ? "calendar" : "tasks", false);
        openItemDialog(low);
        return `Opened the add ${low} box.`;
      case "close": {
        let closed = 0;
        document.querySelectorAll("dialog[open]").forEach((d) => { d.close(); closed++; });
        if (document.querySelector(".db-pop.is-open")) { window.ReflectDoorbell?.hide(); closed++; }
        try { window.ReflectHome3D?.closeCamera?.(); } catch {}
        const camClose = document.querySelector('[aria-label="Close camera"]');
        if (camClose) { camClose.click(); closed++; }
        if (settingsPage) { closeSettingsPage(); closed++; }
        if (isEditing) { setEditing(false); closed++; }
        if (document.body.classList.contains("jv-asleep")) wakeScreen();
        return closed ? "Closed." : "Nothing was open.";
      }
      case "scroll": {
        const area = scrollArea(), up = low === "up";
        area.scrollBy({ top: (up ? -1 : 1) * Math.max(240, area.clientHeight * 0.6), behavior: "smooth" });
        return `Scrolled ${up ? "up" : "down"}.`;
      }
    }
    throw new Error(`Unknown navigate action ${input.action}.`);
  }
  function homeScreen(input) {
    if (input.action === "edit_layout") { showView("home", false); setEditing(true); return "Layout editing on. Drag widgets around, or tell me where to put them."; }
    if (input.action === "done_editing") { setEditing(false); return "Layout saved."; }
    if (input.action === "reset_layout") {
      const account = profile.account, addOns = profile.addOns, photos = profile.photos;
      profile.widgets = clone(defaultProfile.widgets);
      Object.assign(profile, { account, addOns, photos });
      saveProfile(); renderHome(); renderWidgetSettings();
      return "Home screen back to the normal layout.";
    }
    if (input.action === "next_quote") {
      const pool = affirmationPool();
      if (!pool.length) throw new Error("There are no affirmations or quotes set up.");
      if (!profile.widgets.affirmations?.visible) { profile.widgets.affirmations.visible = true; saveProfile(); }
      affirmationIndex = (affirmationIndex + 1) % pool.length;
      showView("home", false); renderHome();
      const item = pool[affirmationIndex];
      return `Showing: ${typeof item === "string" ? item : `${item.t} (${item.a})`}`;
    }
    if (input.action === "next_photo" || input.action === "slideshow") {
      if (!photoRecords.length) throw new Error("There are no photos on the mirror yet. Add some in Settings, Photos.");
      profile.widgets.photos.visible = true; saveProfile();
      if (input.action === "next_photo") currentPhoto = (currentPhoto + 1) % photoRecords.length;
      showView("home", false); renderHome(); renderWidgetSettings();
      return input.action === "slideshow" ? `Photo slideshow on, ${photoRecords.length} photos.` : "Next photo.";
    }
    if (input.action === "arrange") {
      const w = profile.widgets?.[input.widget], addOn = baseWidgets[input.widget]?.addOn;
      if (!w || (addOn && !addOnInstalled(addOn))) throw new Error(`The ${input.widget} widget needs its add-on installed first, in Settings.`);
      if (!input.zone && !input.size) throw new Error("Where should it go, or what size?");
      if (input.zone) w.zone = input.zone;
      if (input.size) w.size = input.size;
      w.visible = true;
      saveProfile(); showView("home", false); renderHome(); renderWidgetSettings();
      return `${baseWidgets[input.widget].label} now ${w.size} in the ${w.zone.replace("-", " ")}.`;
    }
    throw new Error(`Unknown home screen action ${input.action}.`);
  }
  // Colour names (and #hex) for the accent colour, read the way the browser reads CSS colours.
  function colourHex(name) {
    const probe = document.createElement("i");
    probe.style.color = "";
    probe.style.color = String(name).trim().replace(/\s+/g, "");
    if (!probe.style.color) return "";
    document.body.appendChild(probe);
    const rgb = getComputedStyle(probe).color.match(/\d+/g);
    probe.remove();
    return rgb ? `#${rgb.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}` : "";
  }
  // Screen sleep: the glass goes black (a plain mirror) until he hears his name or someone touches it.
  const sleeper = document.createElement("div");
  sleeper.className = "jv-sleep";
  document.body.appendChild(sleeper);
  function sleepScreen() { if (A.busy || A.state === "speaking") return setTimeout(sleepScreen, 1500); closeStage(); document.body.classList.add("jv-asleep"); }
  function wakeScreen() { document.body.classList.remove("jv-asleep"); }
  sleeper.addEventListener("pointerdown", wakeScreen);
  // How loud he speaks, kept on this mirror.
  const volumeKey = "reflect-os-assistant-volume";
  function voiceVolume() { try { const v = Number(localStorage.getItem(volumeKey)); return v > 0 && v <= 1 ? v : 1; } catch { return 1; } }
  function speechOut(ac) {
    if (!A.outGain || A.outGain.context !== ac) { A.outGain = ac.createGain(); A.outGain.connect(ac.destination); }
    A.outGain.gain.value = voiceVolume();
    return A.outGain;
  }

  // ---------- Music ducking ----------
  // Like a smart speaker: music drops right down while Jarvis listens and talks, so there's no
  // need to shout over it, then comes back to where it was.
  function duckMusic() {
    if (A.ducked || !connected("spotify") || !sampleData.track?.playing) return;
    // Holds how to put the volume back, once the duck has gone through.
    A.ducked = (async () => {
      if (typeof spotifyPlayer !== "undefined" && spotifyPlayer && spotifyDeviceId && spotifyActiveDeviceId === spotifyDeviceId) {
        const before = await spotifyPlayer.getVolume();
        await spotifyPlayer.setVolume(Math.min(before, 0.12));
        return () => spotifyPlayer.setVolume(before);
      }
      const { devices = [] } = await api("/api/spotify/devices");
      const device = devices.find((d) => d.active);
      if (!device || device.volume == null || device.volume <= 15) return null;
      await api("/api/spotify/player/volume", { method: "POST", body: JSON.stringify({ volume: 15, deviceId: device.id }) });
      return () => api("/api/spotify/player/volume", { method: "POST", body: JSON.stringify({ volume: device.volume, deviceId: device.id }) });
    })().catch(() => null);
  }
  function unduckMusic() {
    const ducked = A.ducked;
    if (!ducked) return;
    A.ducked = null;
    ducked.then((restore) => restore?.()).catch(() => {});
  }

  // ---------- Spotify ----------
  // Jarvis sends music to wherever Spotify is already playing; otherwise to this mirror's own player
  // if it's ready; otherwise to any device with Spotify open (the app on a Mac or phone, a speaker).
  // Every failure is reported back, so he never claims to be playing something he isn't.
  async function spotifyTarget(named) {
    const { devices = [] } = await api("/api/spotify/devices");
    if (named) {
      const want = String(named).toLowerCase(), mirrorWanted = /mirror|here|this/.test(want);
      const found = devices.find((d) => d.name.toLowerCase() === want) || devices.find((d) => d.name.toLowerCase().includes(want) || want.includes(d.name.toLowerCase())) || (mirrorWanted && spotifyDeviceId && { id: spotifyDeviceId, name: "this mirror" });
      if (!found) throw new Error(`Spotify can't see ${named}. It can play on: ${devices.map((d) => d.name).join(", ") || "nothing right now"}.`);
      return found;
    }
    const mirror = typeof spotifyDeviceId === "string" && spotifyDeviceId ? spotifyDeviceId : "";
    const pick = devices.find((d) => d.active) || (mirror && devices.find((d) => d.id === mirror)) || devices.find((d) => d.type === "Computer") || devices[0];
    if (pick) return pick;
    if (mirror) return { id: mirror, name: "this mirror" };
    throw new Error("Spotify isn't open anywhere. Open the Spotify app on your Mac or phone, then ask again.");
  }
  async function spotifySend(action, payload) {
    try { return await api(`/api/spotify/player/${action}`, { method: "POST", body: JSON.stringify(payload) }); }
    catch (error) {
      if (/premium/i.test(error.message)) throw new Error("Spotify only lets me control music on a Premium account.");
      if (/no active device|device not found/i.test(error.message)) throw new Error("Spotify isn't open anywhere. Open the Spotify app on your Mac or phone, then ask again.");
      throw error;
    }
  }
  async function spotifyCommand(input) {
    const action = input.action;
    if (action === "pause" && !sampleData.track?.playing) { try { await spotifySend("pause", {}); } catch {} return "Music paused."; }
    if (action === "list_devices") {
      const { devices = [] } = await api("/api/spotify/devices");
      return devices.length ? `Spotify can play on: ${devices.map((d) => `${d.name}${d.active ? " (playing now)" : ""}`).join(", ")}.` : "Spotify isn't open on any speaker or app right now.";
    }
    if (action === "like") {
      const playback = await api("/api/spotify/player").catch(() => ({}));
      const id = playback.item?.id || String(sampleData.track?.uri || "").split(":").pop();
      if (!id) throw new Error("Nothing is playing to like.");
      await api("/api/spotify/like", { method: "POST", body: JSON.stringify({ id }) });
      return `Saved ${playback.item?.name || sampleData.track?.title || "it"} to your Liked Songs.`;
    }
    const device = await spotifyTarget(input.device);
    if (action === "move_to") {
      if (!input.device) throw new Error("Which speaker?");
      await api("/api/spotify/player/transfer", { method: "POST", body: JSON.stringify({ deviceId: device.id }) });
      return `Music moved to ${device.name}.`;
    }
    if (action === "volume" || action === "volume_up" || action === "volume_down") {
      const { devices = [] } = await api("/api/spotify/devices");
      const now = devices.find((d) => d.id === device.id)?.volume ?? 50;
      const level = action === "volume" ? input.volume_pct : now + (action === "volume_up" ? 15 : -15);
      if (!Number.isFinite(level)) throw new Error("What volume?");
      const v = Math.max(0, Math.min(100, Math.round(level)));
      // While he's talking the music is turned down; the new level is what it comes back up to.
      A.ducked = null;
      await spotifySend("volume", { volume: v, deviceId: device.id });
      return `Music volume ${v}% on ${device.name}.`;
    }
    if (action === "shuffle_on" || action === "shuffle_off") { await spotifySend("shuffle", { state: action === "shuffle_on", deviceId: device.id }); return `Shuffle ${action === "shuffle_on" ? "on" : "off"}.`; }
    if (action === "repeat_on" || action === "repeat_off") { await spotifySend("repeat", { state: action === "repeat_on" ? "context" : "off", deviceId: device.id }); return `Repeat ${action === "repeat_on" ? "on" : "off"}.`; }
    if (action === "play_playlist") {
      const query = String(input.query || "").trim().toLowerCase();
      if (!query) throw new Error("Which playlist?");
      const { playlists = [] } = await api("/api/spotify/playlists");
      const words = query.replace(/\bplaylist\b/g, "").trim();
      const pick = playlists.find((p) => p.name.toLowerCase() === words) || playlists.find((p) => p.name.toLowerCase().includes(words)) || playlists.find((p) => words.split(/\s+/).every((w) => p.name.toLowerCase().includes(w)));
      if (!pick) throw new Error(`You don't have a playlist called ${input.query}. You have ${playlists.slice(0, 8).map((p) => p.name).join(", ") || "no playlists"}.`);
      await spotifySend("play", { contextUri: pick.uri, deviceId: device.id });
      return `Playing your ${pick.name} playlist on ${device.name}.`;
    }
    if (action === "play_search") {
      const query = String(input.query || "").trim();
      if (!query) throw new Error("Nothing to search for.");
      const { tracks = [] } = await api(`/api/spotify/search?q=${encodeURIComponent(query)}`);
      if (!tracks.length) throw new Error(`Spotify found nothing for ${query}.`);
      await spotifySend("play", { uri: tracks[0].uri, deviceId: device.id });
      sampleData.track = { ...sampleData.track, uri: tracks[0].uri, title: tracks[0].name, artist: tracks[0].artists, artwork: tracks[0].artwork, playing: true };
      return `Playing ${tracks[0].name} by ${tracks[0].artists} on ${device.name}.`;
    }
    if (action === "play") {
      // Nothing loaded yet: start the saved playlist rather than failing silently.
      const context = !sampleData.track?.uri && typeof profile !== "undefined" ? profile.spotify?.playlistUri : "";
      await spotifySend("play", { deviceId: device.id, ...(context ? { contextUri: context } : {}) });
      return `Music playing on ${device.name}.`;
    }
    await spotifySend(action, { deviceId: device.id });
    return action === "pause" ? "Music paused." : action === "next" ? "Skipped to the next track." : "Back to the previous track.";
  }

  // ---------- Conversation with Claude (via the local server) ----------
  async function ask(text) {
    text = String(text || "").trim();
    clearTimeout(A.endTimer); A.heardFinal = "";
    if (!text) return;
    // "Be quiet", "never mind": he stops at once, no need to ask Claude. A plain "stop" only means him
    // when it cuts him off; otherwise it goes to Claude, as it may mean the music or the TV.
    const hush = /^(stop talking|be quiet|quiet|shush|shut up|cancel|never ?mind|that's all|that's it|nothing|go away)[.!]*$/i.test(text);
    const cutOff = /^(stop|stop it|enough)[.!]*$/i.test(text) && (A.busy || A.state === "speaking" || Date.now() - (A.interruptedAt || 0) < 5000);
    if (hush || cutOff) { A.queued = ""; interrupt(); closeStage(); return; }
    // Asked something new while still working on the last one: that answer is dropped and this
    // question goes next.
    if (A.busy) { A.queued = text; interrupt(); showHeard(text); setState("thinking"); return; }
    clearTimeout(A.commandTimer);
    A.awaitingCommand = false;
    openStage();
    showHeard(text);
    showReply("");
    clearLog();
    if (!A.status?.configured) return speak(`I'm not connected to my brain yet. Add an Anthropic API key to the Reflect config file and restart me.`);
    A.busy = true;
    setState("thinking");
    A.timing = { asked: performance.now() };
    // If the answer isn't on its way within a moment, he says "Right, sir" so you know he heard.
    clearTimeout(A.ackTimer);
    A.ackTimer = setTimeout(() => { if (live() && !talk) playAck(); }, 650);
    // A fresh conversation after a few quiet minutes keeps replies fast and history append-only.
    if (Date.now() - A.lastTurn > 180000 || A.conversation.length > 40) A.conversation = [];
    if (!A.conversation.length) A.convStart = Date.now();
    let reply = "", talk = null;
    const turn = ++A.turn, live = () => A.turn === turn;
    // Jarvis starts speaking as soon as his first sentence has arrived, and keeps going sentence by
    // sentence while the rest of the reply is still being written.
    const feed = sentenceFeeder((sentence) => {
      if (!live()) return;
      if (!talk) { clearTimeout(A.ackTimer); talk = startTalking(); showReply(""); if (A.timing && !A.timing.text) A.timing.text = performance.now(); }
      sentence = fewerSirs(sentence);
      showReplyPart(sentence);
      talk.say(sentence);
    });
    try {
      A.conversation.push({ role: "user", content: [{ type: "text", text: `[Mirror context]\n${await mirrorContext()}\n\nThey said: ${text}` }] });
      markBriefed(); // only the first question of the day counts as the first, even if it goes wrong
      let paused = false;
      for (let step = 0; step < 8; step++) {
        const result = await chatStream(A.conversation, (delta) => feed.push(delta));
        feed.flush();
        const content = Array.isArray(result.content) ? result.content : [];
        if (result.stop_reason === "refusal") { reply = "I'm afraid that's one I can't help with."; A.conversation = []; if (talk && live()) { showReplyPart(reply); talk.say(reply); } break; }
        content.filter((b) => b.type === "server_tool_use" && b.name === "web_search").forEach((b) => logAction(`Searched the web: ${b.input?.query || ""}`));
        // A long web search can pause mid-turn. Sending the paused turn back resumes it, and the
        // continuation belongs to that same assistant turn.
        if (paused) A.conversation.at(-1).content.push(...content);
        else A.conversation.push({ role: "assistant", content });
        paused = result.stop_reason === "pause_turn";
        if (paused) continue;
        const turn = A.conversation.at(-1).content;
        const said = turn.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
        const uses = turn.filter((b) => b.type === "tool_use");
        if (result.stop_reason !== "tool_use" || !uses.length) { reply = said; break; }
        const results = await Promise.all(uses.map(async (use) => {
          try {
            const out = await runTool(use.name, use.input || {});
            const done = typeof out === "string" ? out : String(out.text);
            logAction(done);
            const target = () => { try { pointAt(targetFor(use.name, use.input || {})); } catch {} };
            setTimeout(target, 420);
            return { type: "tool_result", tool_use_id: use.id, content: typeof out === "string" ? out : out.content };
          }
          catch (error) { logAction(error.message, true); emit({ error: error.message }); return { type: "tool_result", tool_use_id: use.id, content: error.message, is_error: true }; }
        }));
        A.conversation.push({ role: "user", content: results });
      }
      const last = A.conversation.at(-1);
      if (last && (last.role === "user" || last.content.some((b) => b.type === "tool_use"))) A.conversation = [];
      A.lastTurn = Date.now();
      rememberExchange(text, reply);
    } catch (error) {
      A.conversation = [];
      reply = error.message;
      if (talk && live()) { showReplyPart(reply); talk.say(reply); }
    } finally {
      A.busy = false;
      clearTimeout(A.ackTimer);
    }
    if (A.queued) { const next = A.queued; A.queued = ""; return ask(next); }
    if (!live()) return;
    if (talk) return finishTalking(talk);
    await speak(reply || "Done.");
  }

  // Reads Claude's reply as it streams in, rebuilding the same content blocks a normal reply has
  // (so the conversation history is unchanged) and handing each new piece of text to onText.
  async function chatStream(messages, onText) {
    const response = await fetch("/api/assistant/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages, stream: true }) });
    if (!response.ok || !response.body || !String(response.headers.get("content-type")).includes("event-stream")) {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The assistant is unavailable right now.");
      return data;
    }
    const blocks = [], json = [];
    let stop_reason = null, buffer = "";
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    const handle = (event) => {
      if (event.type === "content_block_start") {
        const block = { ...event.content_block };
        if (block.type === "text") { block.text = ""; if (!block.citations) delete block.citations; }
        if (block.type === "tool_use" || block.type === "server_tool_use") json[event.index] = "";
        blocks[event.index] = block;
      } else if (event.type === "content_block_delta") {
        const block = blocks[event.index], d = event.delta;
        if (!block) return;
        if (d.type === "text_delta") { block.text += d.text; onText(d.text); }
        else if (d.type === "input_json_delta") json[event.index] += d.partial_json;
        else if (d.type === "citations_delta") (block.citations ||= []).push(d.citation);
        else if (d.type === "thinking_delta") block.thinking = (block.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") block.signature = d.signature;
      } else if (event.type === "content_block_stop") {
        const block = blocks[event.index];
        if (block && json[event.index] !== undefined) { try { block.input = json[event.index] ? JSON.parse(json[event.index]) : {}; } catch { block.input = {}; } }
      } else if (event.type === "message_delta") stop_reason = event.delta?.stop_reason || stop_reason;
      else if (event.type === "error") throw new Error(event.error?.message || "The assistant is unavailable right now.");
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) if (line.startsWith("data:")) { let event; try { event = JSON.parse(line.slice(5)); } catch { continue; } handle(event); }
    }
    if (!stop_reason) throw new Error("The assistant could not reach Claude. Check the internet connection.");
    // If Claude handed over to a fallback model part-way, only the text from before the hand-over
    // belongs in the history; the marker itself is dropped.
    const list = blocks.filter(Boolean), cut = list.map((b) => b.type).lastIndexOf("fallback");
    const content = list.filter((b, i) => b.type !== "fallback" && (i > cut || b.type === "text"));
    return { content, stop_reason };
  }
  // Splits streaming text into speakable pieces: whole sentences, with very short ones joined to the
  // next so the voice doesn't sound clipped. The first piece is allowed to be short so it starts fast:
  // if the opening sentence is a long one, he starts on its first phrase (up to a comma) while the
  // rest is still being made.
  function sentenceFeeder(say) {
    let buffer = "", first = true;
    // A full stop after an abbreviation ("e.g.", "Mr.", an initial) isn't the end of a sentence.
    const end = /(?<!\b(?:[A-Za-z]|e\.g|i\.e|Mr|Mrs|Ms|Dr|St|vs))[.!?]+["')\]]*\s+/g;
    return {
      push(text) {
        buffer += text;
        let cut = 0, m;
        end.lastIndex = 0;
        while ((m = end.exec(buffer))) {
          const stop = m.index + m[0].length;
          // Whole sentences keep the voice's natural rhythm; very short ones ride along with the next.
          if (stop - cut >= (first ? 12 : 40)) { const piece = buffer.slice(cut, stop).trim(); if (piece) { say(piece); first = false; } cut = stop; }
        }
        buffer = buffer.slice(cut);
        if (first && buffer.length > 90) {
          // Only a long opening sentence is split, at a comma well into it, so he starts sooner.
          const pause = /(?:[,;:\u2013\u2014]|\s-)\s+/g;
          while ((m = pause.exec(buffer))) {
            const stop = m.index + m[0].length;
            if (stop >= 40) { say(buffer.slice(0, stop).trim()); first = false; buffer = buffer.slice(stop); break; }
          }
        }
      },
      flush() { const piece = buffer.trim(); buffer = ""; if (piece) { say(piece); first = false; } }
    };
  }

  // ---------- Speaking ----------
  function audioContext() {
    if (!A.audioCtx) { try { A.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (A.audioCtx.state === "suspended") A.audioCtx.resume().catch(() => {});
    return A.audioCtx;
  }
  // The browser's own voices. Downloaded Premium and Enhanced voices sound far more natural than
  // the built-in compact ones, so they win; then British male voices; then any British voice.
  // A voice chosen by saying "change your voice" is remembered.
  const voiceKey = "reflect-os-assistant-voice";
  const maleVoices = ["Jamie", "Oliver", "Daniel", "Arthur", "Google UK English Male", "Malcolm", "George", "Ryan", "Thomas"];
  function voiceScore(v) {
    if (!/^en[-_]GB/i.test(v.lang)) return /^en/i.test(v.lang) ? 1 : 0;
    const male = maleVoices.findIndex((n) => v.name.includes(n));
    return 10 + (/premium/i.test(v.name) ? 40 : /enhanced|neural|natural/i.test(v.name) ? 25 : 0) + (male >= 0 ? 20 - male : 0);
  }
  function britishVoices() {
    if (!("speechSynthesis" in window)) return [];
    return speechSynthesis.getVoices().filter((v) => voiceScore(v) >= 10).sort((a, b) => voiceScore(b) - voiceScore(a));
  }
  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = speechSynthesis.getVoices();
    let saved = "";
    try { saved = localStorage.getItem(voiceKey) || ""; } catch {}
    return voices.find((v) => v.name === saved) || [...voices].sort((a, b) => voiceScore(b) - voiceScore(a)).find((v) => voiceScore(v) > 0) || null;
  }
  if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { A.voice = pickVoice(); });

  // Chrome fills in its voice list a moment after the page loads. Speaking before then uses the
  // system default voice, so a reply right after start-up would sound different from the rest.
  function voicesLoaded() {
    if (!("speechSynthesis" in window) || speechSynthesis.getVoices().length) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, 2000);
      speechSynthesis.addEventListener?.("voiceschanged", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
  async function speakBrowser(text) {
    await voicesLoaded();
    return new Promise((resolve) => {
      if (!("speechSynthesis" in window)) return resolve();
      speechSynthesis.cancel();
      A.voice = A.voice || pickVoice();
      // Short sentence-sized utterances avoid Chrome cutting long speech off part-way through.
      const parts = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
      let finished = false;
      const done = () => { if (!finished) { finished = true; clearTimeout(guard); resolve(); } };
      const guard = setTimeout(done, text.length * 95 + 4000);
      parts.forEach((part, i) => {
        const u = new SpeechSynthesisUtterance(part.trim());
        if (A.voice) { u.voice = A.voice; u.lang = A.voice.lang; } else u.lang = "en-GB";
        // Lowering the pitch is what made these voices sound robotic; a natural pitch, slightly brisk, sounds human.
        u.rate = 1.08; u.pitch = 1; u.volume = voiceVolume();
        u.onboundary = () => { A.speakPulse = 1; };
        u.onstart = () => { A.speakPulse = 1; firstSound(); };
        if (i === parts.length - 1) { u.onend = done; u.onerror = done; }
        speechSynthesis.speak(u);
      });
    });
  }
  // Written text has bits a voice reads out badly or robotically (symbols, markdown, abbreviations),
  // so they're turned into the words a person would say before speaking.
  function speakable(text) {
    return String(text || "")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_#`~>|]+/g, "")
      .replace(/(\d)\s*°\s*C\b/g, "$1 degrees").replace(/(\d)\s*°\s*F\b/g, "$1 degrees Fahrenheit").replace(/°/g, " degrees")
      .replace(/(\d)\s*%/g, "$1 percent")
      .replace(/\s+&\s+/g, " and ")
      .replace(/\be\.g\.\s*/gi, "for example ").replace(/\bi\.e\.\s*/gi, "that is ").replace(/\betc\./gi, "and so on")
      .replace(/\s+[-\u2013\u2014]\s+/g, ", ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }
  async function fetchSpeech(text) {
    const response = await fetch("/api/assistant/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error("Server voice unavailable");
    return URL.createObjectURL(await response.blob());
  }
  // Plays a clip through Web Audio with the silence the voice pads at each end trimmed off, so
  // sentences follow each other at a natural pace instead of with a robotic pause between them.
  async function playSpeech(url) {
    const ac = audioContext();
    if (!ac || ac.state !== "running") return playSpeechElement(url);
    let clip;
    try { clip = await ac.decodeAudioData(await (await fetch(url)).arrayBuffer()); }
    catch { return playSpeechElement(url); }
    URL.revokeObjectURL(url);
    const data = clip.getChannelData(0), quiet = 0.004, lead = Math.round(clip.sampleRate * 0.04), tail = Math.round(clip.sampleRate * 0.12);
    let start = 0, end = data.length - 1;
    while (start < end && Math.abs(data[start]) < quiet) start++;
    while (end > start && Math.abs(data[end]) < quiet) end--;
    start = Math.max(0, start - lead); end = Math.min(data.length, end + tail);
    const source = ac.createBufferSource();
    source.buffer = clip;
    A.outAnalyser = ac.createAnalyser(); A.outAnalyser.fftSize = 512;
    A.outBuffer = new Uint8Array(A.outAnalyser.fftSize);
    source.connect(A.outAnalyser); A.outAnalyser.connect(speechOut(ac));
    A.currentSource = source;
    return new Promise((resolve) => {
      source.onended = resolve;
      source.start(0, start / clip.sampleRate, Math.max(0.05, (end - start) / clip.sampleRate));
      firstSound();
    }).finally(() => { if (A.currentSource === source) A.currentSource = null; A.outAnalyser = null; });
  }
  function playSpeechElement(url) {
    const audio = new Audio(url);
    A.currentAudio = audio;
    const ac = audioContext();
    if (ac) {
      try {
        const source = ac.createMediaElementSource(audio);
        A.outAnalyser = ac.createAnalyser(); A.outAnalyser.fftSize = 512;
        A.outBuffer = new Uint8Array(A.outAnalyser.fftSize);
        source.connect(A.outAnalyser); A.outAnalyser.connect(speechOut(ac));
      } catch { A.outAnalyser = null; audio.volume = voiceVolume(); }
    }
    return new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onpause = resolve;
      audio.onerror = () => reject(new Error("Playback failed"));
      audio.play().then(firstSound, reject);
    }).finally(() => { URL.revokeObjectURL(url); A.currentAudio = null; A.outAnalyser = null; });
  }
  // Which voice to use for this reply. With the built-in voice set, Jarvis waits for it to finish
  // loading rather than filling in with a different voice, so he always sounds the same. Only if it
  // can't load at all (or is still downloading after a minute) does the browser voice speak instead.
  async function voiceMaker() {
    if (A.status?.builtInVoice) {
      if (!K.ready && !K.failed) await Promise.race([warmKokoro(), new Promise((r) => setTimeout(r, 60000))]).catch(() => {});
      return K.ready ? makeKokoro : null;
    }
    return A.status?.serverVoice ? fetchSpeech : null;
  }
  // A queue of sentences to say. Each sentence is generated while the one before it plays. A sentence
  // that fails gets one more try; if the voice keeps failing, the browser voice says the rest.
  function speechQueue() {
    const run = (A.speakRun = (A.speakRun || 0) + 1);
    const maker = voiceMaker();
    let generating = Promise.resolve(), playing = A.ackPlaying || Promise.resolve(), broken = false;
    A.ackPlaying = null;
    return {
      say(chunk) {
        heardMyself(chunk);
        const made = generating.then(async () => {
          const make = await maker;
          if (!make || broken || A.speakRun !== run) return null;
          chunk = speakable(chunk);
          if (A.timing && !A.timing.voiceStart) { A.timing.voiceStart = performance.now(); A.timing.chars = chunk.length; }
          try { return await make(chunk); } catch {}
          try { return await make(chunk); } catch { broken = true; return null; }
        });
        generating = made.catch(() => {});
        playing = playing.then(async () => {
          const url = await made.catch(() => null);
          if (A.speakRun !== run) { if (url) URL.revokeObjectURL(url); return; }
          if (url) await playSpeech(url).catch(() => {});
          else { await voicesLoaded(); if (A.speakRun === run) await speakBrowser(speakable(chunk)); }
          // A breath between pieces, as a speaker would: longer after a full stop than after a comma.
          if (A.speakRun === run) await new Promise((r) => setTimeout(r, /[.!?]["')\]]*$/.test(chunk.trim()) ? 260 : 90));
        });
      },
      done: () => playing
    };
  }
  // ---------- Built-in voice (Kokoro, in a worker) ----------
  // Set "builtInVoice" in reflect-os.config.json (for example "bm_george") to use it.
  const kokoroVoices = ["bm_george", "bm_fable", "bm_lewis", "bm_daniel", "bf_emma", "bf_isabella", "bf_alice", "bf_lily"];
  const kokoroKey = "reflect-os-assistant-kokoro-voice";
  const K = { worker: null, ready: false, failed: false, loading: null, nextId: 0, waiting: new Map() };
  function kokoroVoice() {
    let saved = "";
    try { saved = localStorage.getItem(kokoroKey) || ""; } catch {}
    return kokoroVoices.includes(saved) ? saved : kokoroVoices.includes(A.status?.builtInVoice) ? A.status.builtInVoice : "bm_george";
  }
  function kokoroCall(message) {
    if (!K.worker) {
      K.worker = new Worker("voice-worker.js", { type: "module" });
      K.worker.onmessage = ({ data }) => { const done = K.waiting.get(data.id); if (!done) return; K.waiting.delete(data.id); data.ok ? done.resolve(data) : done.reject(new Error(data.error)); };
      K.worker.onerror = (event) => { K.failed = true; K.waiting.forEach((w) => w.reject(new Error(event.message || "Voice worker failed"))); K.waiting.clear(); };
    }
    const id = ++K.nextId;
    return new Promise((resolve, reject) => { K.waiting.set(id, { resolve, reject }); K.worker.postMessage({ id, ...message }); });
  }
  // Loads the model as soon as the mirror starts, so the first reply doesn't wait for it.
  function warmKokoro() {
    if (!A.status?.builtInVoice || K.ready || K.failed) return K.loading;
    if (K.loading) return K.loading;
    const started = performance.now();
    return (K.loading = kokoroCall({ type: "load" }))
      .then((data) => { K.ready = true; K.engine = data.engine || "built-in voice"; console.info(`Built-in voice ready in ${((performance.now() - started) / 1000).toFixed(1)}s`); prepareAcks(); })
      .catch((error) => { K.failed = true; console.warn("Built-in voice unavailable:", error.message); });
  }
  async function makeKokoro(text) {
    // Kokoro's normal pace sounds slow and drawn out for Jarvis; a little quicker sounds natural.
    const { blob } = await kokoroCall({ type: "speak", text, voice: kokoroVoice(), speed: 1.06 });
    return URL.createObjectURL(blob);
  }

  // ---------- Instant acknowledgement ----------
  // A few short replies ("Right, sir.") are spoken once in advance and kept ready, so the moment you
  // finish talking he can react with no wait at all while Claude works on the real answer.
  async function prepareAcks() {
    const ac = audioContext();
    if (!ac || A.acks) return;
    const sir = String(A.status?.address || "").trim();
    const lines = ["Right.", "Certainly.", "One moment.", sir ? `Of course, ${sir}.` : "Of course.", "On it."];
    A.acks = [];
    for (const line of lines) {
      try {
        const url = await makeKokoro(line);
        A.acks.push(await ac.decodeAudioData(await (await fetch(url)).arrayBuffer()));
        URL.revokeObjectURL(url);
      } catch {}
    }
  }
  function playAck() {
    const ac = audioContext();
    if (!ac || ac.state !== "running" || !A.acks?.length || A.ackPlaying) return;
    // A different line from last time, so he doesn't sound like a recording.
    let pick = Math.floor(Math.random() * A.acks.length);
    if (A.acks.length > 1 && pick === A.lastAck) pick = (pick + 1 + Math.floor(Math.random() * (A.acks.length - 1))) % A.acks.length;
    A.lastAck = pick;
    const clip = A.acks[pick];
    const source = ac.createBufferSource();
    source.buffer = clip; source.connect(speechOut(ac));
    A.ackSource = source;
    A.ackPlaying = new Promise((resolve) => { source.onended = resolve; source.start(); })
      .finally(() => { if (A.ackSource === source) A.ackSource = null; });
  }
  // Opens the line to Claude as soon as you start talking to him (see /api/assistant/warm).
  function warmBrain() {
    if (Date.now() - (A.lastWarm || 0) < 3000) return;
    A.lastWarm = Date.now();
    fetch("/api/assistant/warm", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).catch(() => {});
  }

  // The first time a reply makes a sound, report how long it took (in the server window), so a slow
  // start can be pinned on Claude or on the voice.
  function firstSound() {
    const t = A.timing;
    if (!t || t.sound) return;
    t.sound = performance.now();
    const engine = A.status?.builtInVoice && K.ready ? K.engine : A.status?.serverVoice ? A.status.voiceProvider : `browser voice ${A.voice?.name || ""}`.trim();
    const report = { firstSound: t.sound - t.asked, firstText: t.text ? t.text - t.asked : null, voice: t.voiceStart ? t.sound - t.voiceStart : null, chars: t.chars || 0, engine };
    console.info("Jarvis timing", report);
    fetch("/api/assistant/timing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(report) }).catch(() => {});
  }
  // Cuts Jarvis off mid-answer: anything still to come from that answer stays silent.
  function interrupt() { if (A.busy || A.state === "speaking") A.interruptedAt = Date.now(); A.turn++; A.timing = null; stopSpeaking(); }
  function stopSpeaking() {
    A.speakRun = (A.speakRun || 0) + 1;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (A.currentAudio) { A.currentAudio.pause(); A.currentAudio = null; }
    if (A.currentSource) { try { A.currentSource.stop(); } catch {} A.currentSource = null; }
    if (A.ackSource) { try { A.ackSource.stop(); } catch {} A.ackSource = null; }
    clearTimeout(A.ackTimer); A.ackPlaying = null;
  }
  // Speaking happens in three steps so a streamed reply can start talking before it has finished.
  function startTalking() {
    openStage();
    setState("speaking");
    // The microphone stays on while he talks, so saying his name cuts in (see handleTranscript).
    A.srPaused = false;
    startRecognition();
    return speechQueue();
  }
  async function finishTalking(talk) {
    try { await talk.done(); } catch {}
    if (A.state !== "speaking") return; // interrupted by a tap or closed
    // The recogniser lags a second or so behind, so the end of his own voice is still in it. Start it
    // afresh and ignore the first moment, so he doesn't hear himself and answer it.
    A.lastSpoke = Date.now();
    A.deafUntil = Date.now() + 700;
    try { A.recognition?.abort(); } catch {}
    // Like a real conversation: stay listening briefly for a follow-up without the wake word.
    if (canListen()) listenForCommand(7000, false);
    else { setState("idle"); closeSoon(); }
  }
  async function speak(text) {
    showReply(text);
    const talk = startTalking();
    const feed = sentenceFeeder((chunk) => talk.say(chunk));
    feed.push(`${text} `); feed.flush();
    return finishTalking(talk);
  }

  // ---------- Listening ----------
  const wakePattern = () => {
    const n = name().toLowerCase().replace(/[^a-z ]/g, "");
    const variants = n === "jarvis" ? "jarvis|javis|jervis|jarvas|jarvi" : n.replace(/ /g, "\\s+");
    return new RegExp(`\\b(?:hey\\s+|ok\\s+|okay\\s+)?(?:${variants})\\b[\\s,.!?]*`, "i");
  };
  function canListen() { return Boolean((SR && !A.srUnavailable && !A.srBlocked) || A.status?.serverTranscription); }

  function startRecognition() {
    if (!SR || A.srUnavailable || A.srBlocked || A.recognition || A.srPaused) return;
    if (!A.status?.wakeWord && !A.awaitingCommand && A.state !== "speaking" && A.state !== "thinking") return;
    const r = new SR();
    r.lang = "en-GB"; r.continuous = true; r.interimResults = true;
    r.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) handleTranscript(event.results[i][0].transcript, event.results[i].isFinal);
    };
    r.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") { A.srBlocked = true; mini.title = "Allow microphone access in the browser to talk to the assistant."; }
      else if (event.error === "network" || event.error === "language-not-supported") { A.srUnavailable = true; } // e.g. Chromium builds without Google speech
    };
    r.onend = () => { if (A.recognition === r) A.recognition = null; setTimeout(startRecognition, 250); };
    try { r.start(); A.recognition = r; } catch { A.recognition = null; }
  }

  function handleTranscript(transcript, isFinal) {
    if (Date.now() < (A.deafUntil || 0)) return;
    const wake = wakePattern().test(transcript);
    if (!wake && isEcho(transcript)) return;
    if (A.busy || A.state === "speaking") {
      // While he's talking or thinking, only his name gets through: it cuts him off and he listens.
      // Anything else is ignored, so he doesn't react to his own voice.
      if (!wakePattern().test(transcript)) return;
      interrupt();
      A.awaitingCommand = false;
    }
    if (A.awaitingCommand) return heard(transcript.replace(wakePattern(), "").trim(), isFinal);
    const match = transcript.match(wakePattern());
    if (!match) return;
    const after = transcript.slice(match.index + match[0].length).trim();
    wakeScreen();
    listenForCommand(10000, !after);
    heard(after, isFinal);
  }
  // ---------- Not hearing himself ----------
  // The speakers are right next to the microphone, so what he says comes back in. Everything he says is
  // remembered for a few seconds, and anything heard that is mostly his own words is ignored.
  const wordsOf = (text) => String(text).toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
  function heardMyself(text) {
    A.said = [...(A.said || []).filter((s) => Date.now() - s.at < 60000), { at: Date.now(), words: wordsOf(text) }];
  }
  // Echo = heard while he's talking (or just after), and mostly his own words in his own order.
  function isEcho(text) {
    const words = wordsOf(text);
    if (!words.length || !A.said?.length) return false;
    if (!(A.state === "speaking" || A.busy || Date.now() - (A.lastSpoke || 0) < 2500)) return false;
    const mine = A.said.flatMap((s) => s.words);
    let i = 0, matched = 0;
    for (const w of words) { const at = mine.indexOf(w, i); if (at >= 0) { matched++; i = at + 1; } }
    return words.length <= 2 ? matched === words.length : matched / words.length >= 0.7;
  }
  // "Sir" in moderation: at most once every few replies, however keen the model is on it.
  function fewerSirs(sentence) {
    const sir = String(A.status?.address || "").trim();
    if (!sir) return sentence;
    const re = new RegExp(`(?:,\\s*${sir}\\b|\\b${sir},\\s*)`, "gi");
    if (!re.test(sentence)) return sentence;
    re.lastIndex = 0;
    const turn = A.turn || 0;
    if (A.sirTurn != null && turn - A.sirTurn < 3) {
      const out = sentence.replace(re, (m) => (m.startsWith(",") ? "" : "")).replace(/^\s*(\w)/, (c) => c.toUpperCase());
      return out.trim() || sentence;
    }
    A.sirTurn = turn;
    let kept = false;
    return sentence.replace(re, (m) => { if (!kept) { kept = true; return m; } return ""; });
  }

  // Collects what's being said until there's a proper pause, so a sentence with a breath in the
  // middle isn't cut off and sent half-finished. Speaking also keeps the listening window open.
  function heard(text, isFinal) {
    clearTimeout(A.endTimer);
    if (text) { keepListening(); warmBrain(); }
    if (isFinal && text) A.heardFinal = `${A.heardFinal} ${text}`.trim();
    const sofar = isFinal ? A.heardFinal : `${A.heardFinal} ${text}`.trim();
    if (sofar) showHeard(sofar);
    if (A.heardFinal) A.endTimer = setTimeout(() => { const said = A.heardFinal; A.heardFinal = ""; if (said) ask(said); }, isFinal ? 450 : 1600);
  }
  function keepListening() {
    if (!A.awaitingCommand) return;
    clearTimeout(A.commandTimer);
    A.commandTimer = setTimeout(stopListening, 6000);
  }
  function stopListening() {
    if (A.heardFinal) return; // about to send what was said
    A.awaitingCommand = false;
    if (!A.status?.wakeWord) { try { A.recognition?.abort(); } catch {} }
    if (!A.busy) { setState("idle"); closeSoon(600); }
  }

  function listenForCommand(timeout = 8000, greet = true) {
    openStage();
    warmBrain();
    clearTimeout(A.closeTimer);
    clearTimeout(A.commandTimer);
    setState("listening");
    if (greet) { showHeard(""); showReply(""); chime(); }
    if (SR && !A.srUnavailable && !A.srBlocked) {
      A.awaitingCommand = true;
      A.srPaused = false;
      startRecognition();
      A.commandTimer = setTimeout(stopListening, timeout);
      return;
    }
    if (A.status?.serverTranscription) return recordCommand(timeout);
    setState("idle");
    showReply("Speech recognition isn't available in this browser. Type below instead.");
    typeInput.focus();
  }

  async function micAnalyser() {
    if (A.micAnalyser) return A.micAnalyser;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    A.micStream = stream;
    const ac = audioContext();
    if (ac) {
      const analyser = ac.createAnalyser(); analyser.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(analyser);
      A.micAnalyser = analyser; A.micBuffer = new Uint8Array(analyser.fftSize);
    }
    return A.micAnalyser;
  }
  function rms(analyser, buffer) {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const v of buffer) { const x = (v - 128) / 128; sum += x * x; }
    return Math.sqrt(sum / buffer.length);
  }

  // Server transcription fallback: record until the speaker pauses, then send the clip to the server.
  async function recordCommand(timeout) {
    if (A.recording) return;
    try {
      await micAnalyser();
      if (!window.MediaRecorder) throw new Error("This browser cannot record audio.");
      A.recording = true;
      const recorder = new MediaRecorder(A.micStream);
      const chunks = [];
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start();
      const started = Date.now();
      let heard = false, lastLoud = Date.now();
      await new Promise((resolve) => {
        const tick = setInterval(() => {
          const level = rms(A.micAnalyser, A.micBuffer);
          if (level > 0.045) { heard = true; lastLoud = Date.now(); }
          const elapsed = Date.now() - started;
          if ((heard && Date.now() - lastLoud > 1300) || (!heard && elapsed > timeout) || elapsed > 12000 || A.state !== "listening") { clearInterval(tick); resolve(); }
        }, 80);
      });
      recorder.stop();
      await stopped;
      A.recording = false;
      if (!heard || A.state !== "listening") { setState("idle"); return closeSoon(1500); }
      setState("thinking");
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const response = await fetch("/api/assistant/transcribe", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "I couldn't make that out.");
      if (!data.text) { setState("idle"); showReply("I didn't catch that."); return closeSoon(3000); }
      ask(data.text);
    } catch (error) {
      A.recording = false;
      setState("idle");
      showReply(error.message);
      emit({ error: error.message });
      closeSoon(4000);
    }
  }

  function chime() {
    const ac = audioContext();
    if (!ac || ac.state !== "running") return;
    const now = ac.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = ac.createOscillator(), gain = ac.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, now + i * 0.09);
      gain.gain.linearRampToValueAtTime(0.06, now + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.25);
      osc.connect(gain).connect(ac.destination);
      osc.start(now + i * 0.09); osc.stop(now + i * 0.09 + 0.3);
    });
  }

  function activate() {
    wakeScreen();
    audioContext();
    micAnalyser().catch(() => {});
    // A tap cuts him off, even mid-answer, and he listens.
    if (A.busy || A.state === "speaking") interrupt();
    listenForCommand(8000, true);
  }

  // ---------- The orb ----------
  function draw(time) {
    if (!A.open) return;
    const t = time / 1000;
    const S = canvas.width, c = S / 2;
    let target = 0;
    if (A.state === "listening") target = Math.min(1, rms(A.micAnalyser, A.micBuffer) * 7) || 0.12 + 0.08 * Math.sin(t * 3);
    else if (A.state === "speaking") target = A.outAnalyser ? Math.min(1, rms(A.outAnalyser, A.outBuffer) * 5) : 0.25 + A.speakPulse * 0.45 * (0.6 + 0.4 * Math.sin(t * 18));
    else if (A.state === "thinking") target = 0.2 + 0.1 * Math.sin(t * 6);
    A.speakPulse *= 0.9;
    A.level += (target - A.level) * 0.22;
    const lvl = A.level;
    const speed = A.state === "thinking" ? 2.6 : A.state === "listening" ? 0.9 : 0.35;
    const hue = A.state === "thinking" ? "120, 200, 255" : "86, 216, 255";
    // Power-up progress: 0 when the stage opens, 1 once the orb has fully assembled.
    const boot = HUD.reduced() ? 1 : Math.min(1, Math.max(0, (time - (A.bootAt || 0)) / 1300));
    const ease = (x) => 1 - Math.pow(1 - Math.min(1, Math.max(0, x)), 3);

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(c, c);
    ctx.lineCap = "round";

    // Outer tick ring
    ctx.save();
    ctx.rotate(t * 0.08 * speed);
    const ticks = Math.round(72 * ease(boot * 1.6));
    for (let i = 0; i < ticks; i++) {
      const a = (i / 72) * Math.PI * 2 - Math.PI / 2, long = i % 6 === 0;
      ctx.strokeStyle = `rgba(${hue}, ${long ? 0.55 : 0.22})`;
      ctx.lineWidth = long ? 2.4 : 1.4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * S * 0.44, Math.sin(a) * S * 0.44);
      ctx.lineTo(Math.cos(a) * S * (long ? 0.47 : 0.455), Math.sin(a) * S * (long ? 0.47 : 0.455));
      ctx.stroke();
    }
    ctx.restore();

    // Rotating arc segments
    const arcs = [[0.40, 3, 0.5, 6, 0.7], [0.355, 5, -0.8, 3, 0.45], [0.31, 2, 1.4, 9, 0.35]];
    arcs.forEach(([r, count, dir, width, alpha], n) => {
      const grow = ease((boot - 0.15 - n * 0.12) * 2.2);
      if (grow <= 0) return;
      ctx.save();
      ctx.rotate(t * dir * speed + (1 - grow) * dir * 4);
      ctx.strokeStyle = `rgba(${hue}, ${alpha})`;
      ctx.lineWidth = width;
      for (let i = 0; i < count; i++) {
        const start = (i / count) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, S * r, start, start + (Math.PI * 2 / count) * 0.62 * grow);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Targeting reticle: a thin ring with four notches, turning against the arcs.
    const ret = ease((boot - 0.35) * 2);
    if (ret > 0) {
      ctx.save();
      ctx.rotate(-t * 0.25 * speed - (1 - ret) * 2);
      ctx.strokeStyle = `rgba(${hue}, ${0.22 * ret})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, S * 0.27 * (0.7 + 0.3 * ret), 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${hue}, ${0.7 * ret})`;
      ctx.lineWidth = 2;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2, r1 = S * 0.255, r2 = S * 0.285;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1);
        ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Thinking: a radar sweep circling inside the rings.
    if (A.state === "thinking") {
      ctx.save();
      ctx.rotate(t * 3.2);
      const sweep = ctx.createLinearGradient(0, 0, S * 0.38, 0);
      sweep.addColorStop(0, `rgba(${hue}, 0)`);
      sweep.addColorStop(1, `rgba(${hue}, 0.55)`);
      ctx.strokeStyle = sweep;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(S * 0.16, 0);
      ctx.lineTo(S * 0.38, 0);
      ctx.stroke();
      ctx.fillStyle = `rgba(${hue}, 0.07)`;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, S * 0.38, -0.6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Ignition shockwave as the core lights.
    if (boot > 0.45 && boot < 1) {
      const w = (boot - 0.45) / 0.55;
      ctx.strokeStyle = `rgba(${hue}, ${0.8 * (1 - w)})`;
      ctx.lineWidth = 3 * (1 - w) + 0.5;
      ctx.beginPath();
      ctx.arc(0, 0, S * (0.12 + w * 0.38), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Audio-reactive waveform ring
    const wave = ease((boot - 0.3) * 2.2);
    ctx.globalAlpha = wave;
    ctx.beginPath();
    const base = S * (0.22 + lvl * 0.05) * (0.6 + 0.4 * wave);
    for (let i = 0; i <= 96; i++) {
      const a = (i / 96) * Math.PI * 2;
      const wobble = Math.sin(a * 6 + t * 4) * Math.sin(a * 3 - t * 2.3) * S * 0.035 * (0.15 + lvl);
      const r = base + wobble;
      i ? ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r) : ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.strokeStyle = `rgba(${hue}, ${0.5 + lvl * 0.5})`;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = `rgba(${hue}, 0.9)`;
    ctx.shadowBlur = 18 + lvl * 30;
    ctx.stroke();

    ctx.globalAlpha = 1;

    // Core: ignites with a bright overshoot during power-up.
    const ignite = Math.min(1, Math.max(0, (boot - 0.4) * 2.5));
    const flare = ignite > 0 && boot < 1 ? Math.sin(ignite * Math.PI) * 0.6 : 0;
    const coreR = S * (0.12 + lvl * 0.06) * (ease(ignite) + flare);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.2);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    glow.addColorStop(0.25, `rgba(${hue}, 0.85)`);
    glow.addColorStop(0.6, `rgba(${hue}, 0.18)`);
    glow.addColorStop(1, `rgba(${hue}, 0)`);
    ctx.shadowBlur = 0;
    ctx.fillStyle = glow;
    ctx.beginPath();
    if (coreR > 0) { ctx.arc(0, 0, coreR * 2.2, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
    requestAnimationFrame(draw);
  }

  // ---------- Timers and reminders ----------
  // Kept in localStorage so they survive a reload; a chip on the glass counts them down.
  const timersKey = "reflect-os-assistant-timers";
  const timerChip = document.createElement("div");
  timerChip.className = "jv-timers";
  timerChip.setAttribute("aria-live", "off");
  document.body.appendChild(timerChip);
  function loadTimers() { try { const list = JSON.parse(localStorage.getItem(timersKey) || "[]"); return Array.isArray(list) ? list : []; } catch { return []; } }
  function saveTimers(list) { try { localStorage.setItem(timersKey, JSON.stringify(list)); } catch {} renderTimers(); }
  function addTimer(timer) { const list = loadTimers(); list.push({ id: `t${Date.now().toString(36)}`, set: Date.now(), ...timer }); list.sort((a, b) => a.at - b.at); saveTimers(list.slice(0, 40)); }
  function durationText(ms) {
    const total = Math.round(ms / 1000), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return [h && `${h} hour${h === 1 ? "" : "s"}`, m && `${m} minute${m === 1 ? "" : "s"}`, sec && `${sec} second${sec === 1 ? "" : "s"}`].filter(Boolean).join(" ") || "0 seconds";
  }
  function clockText(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), sec = total % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  let shownTimers = new Set(loadTimers().map((t) => t.id));
  function renderTimers() {
    const now = Date.now();
    const list = loadTimers().filter((t) => t.kind === "timer" || t.at - now < 3600000);
    timerChip.hidden = !list.length;
    // New items lock on with a bracket flash, a bar drains as a timer runs, and the last ten seconds pulse.
    timerChip.innerHTML = list.slice(0, 3).map((t) => {
      const left = t.at - now, fresh = !shownTimers.has(t.id);
      const spent = t.kind === "timer" && t.set ? Math.min(1, Math.max(0, (now - t.set) / (t.at - t.set))) : 0;
      const cls = ["jv-timer", fresh && "is-new", t.kind === "timer" && left <= 10000 && "is-urgent"].filter(Boolean).join(" ");
      return `<span class="${cls}"><b>${t.kind === "timer" ? clockText(left) : new Date(t.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</b>${esc(t.label)}${t.kind === "timer" ? `<i style="transform:scaleX(${(1 - spent).toFixed(3)})"></i>` : ""}</span>`;
    }).join("");
    shownTimers = new Set(list.map((t) => t.id));
  }
  window.ReflectAssistant = { announce: (text) => announce(text) };
  function announce(text) {
    if (A.busy || A.state === "speaking") return setTimeout(() => announce(text), 1500);
    wakeScreen();
    openStage();
    showHeard("");
    clearLog();
    HUD.alert();
    chime(); setTimeout(chime, 450);
    setTimeout(() => speak(text), 700);
  }
  setInterval(() => {
    const now = Date.now(), list = loadTimers(), due = list.filter((t) => t.at <= now);
    if (due.length) {
      // Repeating reminders and actions go straight back on the list for their next time.
      const again = due.filter((t) => t.repeat && t.repeat !== "none").map((t) => ({ ...t, at: nextRepeat(t.at, t.repeat, false) }));
      saveTimers([...list.filter((t) => t.at > now), ...again].sort((a, b) => a.at - b.at));
      // Skip anything that went off long ago while the mirror was off.
      due.filter((t) => now - t.at < 10 * 60000).forEach((t) => {
        if (t.kind === "action") { runSteps(t.actions || []).catch(() => {}); if (t.say) announce(t.say); return; }
        announce(t.kind === "timer" ? `Your ${t.label} timer is done.` : `A reminder: ${t.label}.`);
      });
    } else renderTimers();
  }, 1000);
  renderTimers();

  // ---------- Wiring ----------
  mini.addEventListener("click", activate);
  el(".jv-close").addEventListener("click", closeStage);
  canvas.addEventListener("click", activate);
  typeForm.addEventListener("submit", (event) => { event.preventDefault(); const text = typeInput.value; typeInput.value = ""; ask(text); });
  typeInput.addEventListener("focus", () => { clearTimeout(A.closeTimer); clearTimeout(A.commandTimer); A.awaitingCommand = false; if (A.state === "listening") setState("idle"); });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && A.open) { closeStage(); return; }
    if (event.target.matches("input,select,textarea") || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.toLowerCase() === "j") { event.preventDefault(); activate(); }
  });
  // Browsers only allow audio after the first interaction; unlock it on the first tap anywhere.
  document.addEventListener("pointerdown", () => { audioContext(); }, { once: true });

  async function init() {
    try { A.status = await api("/api/assistant/status"); }
    catch { root.hidden = true; return; }
    warmKokoro();
    el(".jv-name").textContent = name().toUpperCase().split("").join(" ");
    typeInput.placeholder = `Or type to ${name()}…`;
    mini.setAttribute("aria-label", `Talk to ${name()}`);
    mini.title = A.status.configured
      ? `Say “${name()}”, press J, or tap to talk`
      : `${name()} needs an Anthropic API key in reflect-os.config.json`;
    root.classList.toggle("is-unconfigured", !A.status.configured);
    if (A.status.configured && A.status.wakeWord) startRecognition();
  }
  init();
})();
