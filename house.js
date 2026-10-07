// Holographic house for the Smart Home screen.
// Rooms from Home Assistant become rooms in a 3D wireframe house (three per floor, under a gable roof),
// drawn on a canvas as a Jarvis-style hologram over a projector base. Lit rooms glow in their lights' real
// colours. Tap a light to toggle it, tap a room to switch all its lights, drag to turn the house.
(() => {
  const FH = 3, D = 6.4, RW = 4.4, ROOF = 3.6, OVER = 0.45;
  // Living spaces go downstairs and bedrooms, bathrooms and studies upstairs, like a real house.
  const UP = /bed|bath|ensuite|en-suite|nursery|office|study|landing|loft|attic|guest|dressing|kids|child/i;
  let wrap = null, canvas = null, ctx = null, model = null, key = "", raf = 0;
  let born = 0, yawDrag = 0, drag = null, ripples = [], particles = [], hover = null, lastFrame = 0;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const rooms = () => {
    const map = new Map();
    homeAssistantEntities.filter((e) => e.areaId).forEach((e) => {
      if (!map.has(e.areaId)) map.set(e.areaId, { id: e.areaId, name: e.area, items: [] });
      map.get(e.areaId).items.push(e);
    });
    return [...map.values()].sort((a, b) => UP.test(a.name) - UP.test(b.name) || a.name.localeCompare(b.name));
  };
  const level = (e) => entityIsOn(e) ? (e.brightness != null ? Math.max(0.3, e.brightness / 255) : 1) : 0;
  const glowRgb = (e) => {
    if (e.rgb) return e.rgb;
    if (e.colorTemp) return e.colorTemp < 3200 ? [255, 186, 110] : e.colorTemp > 5000 ? [205, 228, 255] : [255, 226, 186];
    return [255, 214, 150];
  };
  const accent = () => (getComputedStyle(document.body).getPropertyValue("--accent-rgb") || "86, 216, 255").trim();
  const badge = (e) => e.domain === "climate" ? `${e.temperature != null ? Math.round(e.temperature) : "–"}°` : e.domain === "lock" ? (String(e.state).toLowerCase() === "locked" ? "LOCKED" : "UNLOCKED") : "";

  // ---------- Model ----------
  function build(list) {
    const n = list.length, cols = Math.min(3, n), floors = Math.ceil(n / cols), W = cols * RW, top = floors * FH;
    const edges = [], windows = [], roomsGeo = [];
    const E = (a, b, kind = "wall") => edges.push({ a, b, kind });
    const box = (x0, x1, y0, y1, z0, z1, kind) => {
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([i, j]) => E(c[i], c[j], kind));
    };
    box(-W / 2, W / 2, 0, top, -D / 2, D / 2, "shell");
    for (let f = 1; f < floors; f++) box(-W / 2, W / 2, f * FH, f * FH, -D / 2, D / 2, "slab");
    list.forEach((r, i) => {
      const f = Math.floor(i / cols), c = i % cols, inRow = Math.min(cols, n - f * cols), w = W / inRow;
      const x0 = -W / 2 + c * w, x1 = x0 + w, y0 = f * FH, y1 = y0 + FH;
      if (c > 0) { E([x0, y0, -D / 2], [x0, y1, -D / 2], "part"); E([x0, y0, D / 2], [x0, y1, D / 2], "part"); E([x0, y0, -D / 2], [x0, y0, D / 2], "part"); E([x0, y1, -D / 2], [x0, y1, D / 2], "part"); }
      const lights = r.items.filter((e) => e.domain === "light");
      const spots = lights.map((e, j) => ({ e, p: [x0 + w * (j + 1) / (lights.length + 1), y0 + FH * 0.62, D * 0.12 + (lights.length > 2 ? (j % 2 ? -1 : 1) * D * 0.14 : 0)] }));
      const hasDoor = f === 0 && x0 <= 0 && x1 > 0;
      const winW = Math.min(1.5, w * 0.34), wx = hasDoor ? x0 + w * 0.24 : (x0 + x1) / 2;
      windows.push([[wx - winW / 2, y0 + 1.1, D / 2], [wx + winW / 2, y0 + 1.1, D / 2], [wx + winW / 2, y0 + 2.2, D / 2], [wx - winW / 2, y0 + 2.2, D / 2]]);
      windows.push([[wx - winW / 2, y0 + 1.1, -D / 2], [wx + winW / 2, y0 + 1.1, -D / 2], [wx + winW / 2, y0 + 2.2, -D / 2], [wx - winW / 2, y0 + 2.2, -D / 2]]);
      if (hasDoor) { const dx = Math.min(x1 - 0.8, Math.max(x0 + w * 0.55, 0)); windows.push([[dx - 0.5, 0, D / 2], [dx + 0.5, 0, D / 2], [dx + 0.5, 2.15, D / 2], [dx - 0.5, 2.15, D / 2]]); }
      roomsGeo.push({ room: r, x0, x1, y0, y1, spots, floor: f });
    });
    // Gable roof running along the width, with overhanging eaves and a chimney.
    const ry = top + ROOF, ex = W / 2 + OVER, ez = D / 2 + OVER, ey = top - 0.25;
    E([-ex, ry, 0], [ex, ry, 0], "roof");
    [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([sx, sz]) => { E([sx * ex, ey, sz * ez], [sx * ex, ry, 0], "roof"); });
    E([-ex, ey, ez], [ex, ey, ez], "roof"); E([-ex, ey, -ez], [ex, ey, -ez], "roof");
    for (let k = 1; k < 8; k++) { const x = -ex + (2 * ex) * k / 8; E([x, ey, ez], [x, ry, 0], "rafter"); E([x, ey, -ez], [x, ry, 0], "rafter"); }
    const cx = W * 0.26, cz = -D * 0.16, cb = top + ROOF * (1 - Math.abs(cz) / ez) - 0.1;
    box(cx - 0.35, cx + 0.35, cb - 0.6, cb + 1.2, cz - 0.35, cz + 0.35, "roof");
    return { edges, windows, rooms: roomsGeo, W, top, height: ry + 1.2, floors };
  }

  // ---------- Projection ----------
  let view = null;
  function camera(t) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const yaw = (reduced ? -0.5 : -0.5 + Math.sin(t / 5200) * 0.42) + yawDrag;
    const pitch = 0.27, dist = Math.max(model.W, model.height, D) * 2.6;
    const fit = Math.min(w / (Math.hypot(model.W, D) * 1.02 + 2), h / (model.height * 1.25 + 2));
    view = { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch), w, h, scale: fit * dist, dist, mid: model.height * 0.48 };
  }
  function P([x, y, z]) {
    const v = view, X = x * v.cy - z * v.sy, Z0 = x * v.sy + z * v.cy, Y0 = y - v.mid;
    const Y = Y0 * v.cp - Z0 * v.sp, Z = Y0 * v.sp + Z0 * v.cp;
    const k = v.scale / (v.dist + Z);
    return { x: v.w / 2 + X * k, y: v.h * 0.5 - Y * k, z: Z, k };
  }

  // ---------- Drawing ----------
  function line(a, b, rgb, alpha, width) {
    ctx.strokeStyle = `rgba(${rgb},${alpha * 0.22})`; ctx.lineWidth = width * 4;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    ctx.strokeStyle = `rgba(${rgb},${alpha})`; ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // Clip a 3D segment to everything below the build height during the power-up.
  function clipY(a, b, maxY) {
    if (a[1] <= maxY && b[1] <= maxY) return [a, b];
    if (a[1] > maxY && b[1] > maxY) return null;
    const [lo, hi] = a[1] <= b[1] ? [a, b] : [b, a], t = (maxY - lo[1]) / (hi[1] - lo[1]);
    return [lo, [lo[0] + (hi[0] - lo[0]) * t, maxY, lo[2] + (hi[2] - lo[2]) * t]];
  }
  const fade = (p) => Math.max(0.25, Math.min(1, 1 - (p.z + view.dist * 0.1) / (view.dist * 0.9)));

  // Outline of a room's box on screen (convex hull of its 8 corners), used to keep its light inside its walls.
  function hullPath(g) {
    const pts = [];
    [g.x0, g.x1].forEach((x) => [g.y0, g.y1].forEach((y) => [-D / 2, D / 2].forEach((z) => pts.push(P([x, y, z])))));
    pts.sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x), lo = [], hi = [];
    pts.forEach((p) => { while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); });
    [...pts].reverse().forEach((p) => { while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop(); hi.push(p); });
    const hull = lo.slice(0, -1).concat(hi.slice(0, -1));
    ctx.beginPath(); hull.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath();
  }
  function quad(pts, fill) { ctx.fillStyle = fill; ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)); ctx.closePath(); ctx.fill(); }

  function frame(t) {
    raf = 0;
    if (!canvas?.isConnected || !document.getElementById("view-homekit")?.classList.contains("is-active") || document.hidden) return;
    raf = requestAnimationFrame(frame);
    if (t - lastFrame < 30) return; // ~30fps keeps the Pi cool
    lastFrame = t;
    const dpr = Math.min(2, window.devicePixelRatio || 1), cw = canvas.clientWidth, ch = canvas.clientHeight;
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) { canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    camera(t);
    const acc = accent(), age = reduced ? 1e9 : t - born;
    const build = Math.min(1, Math.max(0, (age - 500) / 2300)), buildY = build >= 1 ? 1e9 : -0.2 + build * (model.height + 0.4);
    ctx.lineCap = "round"; ctx.lineJoin = "round";

    // Projector base: concentric rings that spin, with light rising into the house.
    const R = Math.max(model.W, D) * 0.78, baseA = Math.min(1, age / 500);
    [1, 0.82, 0.6, 1.12].forEach((r, i) => {
      ctx.setLineDash(i === 3 ? [2, 10] : i === 1 ? [18, 8, 4, 8] : []); ctx.lineDashOffset = (i % 2 ? -1 : 1) * t / (40 + i * 25);
      ctx.strokeStyle = `rgba(${acc},${(i === 0 ? 0.55 : 0.28) * baseA})`; ctx.lineWidth = i === 0 ? 2 : 1;
      ctx.beginPath();
      for (let s = 0; s <= 72; s++) { const a = s / 72 * Math.PI * 2, p = P([Math.cos(a) * R * r, -0.25, Math.sin(a) * R * r]); s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
      ctx.stroke();
    });
    ctx.setLineDash([]);
    const c0 = P([0, -0.25, 0]), rr = P([R, -0.25, 0]);
    const g0 = ctx.createRadialGradient(c0.x, c0.y, 0, c0.x, c0.y, Math.abs(rr.x - c0.x) * 1.2);
    g0.addColorStop(0, `rgba(${acc},${0.22 * baseA})`); g0.addColorStop(1, `rgba(${acc},0)`);
    ctx.save(); ctx.translate(c0.x, c0.y); ctx.scale(1, 0.38); ctx.translate(-c0.x, -c0.y); ctx.fillStyle = g0; ctx.beginPath(); ctx.arc(c0.x, c0.y, Math.abs(rr.x - c0.x) * 1.2, 0, Math.PI * 2); ctx.fill(); ctx.restore();

    // Rising particles from the projector.
    if (!reduced && particles.length < 40 && Math.random() < 0.5) { const a = Math.random() * Math.PI * 2, r = Math.random() * R; particles.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, y: -0.2, v: 0.02 + Math.random() * 0.04, life: 1 }); }
    particles = particles.filter((p) => (p.y += p.v, p.life -= 0.008, p.life > 0 && p.y < model.height));
    particles.forEach((p) => { const s = P([p.x, p.y, p.z]); ctx.fillStyle = `rgba(${acc},${p.life * 0.6})`; ctx.fillRect(s.x - 1, s.y - 1, 2, 2); });

    // Room light: each lit room fills with its lights' colours, cast from the ceiling.
    ctx.globalCompositeOperation = "lighter";
    model.rooms.forEach((g) => {
      const on = g.spots.filter((s) => level(s.e) > 0);
      if (!on.length || buildY < g.y1) return;
      const flick = build < 1 ? Math.min(1, (buildY - g.y1) / 0.8) : 1;
      ctx.save(); hullPath(g); ctx.clip();
      on.forEach((s) => {
        const rgb = glowRgb(s.e).join(","), lv = level(s.e) * flick, breathe = reduced ? 1 : 0.9 + Math.sin(t / 900 + s.p[0]) * 0.1;
        quad([[g.x0, g.y0, -D / 2], [g.x1, g.y0, -D / 2], [g.x1, g.y0, D / 2], [g.x0, g.y0, D / 2]].map(P), `rgba(${rgb},${0.22 * lv / on.length})`);
        quad([[g.x0, g.y0, -D / 2], [g.x1, g.y0, -D / 2], [g.x1, g.y1, -D / 2], [g.x0, g.y1, -D / 2]].map(P), `rgba(${rgb},${0.15 * lv / on.length})`);
        const c = P(s.p), floor = P([s.p[0], g.y0, s.p[2]]), rad = Math.abs(P([s.p[0] + (g.x1 - g.x0) * 0.6, s.p[1], s.p[2]]).x - c.x) + 20;
        const gr = ctx.createRadialGradient(c.x, c.y, 0, c.x, (c.y + floor.y) / 2, rad);
        gr.addColorStop(0, `rgba(${rgb},${0.55 * lv * breathe})`); gr.addColorStop(0.35, `rgba(${rgb},${0.18 * lv * breathe})`); gr.addColorStop(1, `rgba(${rgb},0)`);
        ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(c.x, (c.y + floor.y) / 2, rad, 0, Math.PI * 2); ctx.fill();
      });
      ctx.restore();
    });
    if (hover && hover.room && build >= 1) { hullPath(hover); ctx.fillStyle = `rgba(${acc},0.08)`; ctx.fill(); }
    ctx.globalCompositeOperation = "source-over";

    // Wireframe.
    const style = { shell: [0.95, 1.6], slab: [0.6, 1.1], part: [0.55, 1], roof: [0.9, 1.5], rafter: [0.22, 0.8] };
    model.edges.forEach(({ a, b, kind }) => {
      const seg = clipY(a, b, buildY); if (!seg) return;
      const pa = P(seg[0]), pb = P(seg[1]), [al, wd] = style[kind];
      line(pa, pb, acc, al * (fade(pa) + fade(pb)) / 2, wd);
    });
    model.windows.forEach((w) => {
      if (w[2][1] > buildY) return;
      const p = w.map(P); quad(p, `rgba(${acc},0.06)`);
      ctx.strokeStyle = `rgba(${acc},${0.5 * fade(p[0])})`; ctx.lineWidth = 1; ctx.beginPath(); p.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); ctx.stroke();
    });

    // Build-up scan plane, then a slow sweep once the house is up.
    const scanY = build < 1 ? buildY : (reduced ? -1 : ((t / 70) % (model.top * 10 + 40)) / 10);
    if (scanY >= 0 && scanY <= model.top) {
      const pts = [[-model.W / 2, scanY, -D / 2], [model.W / 2, scanY, -D / 2], [model.W / 2, scanY, D / 2], [-model.W / 2, scanY, D / 2]].map(P);
      quad(pts, `rgba(${acc},${build < 1 ? 0.16 : 0.06})`);
      ctx.strokeStyle = `rgba(${acc},${build < 1 ? 1 : 0.45})`; ctx.lineWidth = 1.5; ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath(); ctx.stroke();
    }

    // Lights and labels.
    ctx.textBaseline = "middle";
    model.rooms.forEach((g) => {
      if (buildY < g.y1) return;
      g.spots.forEach((s) => {
        const c = P(s.p), on = level(s.e) > 0, rgb = on ? glowRgb(s.e).join(",") : acc, r = 9;
        s.screen = c;
        ctx.strokeStyle = `rgba(${rgb},${on ? 0.95 : 0.5})`; ctx.lineWidth = 1.4;
        ctx.setLineDash(on ? [] : [3, 3]); ctx.beginPath(); ctx.arc(c.x, c.y, r + (hover === s ? 3 : 0), on ? t / 600 : 0, (on ? t / 600 : 0) + Math.PI * (on ? 1.6 : 2)); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = on ? `rgb(${rgb})` : "rgba(255,255,255,0.18)"; ctx.beginPath(); ctx.arc(c.x, c.y, 4, 0, Math.PI * 2); ctx.fill();
      });
      const lights = g.spots.length, lit = g.spots.filter((s) => level(s.e) > 0).length, extra = g.room.items.map(badge).filter(Boolean).join("  ");
      const anchor = P([(g.x0 + g.x1) / 2, g.y0 + 0.62, D / 2]);
      g.label = anchor;
      ctx.textAlign = "center";
      ctx.font = `500 ${Math.max(11, Math.min(17, anchor.k * 0.5))}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = hover === g ? "#fff" : "rgba(255,255,255,0.92)";
      ctx.fillText(spaced(g.room.name.toUpperCase()), anchor.x, anchor.y);
      ctx.font = `400 ${Math.max(9, Math.min(12, anchor.k * 0.36))}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = `rgba(${acc},0.85)`;
      ctx.fillText(spaced([lights ? `${lit}/${lights} ON` : "", extra].filter(Boolean).join(" · ")), anchor.x, anchor.y + 16);
    });

    // Tap ripples.
    ripples = ripples.filter((r) => t - r.at < 900);
    ripples.forEach((r) => { const k = (t - r.at) / 900; ctx.strokeStyle = `rgba(${r.rgb},${1 - k})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(r.x, r.y, 10 + k * 46, 0, Math.PI * 2); ctx.stroke(); });

    // HUD readout.
    const all = model.rooms.flatMap((g) => g.spots), litAll = all.filter((s) => level(s.e) > 0).length;
    ctx.textAlign = "left"; ctx.font = "500 12px Inter, system-ui, sans-serif"; ctx.fillStyle = `rgba(${acc},0.75)`;
    ctx.fillText(spaced(`HOME · ${model.rooms.length} ROOMS · ${model.floors} FLOOR${model.floors > 1 ? "S" : ""}`), 8, ch - 14);
    ctx.textAlign = "right"; ctx.fillText(spaced(`${litAll}/${all.length} LIGHTS ON`), cw - 8, ch - 14);
    if (build < 1) { ctx.textAlign = "left"; ctx.fillStyle = `rgba(${acc},0.9)`; ctx.fillText(spaced(`RENDERING STRUCTURE ${Math.round(build * 100)}%`), 8, 16); }
  }
  const spaced = (s) => s.split("").join(String.fromCharCode(8202));

  // ---------- Input ----------
  function pick(x, y) {
    let best = null, bd = 26;
    model.rooms.forEach((g) => g.spots.forEach((s) => { if (!s.screen) return; const d = Math.hypot(s.screen.x - x, s.screen.y - y); if (d < bd) { bd = d; best = s; } }));
    if (best) return best;
    // Otherwise the room whose front wall is under the pointer.
    for (const g of model.rooms) {
      const pts = [[g.x0, g.y0, D / 2], [g.x1, g.y0, D / 2], [g.x1, g.y1, D / 2], [g.x0, g.y1, D / 2]].map(P);
      ctx.beginPath(); pts.forEach((q, i) => i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)); ctx.closePath();
      const dpr = canvas.width / canvas.clientWidth;
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      const hit = ctx.isPointInPath(x * dpr, y * dpr); ctx.restore();
      if (hit) return g;
    }
    return null;
  }
  const local = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  function attach() {
    canvas.addEventListener("pointerdown", (ev) => { drag = { x: ev.clientX, yaw: yawDrag, moved: false }; canvas.setPointerCapture(ev.pointerId); });
    canvas.addEventListener("pointermove", (ev) => {
      if (drag) { const dx = ev.clientX - drag.x; if (Math.abs(dx) > 6) drag.moved = true; if (drag.moved) yawDrag = drag.yaw + dx / 220; return; }
      const [x, y] = local(ev); hover = view ? pick(x, y) : null; canvas.style.cursor = hover ? "pointer" : "grab";
    });
    canvas.addEventListener("pointerup", (ev) => {
      const was = drag; drag = null; if (!was || was.moved || !view) return;
      const [x, y] = local(ev), hit = pick(x, y); if (!hit) return;
      const now = performance.now();
      if (hit.e) { ripples.push({ x: hit.screen.x, y: hit.screen.y, at: now, rgb: entityIsOn(hit.e) ? accent() : glowRgb(hit.e).join(",") }); toggleEntity(hit.e.id); return; }
      if (!hit.spots.length) return;
      hit.spots.forEach((s) => s.screen && ripples.push({ x: s.screen.x, y: s.screen.y, at: now, rgb: accent() }));
      callHomeAssistant(hit.spots.some((s) => entityIsOn(s.e)) ? "light.turn_off" : "light.turn_on", { area_id: hit.room.id });
    });
    canvas.addEventListener("pointerleave", () => { hover = null; });
  }

  function start() { if (!raf && canvas) raf = requestAnimationFrame(frame); }

  window.renderHouse = function renderHouse() {
    wrap = document.getElementById("homekitHouse"); if (!wrap) return;
    const list = rooms();
    if (!list.length) { wrap.innerHTML = homeAssistantEntities.length ? `<p class="ha-help">Put your devices into rooms (areas) in Home Assistant to see your house here.</p>` : ""; canvas = null; key = ""; return; }
    const next = list.map((r) => `${r.id}:${r.items.map((e) => e.id).join(",")}`).join("|");
    if (!canvas || !canvas.isConnected) {
      wrap.innerHTML = `<canvas class="ha-house" role="img" aria-label="Your house. Tap a light to switch it, tap a room to switch all its lights, drag to turn the house."></canvas>`;
      canvas = wrap.querySelector("canvas"); ctx = canvas.getContext("2d"); attach(); key = ""; born = performance.now();
    }
    // Keep the existing model (and the same entities' live state) unless rooms or devices changed.
    if (next !== key) { const fresh = !model || !key; model = build(list); key = next; if (fresh) born = performance.now(); }
    else model.rooms.forEach((g, i) => { g.room = list[i]; g.spots.forEach((s) => { s.e = list[i].items.find((e) => e.id === s.e.id) || s.e; }); });
    start();
  };
  // The house powers up again each time the Smart Home screen opens.
  window.replayHouse = function replayHouse() { if (!canvas) return; born = performance.now(); particles = []; start(); };
  document.addEventListener("visibilitychange", start);
})();
