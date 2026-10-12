// Doorbell pop-up: when a doorbell (Ring, Nest, Aqara...) is pressed, its camera fills the mirror and Jarvis says so.
// Home Assistant reports a press as an "event" entity whose state is the time it happened (event.front_door_ding),
// or on older set-ups as a binary sensor that flicks on (binary_sensor.front_door_ding).
(() => {
  const bridge = window.ReflectBridge;
  if (!bridge?.onChange) return;
  const seen = new Map();
  let pop = null, hideTimer = null, refreshTimer = null;

  const isDoorbell = (e) => {
    const id = String(e.id || "");
    if (e.domain === "event") return e.deviceClass === "doorbell" || /^(ding|ring|doorbell|press)/i.test(e.eventType) && /(ding|doorbell|bell)/i.test(id + e.name) || /_ding$|doorbell/i.test(id);
    if (e.domain === "binary_sensor") return /_ding$/.test(id) || (e.deviceClass === "occupancy" && /doorbell/i.test(id));
    return false;
  };
  const pressed = (e) => {
    if (e.domain === "binary_sensor") return e.state === "on";
    const when = Date.parse(e.state);
    return Number.isFinite(when) && Math.abs(Date.now() - when) < 60000;
  };
  // Ring names the bell event.front_door_ding and the camera camera.front_door_live_view; match on the shared start.
  const cameraFor = (e) => {
    const cams = bridge.entities().filter((x) => x.domain === "camera");
    const stem = String(e.id).split(".")[1].replace(/_(ding|doorbell|motion|press|button|visitor)$/, "");
    const named = cams.filter((c) => c.id.split(".")[1].startsWith(stem));
    return named.find((c) => /live_view/.test(c.id)) || named[0] || (e.areaId && cams.find((c) => c.areaId === e.areaId)) || null;
  };
  const placeFor = (e) => {
    const name = String(e.name || "").replace(/\b(ding|doorbell|ring|button|press|event)\b/gi, "").replace(/\s+/g, " ").trim();
    return name && !/^front$/i.test(name) ? name.toLowerCase().replace(/^(the )?/, "the ") : "the front door";
  };

  function build() {
    pop = document.createElement("div");
    pop.className = "db-pop";
    pop.setAttribute("role", "alertdialog");
    pop.setAttribute("aria-live", "assertive");
    pop.innerHTML = `<div class="db-card"><span class="db-corner tl"></span><span class="db-corner tr"></span><span class="db-corner bl"></span><span class="db-corner br"></span>
      <p class="db-eyebrow"><span class="db-dot"></span>Doorbell</p><h2 class="db-title"></h2>
      <div class="db-feed"><img alt="Doorbell camera" hidden><div class="db-nofeed">No camera picture</div><span class="db-scan"></span></div>
      <footer><span class="db-time"></span><button type="button" class="db-dismiss">Dismiss</button></footer></div>`;
    pop.querySelector(".db-dismiss").addEventListener("click", hide);
    pop.addEventListener("click", (ev) => { if (ev.target === pop) hide(); });
    document.body.appendChild(pop);
  }

  function show(e) {
    if (!pop) build();
    const place = placeFor(e);
    pop.querySelector(".db-title").textContent = `Someone's at ${place}`;
    pop.querySelector(".db-time").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const img = pop.querySelector("img"), none = pop.querySelector(".db-nofeed"), cam = cameraFor(e);
    clearInterval(refreshTimer);
    img.hidden = true; none.hidden = false;
    if (cam) {
      const load = () => { img.src = `/api/homeassistant/camera/${encodeURIComponent(cam.id)}?still=1&t=${Date.now()}`; };
      img.onload = () => { img.hidden = false; none.hidden = true; };
      img.onerror = () => {};
      load();
      refreshTimer = setInterval(load, 1500);
    }
    pop.classList.remove("is-leaving");
    pop.classList.add("is-open");
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 45000);
    try { window.ReflectAssistant?.announce(`Someone's at ${place}.`); } catch {}
  }

  function hide() {
    if (!pop?.classList.contains("is-open")) return;
    clearTimeout(hideTimer); clearInterval(refreshTimer);
    pop.classList.add("is-leaving");
    setTimeout(() => { pop.classList.remove("is-open", "is-leaving"); pop.querySelector("img").removeAttribute("src"); }, 350);
  }
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") hide(); });

  bridge.onChange((changed) => {
    if (!changed) return;
    for (const e of changed) {
      if (!isDoorbell(e)) continue;
      const before = seen.get(e.id);
      seen.set(e.id, e.state);
      if (before === e.state || !pressed(e)) continue;
      show(e);
    }
  });

  window.ReflectDoorbell = { show: (name = "Front door") => show({ id: "event.front_door_ding", domain: "event", name, state: new Date().toISOString() }), hide };
})();
