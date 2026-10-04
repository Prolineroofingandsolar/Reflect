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
    level: 0, speakPulse: 0, currentAudio: null, voice: null, closeTimer: null, recording: false
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
      <div class="jv-name"></div>
      <canvas class="jv-orb" width="560" height="560" aria-hidden="true"></canvas>
      <div class="jv-state" aria-live="polite"></div>
      <p class="jv-heard"></p>
      <p class="jv-reply" aria-live="polite"></p>
      <form class="jv-type" autocomplete="off"><input type="text" maxlength="300" aria-label="Type a request"><button type="submit">Send</button></form>
    </div>`;
  document.body.appendChild(root);
  const el = (s) => root.querySelector(s);
  const mini = el(".jv-mini"), stage = el(".jv-stage"), canvas = el(".jv-orb"), stateLabel = el(".jv-state");
  const heardEl = el(".jv-heard"), replyEl = el(".jv-reply"), typeForm = el(".jv-type"), typeInput = el(".jv-type input");
  const ctx = canvas.getContext("2d");

  const name = () => A.status?.name || "Jarvis";
  const stateText = { idle: "Standing by", listening: "Listening", thinking: "Thinking", speaking: "", error: "" };

  function setState(state) {
    A.state = state;
    root.dataset.state = state;
    stateLabel.textContent = stateText[state] ?? "";
  }
  function openStage() {
    clearTimeout(A.closeTimer);
    if (A.open) return;
    A.open = true;
    root.classList.add("is-open");
    requestAnimationFrame(draw);
  }
  function closeStage() {
    clearTimeout(A.closeTimer);
    clearTimeout(A.commandTimer);
    A.awaitingCommand = false;
    stopSpeaking();
    A.open = false;
    root.classList.remove("is-open");
    heardEl.textContent = "";
    replyEl.textContent = "";
    typeInput.blur();
    setState("idle");
  }
  function closeSoon(ms = 6000) {
    clearTimeout(A.closeTimer);
    A.closeTimer = setTimeout(() => { if (!A.busy && A.state !== "speaking" && A.state !== "listening") closeStage(); }, ms);
  }
  function showHeard(text) { heardEl.textContent = text ? `“${text}”` : ""; }
  function showReply(text) { replyEl.textContent = text; }

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
      ...weatherLines()
    ];
    const events = sortedEvents().filter((e) => {
      const raw = e.start || `${e.date || ""}T${e.time || "00:00"}`;
      const date = new Date(raw);
      return Number.isNaN(date.valueOf()) || date >= new Date(now.getFullYear(), now.getMonth(), now.getDate());
    }).slice(0, 10);
    lines.push(events.length ? "Calendar:" : "Calendar: nothing coming up.");
    events.forEach((e) => lines.push(`- ${e.title} | ${e.allDay ? `${String(e.start).slice(0, 10)} all day` : (e.start || `${e.date} ${e.time}`)}${e.location ? ` | ${e.location}` : ""}`));
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
      if (!connected("spotify")) throw new Error("Spotify is not connected.");
      const playing = Boolean(sampleData.track?.playing);
      if (input.action === "play_search") {
        const query = String(input.query || "").trim();
        if (!query) throw new Error("Nothing to search for.");
        const { tracks = [] } = await api(`/api/spotify/search?q=${encodeURIComponent(query)}`);
        if (!tracks.length) throw new Error(`Spotify found nothing for ${query}.`);
        await playSpotifyTrack(tracks[0]);
        setTimeout(loadSpotify, 1200);
        return `Playing ${tracks[0].name} by ${tracks[0].artists}.`;
      }
      if (input.action === "play") {
        if (playing) return "Music is already playing.";
        await runSpotifyAction("play");
      } else if (input.action === "pause" && !playing) {
        return "Music is already paused.";
      } else {
        await api(`/api/spotify/player/${input.action}`, { method: "POST", body: "{}" });
      }
      setTimeout(loadSpotify, 800);
      return `Music: ${input.action} done.`;
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
    if (tool === "set_display") {
      if (Number.isFinite(input.brightness)) profile.brightness = Math.max(30, Math.min(100, Math.round(input.brightness)));
      if (typeof input.night_mode === "boolean") profile.nightMode = input.night_mode;
      saveProfile(); applyDisplay();
      return `Display brightness ${profile.brightness}%, night mode ${profile.nightMode ? "on" : "off"}.`;
    }
    throw new Error(`Unknown tool ${tool}.`);
  }

  // ---------- Conversation with Claude (via the local server) ----------
  async function ask(text) {
    text = String(text || "").trim();
    if (!text || A.busy) return;
    clearTimeout(A.commandTimer);
    A.awaitingCommand = false;
    openStage();
    showHeard(text);
    showReply("");
    if (!A.status?.configured) return speak(`I'm not connected to my brain yet. Add an Anthropic API key to the Reflect config file and restart me.`);
    A.busy = true;
    setState("thinking");
    // A fresh conversation after a few quiet minutes keeps replies fast and history append-only.
    if (Date.now() - A.lastTurn > 180000 || A.conversation.length > 40) A.conversation = [];
    let reply = "";
    try {
      A.conversation.push({ role: "user", content: [{ type: "text", text: `[Mirror context]\n${await mirrorContext()}\n\nThey said: ${text}` }] });
      for (let step = 0; step < 6; step++) {
        const result = await api("/api/assistant/chat", { method: "POST", body: JSON.stringify({ messages: A.conversation }) });
        const content = Array.isArray(result.content) ? result.content : [];
        if (result.stop_reason === "refusal") { reply = "I'm afraid that's one I can't help with."; A.conversation = []; break; }
        A.conversation.push({ role: "assistant", content });
        const said = content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
        const uses = content.filter((b) => b.type === "tool_use");
        if (result.stop_reason !== "tool_use" || !uses.length) { reply = said; break; }
        if (said) showReply(said);
        const results = await Promise.all(uses.map(async (use) => {
          try { return { type: "tool_result", tool_use_id: use.id, content: String(await runTool(use.name, use.input || {})) }; }
          catch (error) { return { type: "tool_result", tool_use_id: use.id, content: error.message, is_error: true }; }
        }));
        A.conversation.push({ role: "user", content: results });
      }
      const last = A.conversation.at(-1);
      if (last && (last.role === "user" || last.content.some((b) => b.type === "tool_use"))) A.conversation = [];
      A.lastTurn = Date.now();
    } catch (error) {
      A.conversation = [];
      reply = error.message;
    } finally {
      A.busy = false;
    }
    await speak(reply || "Done.");
  }

  // ---------- Speaking ----------
  function audioContext() {
    if (!A.audioCtx) { try { A.audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    if (A.audioCtx.state === "suspended") A.audioCtx.resume().catch(() => {});
    return A.audioCtx;
  }
  function pickVoice() {
    if (!("speechSynthesis" in window)) return null;
    const voices = speechSynthesis.getVoices();
    const preferred = ["Daniel", "Google UK English Male", "Arthur", "Oliver", "Malcolm", "George"];
    for (const wanted of preferred) { const v = voices.find((x) => x.name.includes(wanted) && /^en[-_]GB/i.test(x.lang)); if (v) return v; }
    return voices.find((v) => /^en[-_]GB/i.test(v.lang)) || voices.find((v) => /^en/i.test(v.lang)) || null;
  }
  if ("speechSynthesis" in window) speechSynthesis.addEventListener?.("voiceschanged", () => { A.voice = pickVoice(); });

  function speakBrowser(text) {
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
        u.rate = 1.03; u.pitch = 0.92;
        u.onboundary = () => { A.speakPulse = 1; };
        u.onstart = () => { A.speakPulse = 1; };
        if (i === parts.length - 1) { u.onend = done; u.onerror = done; }
        speechSynthesis.speak(u);
      });
    });
  }
  async function speakServer(text) {
    const response = await fetch("/api/assistant/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!response.ok) throw new Error("Server voice unavailable");
    const url = URL.createObjectURL(await response.blob());
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
    await new Promise((resolve, reject) => {
      audio.onended = resolve;
      audio.onpause = resolve;
      audio.onerror = () => reject(new Error("Playback failed"));
      audio.play().catch(reject);
    }).finally(() => { URL.revokeObjectURL(url); A.currentAudio = null; A.outAnalyser = null; });
  }
  function stopSpeaking() {
    if ("speechSynthesis" in window) speechSynthesis.cancel();
    if (A.currentAudio) { A.currentAudio.pause(); A.currentAudio = null; }
  }
  async function speak(text) {
    openStage();
    showReply(text);
    setState("speaking");
    pauseRecognition();
    try {
      if (A.status?.serverVoice) await speakServer(text).catch(() => speakBrowser(text));
      else await speakBrowser(text);
    } catch {}
    resumeRecognition();
    if (A.state !== "speaking") return; // interrupted by a tap or closed
    // Like a real conversation: stay listening briefly for a follow-up without the wake word.
    if (canListen()) listenForCommand(7000, false);
    else { setState("idle"); closeSoon(); }
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
    if (!A.status?.wakeWord && !A.awaitingCommand) return;
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
  function pauseRecognition() { A.srPaused = true; try { A.recognition?.abort(); } catch {} A.recognition = null; }
  function resumeRecognition() { A.srPaused = false; startRecognition(); }

  function handleTranscript(transcript, isFinal) {
    if (A.busy || A.state === "speaking") return;
    if (A.awaitingCommand) {
      const text = transcript.replace(wakePattern(), "").trim();
      showHeard(text);
      if (isFinal && text) ask(text);
      return;
    }
    const match = transcript.match(wakePattern());
    if (!match) return;
    const after = transcript.slice(match.index + match[0].length).trim();
    openStage();
    setState("listening");
    showHeard(after);
    if (!isFinal) return;
    if (after.split(/\s+/).filter(Boolean).length >= 2) ask(after);
    else listenForCommand(8000, true);
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
      A.commandTimer = setTimeout(() => {
        A.awaitingCommand = false;
        if (!A.status?.wakeWord) { try { A.recognition?.abort(); } catch {} }
        if (!A.busy) { setState("idle"); closeSoon(greet ? 2500 : 600); }
      }, timeout);
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
    if (A.busy) return openStage();
    if (A.state === "speaking") stopSpeaking();
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

    ctx.clearRect(0, 0, S, S);
    ctx.save();
    ctx.translate(c, c);
    ctx.lineCap = "round";

    // Outer tick ring
    ctx.save();
    ctx.rotate(t * 0.08 * speed);
    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2, long = i % 6 === 0;
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
    arcs.forEach(([r, count, dir, width, alpha]) => {
      ctx.save();
      ctx.rotate(t * dir * speed);
      ctx.strokeStyle = `rgba(${hue}, ${alpha})`;
      ctx.lineWidth = width;
      for (let i = 0; i < count; i++) {
        const start = (i / count) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(0, 0, S * r, start, start + (Math.PI * 2 / count) * 0.62);
        ctx.stroke();
      }
      ctx.restore();
    });

    // Audio-reactive waveform ring
    ctx.beginPath();
    const base = S * (0.22 + lvl * 0.05);
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

    // Core
    const coreR = S * (0.12 + lvl * 0.06);
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR * 2.2);
    glow.addColorStop(0, "rgba(255, 255, 255, 0.95)");
    glow.addColorStop(0.25, `rgba(${hue}, 0.85)`);
    glow.addColorStop(0.6, `rgba(${hue}, 0.18)`);
    glow.addColorStop(1, `rgba(${hue}, 0)`);
    ctx.shadowBlur = 0;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(0, 0, coreR * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    requestAnimationFrame(draw);
  }

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
