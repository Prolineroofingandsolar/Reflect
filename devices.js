// Smart Devices: the store for adding smart home brands. Every brand looks and connects the same way:
// one card, one Connect button, then the brand's own steps shown as mirror cards. Behind the scenes the
// mirror's hidden home engine (server.js, home-engine.js) does the pairing.
(() => {
  "use strict";
  const D = { data: null, flow: null, brand: null, poll: null, loading: null };
  const el = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const mark = (name) => name.split(/[\s-]+/).filter((w) => /^[A-Za-z]/.test(w)).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const request = async (url, options = {}) => {
    const response = await fetch(url, { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "That didn't work.");
    return data;
  };

  async function load() {
    if (D.loading) return D.loading;
    D.loading = (async () => {
      try {
        D.data = await request("/api/devices");
        // The built-in engine counts as this account's smart home once something is connected.
        if (D.data.addOn && typeof profile !== "undefined") {
          const was = profile.addOns.smartHome?.connectionStatus;
          profile.addOns.smartHome = { ...profile.addOns.smartHome, ...D.data.addOn };
          if (was !== D.data.addOn.connectionStatus) { saveProfile(); applyAvailability?.(); loadHomeAssistant?.(); }
        }
      } catch (error) {
        D.data = { engine: { available: false, reason: error.message }, catalog: { categories: [], brands: [] }, entries: [], found: [] };
      }
      render();
    })().finally(() => { D.loading = null; });
    return D.loading;
  }

  const connectedTo = (brand) => (D.data?.entries || []).filter((e) => e.domain === brand.domain);
  const foundFor = (brand) => (D.data?.found || []).filter((f) => f.domain === brand.domain);

  function render() {
    const data = D.data;
    if (!data) return;
    const q = (el("dvSearch")?.value || "").trim().toLowerCase();
    const banner = el("dvBanner");
    if (!data.engine.available) {
      banner.hidden = false;
      banner.innerHTML = `<strong>Device pairing isn't switched on for this mirror yet.</strong><span>${esc(data.engine.reason)} Philips Hue still works on its own, and you can link an existing Home Assistant.</span><button class="ghost-button" type="button" data-advanced>Hue Bridge or Home Assistant</button>`;
    } else if (data.own) {
      banner.hidden = false;
      banner.innerHTML = `<strong>The mirror is using your own ${data.own === "hue" ? "Hue Bridge" : "Home Assistant"}.</strong><span>Disconnect it to add devices here instead.</span><button class="ghost-button" type="button" data-disconnect>Disconnect</button>`;
    } else banner.hidden = true;
    const total = (data.entries || []).length;
    el("dvStatus").textContent = data.engine.available ? (total ? `${total} brand${total === 1 ? "" : "s"} connected` : "Add to your home") : "Pairing unavailable";

    const found = el("dvFound"), spotted = data.found || [];
    found.hidden = !spotted.length;
    found.innerHTML = spotted.length ? `<p class="eyebrow">Found on your Wi-Fi</p><div class="dv-found-row">${spotted.map((f) => `<button class="dv-chip" type="button" data-found="${esc(f.flowId)}"><i></i>${esc(f.name)}<b>Add</b></button>`).join("")}</div>` : "";

    const brands = data.catalog.brands.filter((b) => !q || `${b.name} ${b.category} ${b.blurb}`.toLowerCase().includes(q));
    el("dvCatalog").innerHTML = data.catalog.categories.map((cat) => {
      const list = brands.filter((b) => b.category === cat);
      if (!list.length) return "";
      return `<section class="dv-group"><h2>${esc(cat)}</h2><div class="dv-grid">${list.map((b) => {
        const on = connectedTo(b).length, seen = foundFor(b).length;
        const note = on ? `${on === 1 ? "Connected" : `${on} connected`}` : seen ? "Found on your Wi-Fi" : b.blurb;
        return `<button class="dv-card${on ? " is-on" : ""}${seen && !on ? " is-found" : ""}" type="button" data-brand="${esc(b.id)}"><span class="dv-mark">${esc(mark(b.name))}</span><strong>${esc(b.name)}</strong><span>${esc(note)}</span></button>`;
      }).join("")}</div></section>`;
    }).join("") || `<p class="dv-empty">No brands match “${esc(q)}”.</p>`;
  }

  // ---------- The setup card ----------
  const dialog = () => el("dvDialog");
  function open(brand) {
    D.brand = brand;
    el("dvEyebrow").textContent = brand?.name || "Smart Devices";
    el("dvError").textContent = "";
    if (!dialog().open) dialog().showModal();
  }
  function show({ title, body, buttons }) {
    el("dvTitle").textContent = title;
    el("dvBody").innerHTML = body;
    el("dvFooter").innerHTML = buttons;
  }
  function busy(text) {
    show({ title: el("dvTitle").textContent || "Connecting", body: `<div class="dv-wait"><span class="dv-spinner"></span><p>${esc(text)}</p></div>`, buttons: `<button class="ghost-button" type="button" data-close>Cancel</button>` });
  }
  function close() {
    clearTimeout(D.poll);
    if (D.flow && !D.flow.done) request(`/api/devices/flow/${encodeURIComponent(D.flow.flowId)}`, { method: "DELETE" }).catch(() => {});
    D.flow = null;
    if (dialog().open) dialog().close();
  }

  function qr(text) {
    try {
      const code = qrcode(0, "M"); code.addData(text); code.make();
      return `<div class="dv-qr">${code.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>`;
    } catch { return ""; }
  }

  function fieldHtml(f, errors) {
    const id = `dv-f-${f.name}`, err = errors?.[f.name] ? `<em>${esc(errors[f.name])}</em>` : "";
    const help = f.help ? `<small>${esc(f.help)}</small>` : "";
    if (f.type === "boolean") return `<label class="dv-check"><input type="checkbox" name="${esc(f.name)}" ${f.default ? "checked" : ""}><span>${esc(f.label)}</span>${help}${err}</label>`;
    if (f.type === "constant") return `<p class="dv-text">${esc(f.label)}: ${esc(f.default)}</p>`;
    if (f.type === "select") return `<label><span>${esc(f.label)}</span><select id="${id}" name="${esc(f.name)}">${(f.options || []).map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(f.default) ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${help}${err}</label>`;
    const type = f.type === "password" ? "password" : f.type === "number" ? "number" : "text";
    return `<label><span>${esc(f.label)}${f.required ? "" : " (optional)"}</span><input id="${id}" name="${esc(f.name)}" type="${type}" ${f.required ? "required" : ""} ${f.default != null && f.type !== "password" ? `value="${esc(f.default)}"` : ""} ${f.min != null ? `min="${f.min}"` : ""} ${f.max != null ? `max="${f.max}"` : ""} autocomplete="off">${help}${err}</label>`;
  }

  function showStep(step) {
    D.flow = step;
    clearTimeout(D.poll);
    el("dvError").textContent = "";
    const name = D.brand?.name || "your device";
    if (step.type === "form") {
      const fields = step.fields || [];
      const text = step.text ? `<p class="dv-text">${esc(step.text)}</p>` : "";
      const base = step.errors?.base ? `<p class="dv-alert">${esc(step.errors.base)}</p>` : "";
      show({
        title: step.title || (fields.length ? `Connect ${name}` : `Add ${name}?`),
        body: `${base}${text}${fields.map((f) => fieldHtml(f, step.errors)).join("")}`,
        buttons: `<button class="ghost-button" type="button" data-close>Cancel</button><button class="store-action" type="submit">${fields.length ? "Next" : "Add"}</button>`
      });
      setTimeout(() => el("dvBody").querySelector("input:not([type=checkbox]),select")?.focus(), 0);
    } else if (step.type === "menu") {
      show({ title: step.title || `Connect ${name}`, body: `${step.text ? `<p class="dv-text">${esc(step.text)}</p>` : ""}<div class="dv-menu">${(step.options || []).map((o) => `<button class="dv-option" type="button" data-menu="${esc(o.value)}">${esc(o.label)}</button>`).join("")}</div>`, buttons: `<button class="ghost-button" type="button" data-close>Cancel</button>` });
    } else if (["progress", "external", "external_done", "progress_done"].includes(step.type)) {
      const link = step.url ? `${qr(step.url)}<p class="dv-hint">Scan with your phone, or <a href="${esc(step.url)}" target="_blank" rel="noopener">open the link here</a>.</p>` : "";
      const code = step.code ? `<p class="dv-code">${esc(step.code)}</p>` : "";
      const text = step.url ? `Sign in to ${name} on your phone to finish.` : step.text;
      show({ title: `Connecting ${name}`, body: `<div class="dv-wait">${step.url ? "" : `<span class="dv-spinner"></span>`}<p>${esc(text)}</p>${link}${code}</div>`, buttons: `<button class="ghost-button" type="button" data-close>Cancel</button>` });
      D.poll = setTimeout(() => advance(), 2500);
    } else if (step.type === "create_entry") {
      step.done = true;
      show({ title: `${name} connected`, body: `<div class="dv-done"><span class="dv-tick"></span><p>Its devices are on the Smart Home screen, and you can ask ${esc(window.REFLECT_ASSISTANT_NAME || "Jarvis")} to control them. Put them in rooms so they show in the house.</p></div>`, buttons: `<button class="ghost-button" type="button" data-close>Later</button>${step.entryId ? `<button class="store-action" type="button" data-rooms="${esc(step.entryId)}">Put them in rooms</button>` : ""}` });
      load(); setTimeout(() => loadHomeAssistant?.(), 1500);
    } else {
      step.done = true;
      const already = step.reason === "already_configured" || step.reason === "already_in_progress";
      show({ title: already ? `${name} is already connected` : `Couldn't connect ${name}`, body: `<p class="dv-text">${esc(already ? "There's nothing more to do." : step.text || "Something went wrong.")}</p>`, buttons: `<button class="store-action" type="button" data-close>Close</button>` });
      load();
    }
  }

  async function advance(input) {
    const flowId = D.flow?.flowId;
    if (!flowId) return;
    try {
      const step = await request("/api/devices/flow", { method: "POST", body: JSON.stringify(input === undefined ? { flowId } : { flowId, input }) });
      if (D.flow?.flowId === flowId || step.flowId === flowId) showStep(step);
    } catch (error) {
      if (!dialog().open) return;
      if (input === undefined && D.flow) { D.poll = setTimeout(() => advance(), 4000); return; }
      el("dvError").textContent = error.message;
      showStep(D.flow);
      el("dvError").textContent = error.message;
    }
  }

  async function start(brand) {
    open(brand);
    if (brand.kind === "matter") return matter(brand);
    if (!D.data?.engine.available) {
      // Without the engine, Hue pairs straight with its bridge; everything else needs the engine.
      if (brand.id === "hue") { dialog().close(); el("haDialog")?.showModal(); return; }
      show({ title: `${brand.name} needs device pairing`, body: `<p class="dv-text">${esc(D.data?.engine.reason || "")} Once it's switched on, ${esc(brand.name)} connects from here.</p>`, buttons: `<button class="store-action" type="button" data-close>OK</button>` });
      return;
    }
    const connected = connectedTo(brand);
    if (connected.length) {
      show({
        title: brand.name,
        body: `<ul class="dv-list">${connected.map((e) => `<li><span>${esc(e.title)}</span><button class="ghost-button" type="button" data-remove="${esc(e.id)}">Remove</button></li>`).join("")}</ul>`,
        buttons: `<button class="ghost-button" type="button" data-rooms="${esc(connected[0].id)}">Rooms</button><button class="ghost-button" type="button" data-close>Close</button><button class="store-action" type="button" data-again>Add another</button>`
      });
      return;
    }
    const seen = foundFor(brand)[0];
    if (seen) return resume(seen.flowId, brand);
    begin(brand);
  }
  async function begin(brand) {
    show({ title: `Connect ${brand.name}`, body: "", buttons: "" });
    busy(`Getting ${brand.name} ready…`);
    try { showStep(await request("/api/devices/flow", { method: "POST", body: JSON.stringify({ brand: brand.id }) })); }
    catch (error) { show({ title: `Couldn't connect ${brand.name}`, body: `<p class="dv-text">${esc(error.message)}</p>`, buttons: `<button class="store-action" type="button" data-close>Close</button>` }); }
  }
  async function resume(flowId, brand) {
    open(brand || { name: "your device" });
    busy("Opening…");
    D.flow = { flowId };
    try { showStep(await request("/api/devices/flow", { method: "POST", body: JSON.stringify({ flowId }) })); }
    catch (error) { show({ title: "That device is gone", body: `<p class="dv-text">${esc(error.message)}</p>`, buttons: `<button class="store-action" type="button" data-close>Close</button>` }); load(); }
  }

  // ---------- Rooms: which room each new device is in ----------
  async function roomsStep(entryId) {
    busy("Finding your devices…");
    try {
      const [data, layout] = await Promise.all([
        request(`/api/devices/rooms?entry=${encodeURIComponent(entryId)}`),
        request("/api/house-layout").catch(() => ({}))
      ]);
      const names = [...new Set([...(layout.layout?.rooms || []).map((r) => r.label).filter(Boolean), ...data.rooms.map((r) => r.name)])];
      const roomName = (id) => data.rooms.find((r) => r.id === id)?.name || "";
      show({
        title: "Which room is each one in?",
        body: data.devices.length ? `<datalist id="dvRoomNames">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist><div class="dv-rooms">${data.devices.map((d) => `<label><span>${esc(d.name)}</span><input list="dvRoomNames" data-device="${esc(d.id)}" value="${esc(roomName(d.room))}" placeholder="Pick or type a room" autocomplete="off"></label>`).join("")}</div>` : `<p class="dv-text">No devices to place yet. They'll appear once they've been found.</p>`,
        buttons: `<button class="store-action" type="button" data-close>Done</button>`
      });
      el("dvBody").querySelectorAll("[data-device]").forEach((input) => input.addEventListener("change", async () => {
        input.disabled = true;
        try { await request("/api/devices/rooms", { method: "POST", body: JSON.stringify({ deviceId: input.dataset.device, room: input.value }) }); input.classList.add("is-saved"); setTimeout(() => loadHomeAssistant?.(), 800); }
        catch (error) { el("dvError").textContent = error.message; }
        input.disabled = false;
      }));
    } catch (error) { show({ title: "Rooms", body: `<p class="dv-text">${esc(error.message)}</p>`, buttons: `<button class="store-action" type="button" data-close>Close</button>` }); }
  }

  // ---------- Matter: type or scan the code from the device ----------
  function matter(brand) {
    D.flow = null;
    const canScan = "BarcodeDetector" in window && navigator.mediaDevices?.getUserMedia;
    show({
      title: "Add a Matter device",
      body: `<p class="dv-text">Plug the device in, then scan the QR code on it or its box, or type the 11-digit code printed under it. If the device already works with another app, use that app's "share" or "add to another hub" option to get a fresh code.</p>
        ${canScan ? `<div class="dv-camera" hidden><video playsinline muted></video></div><button class="ghost-button" type="button" data-scan>Scan the QR code</button>` : ""}
        <label><span>Setup code</span><input name="matterCode" inputmode="numeric" placeholder="1234-567-8901" autocomplete="off" required></label>`,
      buttons: `<button class="ghost-button" type="button" data-close>Cancel</button><button class="store-action" type="submit">Add</button>`
    });
    D.matter = true;
    D.brand = brand;
  }
  async function scan() {
    const box = el("dvBody").querySelector(".dv-camera"), video = box?.querySelector("video");
    if (!video) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      box.hidden = false; video.srcObject = stream; await video.play();
      const detector = new BarcodeDetector({ formats: ["qr_code"] });
      const stop = () => stream.getTracks().forEach((t) => t.stop());
      const look = async () => {
        if (!dialog().open || !video.isConnected) return stop();
        const codes = await detector.detect(video).catch(() => []);
        const hit = codes.find((c) => /^MT:/i.test(c.rawValue));
        if (hit) { stop(); box.hidden = true; el("dvBody").querySelector("[name=matterCode]").value = hit.rawValue; return addMatter(hit.rawValue); }
        requestAnimationFrame(look);
      };
      look();
    } catch { el("dvError").textContent = "The camera isn't available. Type the code instead."; }
  }
  async function addMatter(code) {
    busy("Adding the device. This can take a minute…");
    try {
      await request("/api/devices/matter", { method: "POST", body: JSON.stringify({ code }) });
      D.matter = false;
      showStep({ type: "create_entry", flowId: "" });
    } catch (error) { matter(D.brand); el("dvError").textContent = error.message; }
  }

  // ---------- Wiring ----------
  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-brand],[data-found],[data-close],[data-menu],[data-remove],[data-again],[data-scan],[data-advanced],[data-disconnect],[data-rooms]");
    if (!t) return;
    if (t.dataset.brand) { const b = D.data?.catalog.brands.find((x) => x.id === t.dataset.brand); if (b) start(b); }
    else if (t.dataset.found) { const f = D.data?.found.find((x) => x.flowId === t.dataset.found); resume(t.dataset.found, D.data?.catalog.brands.find((b) => b.domain === f?.domain) || { name: f?.name || "your device" }); }
    else if ("close" in t.dataset) close();
    else if (t.dataset.menu) { busy("One moment…"); advance({ next_step_id: t.dataset.menu }); }
    else if (t.dataset.remove) {
      t.disabled = true;
      request("/api/devices/remove", { method: "POST", body: JSON.stringify({ entryId: t.dataset.remove }) })
        .then(() => { close(); load(); setTimeout(() => loadHomeAssistant?.(), 1000); })
        .catch((error) => { el("dvError").textContent = error.message; t.disabled = false; });
    } else if ("again" in t.dataset) begin(D.brand);
    else if ("rooms" in t.dataset) roomsStep(t.dataset.rooms);
    else if ("scan" in t.dataset) scan();
    else if ("advanced" in t.dataset) el("haDialog")?.showModal();
    else if ("disconnect" in t.dataset) Promise.resolve(disconnectAddOn("smartHome")).then(() => load());
  });
  el("dvForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (D.matter) { const code = el("dvBody").querySelector("[name=matterCode]")?.value || ""; return addMatter(code); }
    if (!D.flow || D.flow.type !== "form") return;
    const input = {};
    for (const f of D.flow.fields || []) {
      const node = event.currentTarget.elements[f.name];
      if (!node) continue;
      if (f.type === "boolean") input[f.name] = node.checked;
      else if (f.type === "number") { if (node.value !== "") input[f.name] = Number(node.value); }
      else if (f.type === "constant") continue;
      else if (node.value !== "" || f.required) input[f.name] = node.value;
    }
    busy("Connecting…");
    advance(input);
  });
  dialog()?.addEventListener("close", () => { clearTimeout(D.poll); D.matter = false; });
  dialog()?.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  el("dvSearch")?.addEventListener("input", render);

  // Load when the Devices screen opens, and keep the "found on your Wi-Fi" list fresh while it's showing.
  const view = el("view-devices");
  if (view) new MutationObserver(() => { if (view.classList.contains("is-active")) load(); }).observe(view, { attributes: true, attributeFilter: ["class"] });
  setInterval(() => { if (view?.classList.contains("is-active") && !dialog()?.open) load(); }, 15000);

  window.ReflectDevices = { load, open: () => (typeof showView === "function" ? showView("devices") : null) };
})();
