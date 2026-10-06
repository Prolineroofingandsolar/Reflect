"use strict";

// Reflect assistant: a Jarvis-style voice assistant for the mirror.
// Listens for a wake word (or a tap / the J key), sends what it hears to Claude through the local
// server, acts on the mirror with tools, and answers out loud with an animated on-screen presence.
// Runs alongside app.js and uses its globals (profile, sampleData, showView, api, ...).
(() => {
  const A = {
    status: null, state: "idle", open: false, busy: false,
    conversation: [], lastTurn: 0,
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
    <div class="jv-stage" role="dialog" aria-modal="true" aria-label="Assistant">
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

  function setState(state) {
    A.state = state;
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
  function showHeard(text) { HUD.decode(heardEl, text ? `“${text}”` : "", { cps: 160, scramble: 60, caret: false }); }
  // Replies decode onto the glass: each letter flickers through HUD glyphs, then locks in with a flash.
  function showReply(text) {
    text = String(text || "");
    srEl.textContent = text;
    HUD.decode(replyEl, text, { cps: Math.max(70, Math.min(140, text.length / 2)), scramble: 120 });
  }
  // Adds a sentence to the reply as it arrives; each one decodes onto the glass on its own.
  function showReplyPart(text) {
    const part = document.createElement("span");
    if (replyEl.childNodes.length) replyEl.append(" ");
    replyEl.append(part);
    srEl.textContent = `${srEl.textContent} ${text}`.trim();
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
    (d.time || []).slice(0, 3).forEach((day, i) => {
      lines.push(`${i === 0 ? "Today" : i === 1 ? "Tomorrow" : day}: ${weatherLabel(d.weather_code[i]).toLowerCase()}, high ${Math.round(d.temperature_2m_max[i])}°C, low ${Math.round(d.temperature_2m_min[i])}°C, ${d.precipitation_probability_max?.[i] ?? 0}% chance of rain${i === 0 && d.sunset?.[0] ? `, sunset ${String(d.sunset[0]).slice(11, 16)}` : ""}.`);
    });
    return lines;
  }
  async function mirrorContext() {
    if (connected("smartHome") && !homeAssistantEntities.length) { try { await loadHomeAssistant(); } catch {} }
    const now = new Date();
    const lines = [
      `Time: ${now.toLocaleString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      `Person: ${profile.personName || "unknown"}`,
      `Screen showing: ${activeScreen()}`,
      `First conversation today: ${firstToday() ? "yes" : "no"}`,
      ...weatherLines()
    ];
    const events = sortedEvents().filter((e) => {
      const raw = e.start || `${e.date || ""}T${e.time || "00:00"}`;
      const date = new Date(raw);
      return Number.isNaN(date.valueOf()) || date >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }).slice(0, 10);
    lines.push(events.length ? "Calendar (id | source | title | when | location):" : "Calendar: nothing coming up.");
    events.forEach((e) => lines.push(`- ${e.id || "?"} | ${e.source === "google" ? "Google" : "on-device"} | ${e.title} | ${e.allDay ? `${String(e.start).slice(0, 10)} all day` : (e.start || `${e.date} ${e.time}`)}${e.location ? ` | ${e.location}` : ""}`));
    const tasks = sampleData.tasks.filter((t) => !t.done).slice(0, 20);
    lines.push(tasks.length ? "Open tasks (id | title | when | category):" : "Open tasks: none.");
    tasks.forEach((t) => lines.push(`- ${t.id} | ${t.title} | ${t.when || "Today"} | ${t.category || "Personal"}${t.priority ? " | high priority" : ""}`));
    if (!connected("spotify")) lines.push("Music: Spotify not connected.");
    else { const tr = sampleData.track || {}; lines.push(`Music: ${tr.playing ? "playing" : "paused"} ${tr.title && tr.title !== "Nothing playing" ? `"${tr.title}" by ${tr.artist}` : "(nothing loaded)"}.`); }
    if (!connected("smartHome")) lines.push("Smart home: Home Assistant not connected.");
    else {
      lines.push("Smart home devices (entity id | name | state):");
      homeAssistantEntities.slice(0, 80).forEach((e) => lines.push(`- ${e.id} | ${e.name} | ${e.state}${e.unit ? ` ${e.unit}` : ""}${e.brightness != null && e.state === "on" ? ` | brightness ${Math.round(e.brightness / 2.55)}%` : ""}${e.temperature != null ? ` | target ${e.temperature}` : ""}`));
    }
    const timers = loadTimers();
    lines.push(timers.length ? "Timers and reminders (id | kind | label | due):" : "Timers and reminders: none running.");
    timers.forEach((t) => lines.push(`- ${t.id} | ${t.kind} | ${t.label} | ${new Date(t.at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", second: t.kind === "timer" ? "2-digit" : undefined })}`));
    const shown = Object.entries(profile.widgets || {}).filter(([, w]) => w.visible).map(([id]) => id);
    lines.push(`Home widgets showing: ${shown.join(", ") || "none"}.`);
    lines.push(`Display: brightness ${profile.brightness}%, night mode ${profile.nightMode ? "on" : "off"}.`);
    return lines.join("\n");
  }

  // ---------- Tools ----------
  async function runTool(tool, input) {
    if (tool === "show_screen") {
      const view = input.screen === "smart_home" ? "homekit" : input.screen;
      if (!document.getElementById(`view-${view}`)) throw new Error(`There is no ${input.screen} screen.`);
      showView(view, false);
      return `Now showing ${input.screen}.`;
    }
    if (tool === "control_device") {
      if (!connected("smartHome")) throw new Error("Home Assistant is not connected.");
      const entity = homeAssistantEntities.find((e) => e.id === input.entity_id);
      if (!entity) throw new Error(`No device with id ${input.entity_id}.`);
      const d = entity.domain;
      const service = { turn_on: `${d}.turn_on`, turn_off: `${d}.turn_off`, toggle: `${d}.toggle`, activate: "scene.turn_on", lock: "lock.lock", unlock: "lock.unlock", open: "cover.open_cover", close: "cover.close_cover", set_temperature: "climate.set_temperature" }[input.action];
      if (!service) throw new Error(`Unknown action ${input.action}.`);
      const data = { entity_id: entity.id };
      if (d === "light" && input.action === "turn_on" && input.brightness_pct) data.brightness_pct = Math.max(1, Math.min(100, Math.round(input.brightness_pct)));
      if (input.action === "set_temperature") { if (!Number.isFinite(input.temperature)) throw new Error("A temperature is needed."); data.temperature = input.temperature; }
      await api("/api/homeassistant/service", { method: "POST", body: JSON.stringify({ service, data }) });
      setTimeout(loadHomeAssistant, 700);
      return `${service} sent to ${entity.name}.`;
    }
    if (tool === "music") {
      if (!connected("spotify")) throw new Error("Spotify is not connected. Connect it in Settings, Connections first.");
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
    if (tool === "delete_event") {
      const event = sampleData.events.find((e) => e.id === input.event_id);
      if (!event) throw new Error("That event is not on the calendar.");
      if (event.source === "google") throw new Error("Google Calendar events can only be deleted in Google Calendar.");
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
      addTimer({ kind: "reminder", label: text, at });
      return `Reminder set for ${new Date(at).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}: ${text}.`;
    }
    if (tool === "cancel_timer") {
      const timers = loadTimers();
      const keep = input.id === "all" ? [] : timers.filter((t) => t.id !== input.id);
      if (keep.length === timers.length) throw new Error("No timer or reminder with that id.");
      saveTimers(keep);
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
    if (tool === "set_display") {
      if (Number.isFinite(input.brightness)) profile.brightness = Math.max(30, Math.min(100, Math.round(input.brightness)));
      if (typeof input.night_mode === "boolean") profile.nightMode = input.night_mode;
      saveProfile(); applyDisplay();
      return `Display brightness ${profile.brightness}%, night mode ${profile.nightMode ? "on" : "off"}.`;
    }
    throw new Error(`Unknown tool ${tool}.`);
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
  async function spotifyTarget() {
    const { devices = [] } = await api("/api/spotify/devices");
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
    const device = await spotifyTarget();
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
    // A fresh conversation after a few quiet minutes keeps replies fast and history append-only.
    if (Date.now() - A.lastTurn > 180000 || A.conversation.length > 40) A.conversation = [];
    let reply = "", talk = null;
    const turn = ++A.turn, live = () => A.turn === turn;
    // Jarvis starts speaking as soon as his first sentence has arrived, and keeps going sentence by
    // sentence while the rest of the reply is still being written.
    const feed = sentenceFeeder((sentence) => {
      if (!live()) return;
      if (!talk) { talk = startTalking(); showReply(""); if (A.timing && !A.timing.text) A.timing.text = performance.now(); }
      showReplyPart(sentence);
      talk.say(sentence);
    });
    try {
      A.conversation.push({ role: "user", content: [{ type: "text", text: `[Mirror context]\n${await mirrorContext()}\n\nThey said: ${text}` }] });
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
          try { const done = String(await runTool(use.name, use.input || {})); logAction(done); return { type: "tool_result", tool_use_id: use.id, content: done }; }
          catch (error) { logAction(error.message, true); return { type: "tool_result", tool_use_id: use.id, content: error.message, is_error: true }; }
        }));
        A.conversation.push({ role: "user", content: results });
      }
      const last = A.conversation.at(-1);
      if (last && (last.role === "user" || last.content.some((b) => b.type === "tool_use"))) A.conversation = [];
      A.lastTurn = Date.now();
      markBriefed();
    } catch (error) {
      A.conversation = [];
      reply = error.message;
      if (talk && live()) { showReplyPart(reply); talk.say(reply); }
    } finally {
      A.busy = false;
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
          if (stop - cut >= (first ? 12 : 25)) { const piece = buffer.slice(cut, stop).trim(); if (piece) { say(piece); first = false; } cut = stop; }
        }
        buffer = buffer.slice(cut);
        if (first) {
          const pause = /(?:[,;:\u2013\u2014]|\s-)\s+/g;
          while ((m = pause.exec(buffer))) {
            const stop = m.index + m[0].length;
            if (stop >= 12) { say(buffer.slice(0, stop).trim()); first = false; buffer = buffer.slice(stop); break; }
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
        u.rate = 1.08; u.pitch = 1;
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
    source.connect(A.outAnalyser); A.outAnalyser.connect(ac.destination);
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
        source.connect(A.outAnalyser); A.outAnalyser.connect(ac.destination);
      } catch { A.outAnalyser = null; }
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
    let generating = Promise.resolve(), playing = Promise.resolve(), broken = false;
    return {
      say(chunk) {
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
      .then((data) => { K.ready = true; K.engine = data.engine || "built-in voice"; console.info(`Built-in voice ready in ${((performance.now() - started) / 1000).toFixed(1)}s`); })
      .catch((error) => { K.failed = true; console.warn("Built-in voice unavailable:", error.message); });
  }
  async function makeKokoro(text) {
    // Kokoro's normal pace sounds slow and drawn out for Jarvis; a little quicker sounds natural.
    const { blob } = await kokoroCall({ type: "speak", text, voice: kokoroVoice(), speed: 1.12 });
    return URL.createObjectURL(blob);
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
  function interrupt() { A.turn++; A.timing = null; stopSpeaking(); }
  function stopSpeaking() {
    A.speakRun = (A.speakRun || 0) + 1;
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (A.currentAudio) { A.currentAudio.pause(); A.currentAudio = null; }
    if (A.currentSource) { try { A.currentSource.stop(); } catch {} A.currentSource = null; }
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
    listenForCommand(10000, !after);
    heard(after, isFinal);
  }
  // Collects what's being said until there's a proper pause, so a sentence with a breath in the
  // middle isn't cut off and sent half-finished. Speaking also keeps the listening window open.
  function heard(text, isFinal) {
    clearTimeout(A.endTimer);
    if (text) keepListening();
    if (isFinal && text) A.heardFinal = `${A.heardFinal} ${text}`.trim();
    const sofar = isFinal ? A.heardFinal : `${A.heardFinal} ${text}`.trim();
    if (sofar) showHeard(sofar);
    if (A.heardFinal) A.endTimer = setTimeout(() => { const said = A.heardFinal; A.heardFinal = ""; if (said) ask(said); }, isFinal ? 800 : 2200);
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
  function addTimer(timer) { const list = loadTimers(); list.push({ id: `t${Date.now().toString(36)}`, set: Date.now(), ...timer }); list.sort((a, b) => a.at - b.at); saveTimers(list.slice(-12)); }
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
  function announce(text) {
    if (A.busy || A.state === "speaking") return setTimeout(() => announce(text), 1500);
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
      saveTimers(list.filter((t) => t.at > now));
      // Skip anything that went off long ago while the mirror was off.
      due.filter((t) => now - t.at < 10 * 60000).forEach((t) => announce(t.kind === "timer" ? `Your ${t.label} timer is done.` : `A reminder: ${t.label}.`));
    } else renderTimers();
  }, 1000);
  renderTimers();

  // ---------- Wiring ----------
  mini.addEventListener("click", activate);
  el(".jv-close").addEventListener("click", closeStage);
  canvas.addEventListener("click", activate);
  stage.addEventListener("click", (event) => { if (event.target === stage) closeStage(); });
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
