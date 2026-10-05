"use strict";

// Reflect HUD motion: the Iron Man feel. Text decodes onto the glass through scrambled glyphs,
// the home screen powers up on load, widgets materialise when they appear, and the clock glitches
// as the minute turns over. Everything falls back to plain text with reduced motion turned on.
const HUD = (() => {
  const GLYPHS = "ABCDEFGHJKLMNPRSTUVWXYZ0123456789<>/\\|=+*#%$&";
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Writes text into el one character at a time. Each character flickers through a few random
  // glyphs before it locks in with a brief flash, with a bright cursor riding the leading edge.
  // The real character always holds its space, so wrapping never jumps while it writes.
  function decode(el, text, { cps = 55, scramble = 120, caret = true, delay = 0 } = {}) {
    const run = (el.hudRun = (el.hudRun || 0) + 1);
    text = String(text ?? "");
    if (!text || reduced()) { el.textContent = text; return Promise.resolve(); }
    el.textContent = "";
    el.classList.add("hud-writing");
    const chars = [];
    text.split(/(\s+)/).forEach((part) => {
      if (!part) return;
      if (/^\s+$/.test(part)) { el.append(part); return; }
      const word = document.createElement("span");
      word.className = "hud-w";
      for (const ch of part) {
        const c = document.createElement("span");
        c.className = "hud-c";
        c.textContent = ch;
        word.append(c);
        chars.push(c);
      }
      el.append(word);
    });
    return new Promise((resolve) => {
      const live = new Map();
      let head = 0, start = 0, frame = 0, lastHead = null;
      const finish = () => { lastHead?.classList.remove("is-head"); el.classList.remove("hud-writing"); resolve(); };
      const tick = (now) => {
        if (el.hudRun !== run || !el.isConnected) return finish();
        if (!start) start = now + delay;
        frame++;
        const due = now < start ? 0 : Math.min(chars.length, Math.floor(((now - start) / 1000) * cps) + 1);
        // Each character scrambles for `scramble` ms from when it appears, then locks in.
        while (head < due) { const c = chars[head++]; c.classList.add("is-scr"); c.dataset.g = glyph(); live.set(c, now + scramble); }
        live.forEach((until, c) => {
          if (now >= until) { live.delete(c); c.classList.remove("is-scr"); c.classList.add("is-lit"); }
          else if (frame % 3 === 0) c.dataset.g = glyph();
        });
        if (caret) {
          const current = chars[head - 1] || null;
          if (current !== lastHead) { lastHead?.classList.remove("is-head"); current?.classList.add("is-head"); lastHead = current; }
        }
        if (head >= chars.length && !live.size) return finish();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  // A short label snapping into place: every letter scrambles at once, then locks in left to right.
  function glitch(el, text, ms = 420) {
    text = String(text ?? "");
    return decode(el, text, { cps: Math.max(20, (text.length / (ms / 1000)) * 2), scramble: ms / 2, caret: false });
  }

  // ---------- Home screen ----------
  const body = document.body;
  const grid = document.getElementById("layoutGrid");
  const status = document.querySelector(".hud-status-text");
  let booting = !reduced();
  if (booting) {
    body.classList.add("hud-boot");
    setTimeout(() => { booting = false; body.classList.remove("hud-boot"); }, 3200);
    if (status) {
      const online = status.textContent;
      glitch(status, "INITIALISING", 500);
      setTimeout(() => glitch(status, online, 600), 1500);
    }
  }

  // Widgets that weren't on the glass a moment ago materialise: a scan line draws them in top to
  // bottom while they flicker into focus, and their headings decode. Re-renders of widgets that
  // were already showing (a new photo, a weather refresh, dragging in edit mode) stay still.
  let shown = null;
  function widgetsChanged() {
    const widgets = [...grid.querySelectorAll(".mirror-widget:not(.photo-mirror-widget)")];
    const ids = new Set(widgets.map((w) => w.dataset.widget));
    if (!reduced()) {
      let i = 0;
      widgets.forEach((w) => {
        if (shown?.has(w.dataset.widget)) return;
        const order = i++, wait = (booting ? 500 : 0) + order * 150;
        w.style.setProperty("--hud-delay", `${wait}ms`);
        w.classList.add("is-arriving");
        setTimeout(() => w.classList.remove("is-arriving"), wait + 1100);
        w.querySelectorAll("h2").forEach((h) => !h.children.length && decode(h, h.textContent, { cps: 40, scramble: 160, caret: false, delay: wait + 250 }));
      });
    }
    shown = ids;
  }
  if (grid) {
    new MutationObserver(widgetsChanged).observe(grid, { childList: true });
    if (grid.children.length) widgetsChanged();
  }

  // The clock: a glitch flash as each minute turns, and a pulse on every second.
  let lastTime = "", lastSec = "";
  setInterval(() => {
    if (reduced()) return;
    const time = document.getElementById("timeNow"), sec = document.getElementById("timeSec");
    if (time && time.textContent !== lastTime) {
      if (lastTime) { time.classList.remove("hud-tick"); void time.offsetWidth; time.classList.add("hud-tick"); }
      lastTime = time.textContent;
    }
    if (sec && sec.textContent !== lastSec) {
      sec.classList.remove("hud-pulse"); void sec.offsetWidth; sec.classList.add("hud-pulse");
      lastSec = sec.textContent;
    }
  }, 150);

  // A full-glass edge flare, for timers and reminders going off.
  function alert() {
    if (reduced()) return;
    const flare = document.createElement("div");
    flare.className = "hud-alert";
    body.append(flare);
    setTimeout(() => flare.remove(), 2600);
  }

  return { decode, glitch, alert, reduced, wait };
})();
