"use strict";

// People on this mirror. Each person who teaches Jarvis their voice gets a profile: a name, how
// Jarvis should address them, and a few voiceprints (from voice-id-worker.js). When Jarvis
// recognises who is talking, the mirror switches to them: their greeting, their tasks and their
// on-device calendar, alongside anything shared by the household. After a few quiet minutes it
// goes back to the mirror's owner (the person named in Settings, General).
// Tasks and events carry an `owner` person id; anything without one is shared and always shown.
// Runs after app.js and uses its globals (profile, renderHome, ...); assistant.js drives it.
const People = (() => {
  const storeKey = "reflect-os-people-v1";
  const idleMs = 5 * 60000, maxVoices = 12;
  // Voiceprints from this model only; another model's would not compare.
  const model = "wavlm-base-plus-sv";
  let state = load();
  // Who the mirror is showing: a person id, "guest" (a voice it doesn't know), or "" (the owner).
  let active = "", activeScore = 0, lastSeen = 0;

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(storeKey) || "{}");
      if (saved.model === model && Array.isArray(saved.people)) return saved;
    } catch {}
    return { model, people: [] };
  }
  function save() { try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch {} }

  const list = () => state.people;
  const byId = (id) => state.people.find((p) => p.id === id) || null;
  const byName = (name) => state.people.find((p) => p.name.toLowerCase() === String(name || "").trim().toLowerCase()) || null;
  // The mirror's owner: whoever has the name set in Settings, General.
  const owner = () => byName(profile.personName);

  // ---------- Voiceprints ----------
  function unit(v) {
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    return v.map((x) => Math.round((x / n) * 1e5) / 1e5);
  }
  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na * nb) || 1);
  }
  // How alike a voice is to a person: the average of its two closest matches among their voiceprints,
  // so one odd recording neither makes nor breaks a match.
  function likeness(person, print) {
    const sims = person.voices.map((v) => cosine(v, print)).sort((a, b) => b - a);
    return sims.length > 1 ? (sims[0] + sims[1]) / 2 : sims[0] || 0;
  }
  // Each person's own bar, learned from how alike their enrolment recordings were to each other:
  // a steady voice gets a stricter bar. The config file can set one bar for everyone instead.
  function bar(person, fixed) {
    if (Number.isFinite(fixed) && fixed > 0) return fixed;
    return Number.isFinite(person.bar) ? person.bar : 0.82;
  }
  function selfBar(prints) {
    const sims = [];
    for (let i = 0; i < prints.length; i++) for (let j = i + 1; j < prints.length; j++) sims.push(cosine(prints[i], prints[j]));
    if (!sims.length) return 0.82;
    const mean = sims.reduce((a, b) => a + b, 0) / sims.length;
    return Math.min(0.9, Math.max(0.75, mean - 0.05));
  }

  // Who does this voice belong to? Returns { person, score } for a confident match, else { person: null }.
  function identify(print, fixedBar) {
    const ranked = state.people.filter((p) => p.voices.length)
      .map((person) => ({ person, score: likeness(person, print) }))
      .sort((a, b) => b.score - a.score);
    const best = ranked[0], next = ranked[1];
    if (!best) return { person: null, score: 0 };
    // Two people who sound alike: only call it when one is clearly closer.
    const clear = !next || best.score - next.score > 0.02;
    if (best.score >= bar(best.person, fixedBar) && clear) {
      // A confident match also teaches it a little more about how they sound day to day.
      if (best.score >= bar(best.person, fixedBar) + 0.05) {
        best.person.voices.push(unit(print));
        if (best.person.voices.length > maxVoices) best.person.voices.splice(best.person.enrolled || 3, 1); // keeps the enrolment recordings
        save();
      }
      return best;
    }
    return { person: null, score: best.score };
  }

  function learn(name, prints, address = "") {
    name = String(name || "").trim().slice(0, 40);
    if (!name) throw new Error("I need a name to go with the voice.");
    const voices = prints.map(unit);
    let person = byName(name);
    if (person) { person.voices = voices; person.enrolled = voices.length; person.bar = selfBar(voices); if (address) person.address = address; }
    else {
      person = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name, address: String(address || "").trim().slice(0, 20), voices, enrolled: voices.length, bar: selfBar(voices), added: Date.now() };
      state.people.push(person);
    }
    save();
    setActive(person.id, 1);
    return person;
  }
  function forget(id) {
    const person = byId(id);
    if (!person) throw new Error("There's nobody by that name on this mirror.");
    state.people = state.people.filter((p) => p !== person);
    save();
    if (active === id) setActive("");
    else changed();
    return person;
  }

  // ---------- Who the mirror is showing ----------
  function setActive(id, score = 0) {
    const was = active;
    active = id || "";
    activeScore = score;
    lastSeen = Date.now();
    // The owner is the mirror's normal state, so there's nothing to announce.
    if (active && active !== "guest" && active === owner()?.id) active = "";
    if (was !== active) changed(true);
    else badge(false);
  }
  function touch() { lastSeen = Date.now(); }
  const current = () => (active === "guest" ? null : byId(active) || owner());
  const isGuest = () => active === "guest";
  // What the mirror shows: shared items, plus the current person's own.
  function canSee(item) {
    if (!item?.owner || !byId(item.owner)) return true;
    return !isGuest() && item.owner === current()?.id;
  }
  // New tasks and events belong to whoever asked for them; with nobody enrolled they stay shared.
  function ownerForNew() { return isGuest() ? "" : current()?.id || ""; }
  function greetingName() { return isGuest() ? "" : current()?.name || profile.personName; }

  // Spoken context for Jarvis: who's there and how to address them.
  function contextLines() {
    if (!state.people.length) return [`Person: ${profile.personName || "unknown"}`];
    const names = state.people.map((p) => p.name).join(", ");
    if (isGuest()) return [`Person: a guest (their voice doesn't match anyone on this mirror). Keep it friendly; personal items aren't shown to guests.`, `People this mirror knows: ${names}.`];
    const who = current();
    if (!who) return [`Person: ${profile.personName || "unknown"}`, `People this mirror knows by voice: ${names}.`];
    const how = active ? `recognised by voice, ${Math.round(activeScore * 100)}% match` : "the mirror's owner";
    return [`Person: ${who.name} (${how})${who.address ? `; address them as "${who.address}"` : ""}`, `People this mirror knows by voice: ${names}.`];
  }

  // ---------- On the glass ----------
  const badgeEl = document.createElement("div");
  badgeEl.className = "who-badge";
  badgeEl.hidden = true;
  badgeEl.setAttribute("aria-live", "polite");
  document.body.appendChild(badgeEl);
  function badge(fresh) {
    const who = current();
    const show = isGuest() || (active && who);
    badgeEl.hidden = !show;
    if (!show) return;
    badgeEl.innerHTML = isGuest()
      ? `<i></i><b>Guest</b><span>Voice not recognised</span>`
      : `<i></i><b>${esc(who.name)}</b><span>Voice match ${Math.round(activeScore * 100)}%</span>`;
    if (fresh) { badgeEl.classList.remove("is-new"); void badgeEl.offsetWidth; badgeEl.classList.add("is-new"); }
  }
  function changed(fresh = false) {
    badge(fresh);
    try { renderHome(); renderTaskPage(); renderCalendarPage(); updateClock(); } catch {}
    if (typeof settingsPage !== "undefined" && settingsPage === "people") renderSettings();
  }
  // Back to the owner after a few quiet minutes.
  setInterval(() => { if (active && Date.now() - lastSeen > idleMs) setActive(""); }, 15000);

  // ---------- Settings, People ----------
  function renderSettings() {
    const el = document.getElementById("peopleList");
    if (!el) return;
    el.innerHTML = state.people.length
      ? state.people.map((p) => `<div class="settings-field people-row"><span>${esc(p.name)}${p.id === owner()?.id ? ' <small>Owner</small>' : ""}${p.id === current()?.id && active ? ' <small>Here now</small>' : ""}</span><button class="ghost-button" type="button" data-forget-person="${esc(p.id)}">Forget voice</button></div>`).join("")
      : `<p class="settings-help">Nobody yet. Say “Jarvis, learn my voice”, or add someone below.</p>`;
    el.querySelectorAll("[data-forget-person]").forEach((b) => b.addEventListener("click", () => {
      const person = byId(b.dataset.forgetPerson);
      if (person && confirm(`Forget ${person.name}'s voice? Their tasks and events become shared.`)) forget(person.id);
    }));
  }
  document.getElementById("learnVoiceForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const input = document.getElementById("learnVoiceName");
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    input.value = "";
    window.dispatchEvent(new CustomEvent("reflect:learn-voice", { detail: { name } }));
  });

  return { list, byId, byName, identify, learn, forget, setActive, touch, current, isGuest, canSee, ownerForNew, greetingName, contextLines, renderSettings, hasVoices: () => state.people.some((p) => p.voices.length) };
})();
