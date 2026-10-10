// <HouseBuilder /> lets anyone make the 3D house look like their own home: pick a starting house type, set
// how many floors there are, add rooms, drag them into place and resize them on a floor plan, and name each
// room like its Home Assistant area so the devices land in the right place. Rooms can take any shape (pull
// a "+" on an edge to add a corner), and stairs are a piece of their own to drag, turn and flip.
import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GRID, MAX_FLOORS, MAX_POINTS, MAX_ROOMS, MAX_STAIRS, ROOM_TYPES, TEMPLATES, bboxOf, cleanLayout, floorName, insidePoint, newKey, pointIn, roomPoly, roomsOverlap, typeOf } from "../houseLayout.js";
import { norm } from "../houseMap.js";

const snap = (v) => Math.round(v / GRID) * GRID;
const MIN = 1;
const ST = "stairs:"; // selection prefix for stairs, so they never clash with a room key
const overlaps = (a, b) => a !== b && a.floor === b.floor && !typeOf(a.type).outdoor === !typeOf(b.type).outdoor && roomsOverlap(a, b);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const pts = (poly) => poly.map((p) => p.join(",")).join(" ");
const shift = (v, by) => [v[0] + by, v[1] + by];
// Middle of a shape by area, so an L-shaped room's name sits in the L rather than on its inside corner.
const centroid = (poly) => {
  let a = 0, cx = 0, cz = 0;
  poly.forEach(([x1, z1], i) => { const [x2, z2] = poly[(i + 1) % poly.length], f = x1 * z2 - x2 * z1; a += f; cx += (x1 + x2) * f; cz += (z1 + z2) * f; });
  return Math.abs(a) < 1e-6 ? poly[0] : [cx / (3 * a), cz / (3 * a)];
};
const UNIT = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const TURN = { n: "e", e: "s", s: "w", w: "n" }, FLIP = { n: "s", s: "n", e: "w", w: "e" };
// Resize a rectangle from one of its corners ("nw", "se"...), keeping at least MIN metres.
const corner = (d, dx, dz) => {
  const x = [...d.x], z = [...d.z];
  if (d.handle.includes("w")) x[0] = Math.min(d.x[0] + dx, d.x[1] - MIN);
  if (d.handle.includes("e")) x[1] = Math.max(d.x[1] + dx, d.x[0] + MIN);
  if (d.handle.includes("n")) z[0] = Math.min(d.z[0] + dz, d.z[1] - MIN);
  if (d.handle.includes("s")) z[1] = Math.max(d.z[1] + dz, d.z[0] + MIN);
  return { x, z };
};

// A flight of stairs on the plan: treads across it and an arrow pointing the way up.
function Stairs({ s, sel, ghost, fs, onDown }) {
  const w = s.x[1] - s.x[0], d = s.z[1] - s.z[0], alongZ = s.dir === "n" || s.dir === "s", len = alongZ ? d : w;
  const n = Math.max(4, Math.round(len / 0.28)), [ux, uz] = UNIT[s.dir], cx = s.x[0] + w / 2, cz = s.z[0] + d / 2;
  const half = len / 2 - 0.25, a = [cx - ux * half, cz - uz * half], b = [cx + ux * half, cz + uz * half];
  const head = [b, [b[0] - ux * 0.4 - uz * 0.22, b[1] - uz * 0.4 + ux * 0.22], [b[0] - ux * 0.4 + uz * 0.22, b[1] - uz * 0.4 - ux * 0.22]];
  const tf = Math.min(fs * 0.8, (alongZ ? w : d) * 0.4);
  return (
    <g className={`hb-stairs${sel ? " is-sel" : ""}${ghost ? " is-ghost" : ""}`}>
      <rect className="hb-st-body" x={s.x[0]} y={s.z[0]} width={w} height={d} onPointerDown={onDown ? (e) => onDown(e, "move") : undefined} />
      {Array.from({ length: n - 1 }, (_, i) => alongZ
        ? <line key={i} className="hb-step" x1={s.x[0]} x2={s.x[1]} y1={s.z[0] + ((i + 1) * d) / n} y2={s.z[0] + ((i + 1) * d) / n} />
        : <line key={i} className="hb-step" y1={s.z[0]} y2={s.z[1]} x1={s.x[0] + ((i + 1) * w) / n} x2={s.x[0] + ((i + 1) * w) / n} />)}
      <line className="hb-arrow" x1={a[0] + ux * tf * 1.2} y1={a[1] + uz * tf * 1.2} x2={b[0] - ux * 0.3} y2={b[1] - uz * 0.3} />
      <polygon className="hb-arrow-head" points={pts(head)} />
      {!ghost && <text className="hb-up" x={a[0]} y={a[1]} fontSize={tf}>UP</text>}
      {sel && onDown && ["nw", "ne", "sw", "se"].map((h) => (
        <circle key={h} cx={h.includes("w") ? s.x[0] : s.x[1]} cy={h.includes("n") ? s.z[0] : s.z[1]} r={Math.max(0.24, fs * 0.6)} className="hb-handle" onPointerDown={(e) => onDown(e, h)} />
      ))}
    </g>
  );
}

function Templates({ onPick, onClose }) {
  return (
    <motion.div className="hb-templates" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="hb-templates-box">
        <header><h3>Start from a house type</h3><button type="button" className="h3-close" onClick={onClose} aria-label="Close">✕</button></header>
        <p className="hb-hint">This replaces the rooms you have now. You can change everything afterwards.</p>
        <div className="hb-template-grid">
          {TEMPLATES.map((t) => (
            <button key={t.key} type="button" className="hb-template" onClick={() => onPick(t.layout)}>
              <MiniPlan layout={t.layout} /><strong>{t.label}</strong><small>{t.note}</small>
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

function MiniPlan({ layout }) {
  const rooms = layout.rooms.filter((r) => r.floor === 0);
  const x0 = Math.min(...rooms.map((r) => r.x[0])), x1 = Math.max(...rooms.map((r) => r.x[1])), z0 = Math.min(...rooms.map((r) => r.z[0])), z1 = Math.max(...rooms.map((r) => r.z[1]));
  return (
    <svg viewBox={`${x0 - 0.5} ${z0 - 0.5} ${x1 - x0 + 1} ${z1 - z0 + 1}`} className="hb-mini" aria-hidden="true">
      {rooms.map((r) => <polygon key={r.key} points={pts(roomPoly(r))} className={`hb-shape${typeOf(r.type).outdoor ? " is-out" : ""}`} />)}
    </svg>
  );
}

export function HouseBuilder({ layout, areas, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => structuredClone(cleanLayout(layout) || layout));
  const [floor, setFloor] = useState(0);
  const [selected, setSelected] = useState(null);
  const [templates, setTemplates] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const svg = useRef(), drag = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [vertex, setVertex] = useState(null); // the corner of an odd-shaped room last touched

  const rooms = draft.rooms, stairs = draft.stairs || [];
  const sel = rooms.find((r) => r.key === selected) || null;
  const selStairs = selected?.startsWith(ST) ? stairs.find((s) => ST + s.key === selected) || null : null;
  const update = (key, fn) => setDraft((d) => ({ ...d, rooms: d.rooms.map((r) => (r.key === key ? fn(r) : r)) }));
  const updateStairs = (key, fn) => setDraft((d) => ({ ...d, stairs: d.stairs.map((s) => (s.key === key ? fn(s) : s)) }));
  const pick = (key) => { setSelected(key); setConfirm(null); setVertex(null); };

  // The plan's viewport covers every floor, so rooms stay put when you switch floors.
  // (It stays still while a room is being dragged, then refits.)
  const lastView = useRef(null);
  const view = useMemo(() => {
    if (drag.current && lastView.current) return lastView.current;
    const xs = [...rooms, ...stairs].flatMap((r) => r.x), zs = [...rooms, ...stairs].flatMap((r) => r.z);
    const x0 = Math.min(-6, ...xs) - 2, x1 = Math.max(6, ...xs) + 2, z0 = Math.min(-6, ...zs) - 2, z1 = Math.max(6, ...zs) + 2.5;
    return (lastView.current = { x0, z0, w: x1 - x0, h: z1 - z0 });
  }, [rooms, stairs, dragging]); // eslint-disable-line react-hooks/exhaustive-deps
  const onFloor = rooms.filter((r) => (floor === 0 ? r.floor === 0 : r.floor === floor && !typeOf(r.type).outdoor));
  const below = floor > 0 ? rooms.filter((r) => r.floor === floor - 1 && !typeOf(r.type).outdoor) : [];
  const usedNames = new Set(rooms.map((r) => norm(r.label)));
  const clashes = useMemo(() => new Set(rooms.filter((r) => rooms.some((o) => overlaps(r, o))).map((r) => r.key)), [rooms]);

  const toPlan = (e) => {
    const p = svg.current.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.current.getScreenCTM().inverse()); return [q.x, q.y];
  };
  // handle: "move", a rectangle corner ("nw"...), a corner of an odd shape ("v2"), or a "+" on an edge ("e2"),
  // which adds a corner there and starts dragging it.
  const start = (e, item, handle, kind = "room") => {
    e.stopPropagation(); e.preventDefault();
    let points = item.points ? item.points.map((p) => [...p]) : null;
    if (handle.startsWith("e")) {
      const i = Number(handle.slice(1)), poly = roomPoly(item).map((p) => [...p]);
      if (poly.length >= MAX_POINTS) return;
      const [a, b] = [poly[i], poly[(i + 1) % poly.length]];
      poly.splice(i + 1, 0, [snap((a[0] + b[0]) / 2), snap((a[1] + b[1]) / 2)]);
      points = poly; handle = `v${i + 1}`;
      update(item.key, (r) => ({ ...r, points }));
    }
    pick(kind === "stairs" ? ST + item.key : item.key);
    if (handle.startsWith("v")) setVertex(Number(handle.slice(1)));
    // Stairs inside a room travel with it when the room is moved.
    const carry = kind === "room" && handle === "move"
      ? stairs.filter((s) => s.floor === item.floor && pointIn(roomPoly(item), (s.x[0] + s.x[1]) / 2, (s.z[0] + s.z[1]) / 2)).map((s) => ({ key: s.key, x: [...s.x], z: [...s.z] }))
      : [];
    svg.current.setPointerCapture(e.pointerId);
    drag.current = { kind, key: item.key, handle, from: toPlan(e), x: [...item.x], z: [...item.z], points, carry };
    setDragging(true);
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const [px, pz] = toPlan(e), dx = snap(px - d.from[0]), dz = snap(pz - d.from[1]);
    if (d.kind === "stairs") return updateStairs(d.key, (s) => (d.handle === "move" ? { ...s, x: shift(d.x, dx), z: shift(d.z, dz) } : { ...s, ...corner(d, dx, dz) }));
    const carried = new Map(d.carry.map((c) => [c.key, c]));
    setDraft((dr) => ({
      ...dr,
      stairs: carried.size ? dr.stairs.map((s) => (carried.has(s.key) ? { ...s, x: shift(carried.get(s.key).x, dx), z: shift(carried.get(s.key).z, dz) } : s)) : dr.stairs,
      rooms: dr.rooms.map((r) => {
        if (r.key !== d.key) return r;
        if (d.handle === "move") return { ...r, x: shift(d.x, dx), z: shift(d.z, dz), ...(d.points && { points: d.points.map(([x, z]) => [x + dx, z + dz]) }) };
        if (d.handle.startsWith("v")) {
          const i = Number(d.handle.slice(1)), points = d.points.map((p, j) => (j === i ? [p[0] + dx, p[1] + dz] : p));
          return { ...r, points, ...bboxOf(points) };
        }
        return { ...r, ...corner(d, dx, dz) };
      })
    }));
  };
  const end = () => { if (!drag.current) return; drag.current = null; setDragging(false); };

  const addRoom = (type) => {
    if (rooms.length >= MAX_ROOMS) return;
    const t = ROOM_TYPES[type], here = rooms.filter((r) => r.floor === (t.outdoor ? 0 : floor) && !typeOf(r.type).outdoor);
    const [w, d] = t.size;
    let x0, z0;
    if (t.outdoor) { const all = rooms.filter((r) => !typeOf(r.type).outdoor); x0 = all.length ? Math.min(...all.map((r) => r.x[0])) : -w / 2; z0 = (all.length ? Math.min(...all.map((r) => r.z[0])) : 0) - d - 0.5; }
    else if (here.length) { x0 = Math.max(...here.map((r) => r.x[1])) + 0.5; z0 = Math.min(...here.map((r) => r.z[0])); }
    else { const under = rooms.filter((r) => r.floor === floor - 1 && !typeOf(r.type).outdoor); x0 = under.length ? Math.min(...under.map((r) => r.x[0])) : -w / 2; z0 = under.length ? Math.min(...under.map((r) => r.z[0])) : -d / 2; }
    const room = { key: newKey(type, rooms), type, label: uniqueLabel(t.label, rooms), floor: t.outdoor ? 0 : floor, x: [snap(x0), snap(x0) + w], z: [snap(z0), snap(z0) + d] };
    setDraft((dr) => ({ ...dr, rooms: [...dr.rooms, room] }));
    setSelected(room.key);
  };
  const removeRoom = (key) => { setDraft((d) => ({ ...d, rooms: d.rooms.filter((r) => r.key !== key) })); pick(null); };
  const addFloor = () => { if (draft.floors >= MAX_FLOORS) return; setDraft((d) => ({ ...d, floors: d.floors + 1 })); setFloor(draft.floors); pick(null); };
  const removeFloor = () => {
    const top = draft.floors - 1;
    setDraft((d) => ({ ...d, floors: d.floors - 1, rooms: d.rooms.filter((r) => r.floor !== top), stairs: d.stairs.filter((s) => s.floor < top - 1) }));
    setFloor(Math.max(0, top - 1)); pick(null);
  };
  // Width/depth on an odd shape moves the corners on the far half, so an L stays an L.
  const resize = (key, axis, delta) => update(key, (r) => {
    const [lo, hi] = r[axis], by = Math.max(lo + MIN, hi + delta) - hi;
    if (!r.points) return { ...r, [axis]: [lo, hi + by] };
    const i = axis === "x" ? 0 : 1, mid = (lo + hi) / 2, points = r.points.map((p) => { const q = [...p]; if (q[i] > mid) q[i] += by; return q; });
    return { ...r, points, ...bboxOf(points) };
  });
  const removeCorner = (key, i) => { update(key, (r) => { const points = r.points.filter((_, j) => j !== i); return { ...r, points, ...bboxOf(points) }; }); setVertex(null); };
  const squareUp = (key) => { update(key, ({ points, ...r }) => r); setVertex(null); };

  const addStairs = () => {
    if (stairs.length >= MAX_STAIRS || floor >= draft.floors - 1) return;
    const here = rooms.filter((r) => r.floor === floor && !typeOf(r.type).outdoor), hall = here.find((r) => typeOf(r.type).stairs) || here[0];
    const [cx, cz] = hall ? insidePoint(roomPoly(hall), (hall.x[0] + hall.x[1]) / 2, (hall.z[0] + hall.z[1]) / 2) : [0, 0];
    const used = new Set(stairs.map((s) => s.key)); let n = 1; while (used.has(`stairs_${n}`)) n++;
    const x0 = snap(cx - 0.5), z0 = snap(cz - 1.5), st = { key: `stairs_${n}`, floor, x: [x0, x0 + 1], z: [z0, z0 + 3], dir: "n" };
    setDraft((d) => ({ ...d, stairs: [...(d.stairs || []), st] }));
    pick(ST + st.key);
  };
  const turnStairs = (s) => {
    const cx = (s.x[0] + s.x[1]) / 2, cz = (s.z[0] + s.z[1]) / 2, w = s.x[1] - s.x[0], d = s.z[1] - s.z[0], x0 = snap(cx - d / 2), z0 = snap(cz - w / 2);
    return { ...s, x: [x0, x0 + d], z: [z0, z0 + w], dir: TURN[s.dir] };
  };
  const removeStairs = (key) => { setDraft((d) => ({ ...d, stairs: d.stairs.filter((s) => s.key !== key) })); pick(null); };
  const save = () => { const clean = cleanLayout(draft); if (clean) onSave(clean); };

  const fs = Math.max(0.32, Math.min(0.5, view.w / 50));
  return (
    <motion.div className="hb" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.35 }}>
      <header className="hb-head">
        <div><p className="h3-eyebrow">House builder</p><h2>Make it your house</h2>
          <p className="hb-hint">Drag rooms into place and pull their corners to resize. For an odd shape, pull a + on a room's edge to add a corner. Name each room like it is in Home Assistant, and its devices appear there.</p></div>
        <div className="hb-head-actions">
          <button type="button" className="h3-pill" onClick={() => setTemplates(true)}>House types</button>
          <button type="button" className="h3-pill" onClick={onCancel}>Cancel</button>
          <button type="button" className="h3-pill hb-save" onClick={save}>Save house</button>
        </div>
      </header>

      <div className="hb-body">
        <nav className="hb-floors" aria-label="Floors">
          {Array.from({ length: draft.floors }, (_, i) => draft.floors - 1 - i).map((f) => (
            <button key={f} type="button" className={f === floor ? "is-active" : ""} onClick={() => { setFloor(f); pick(null); }}>
              {floorName(f, draft.floors)}<small>{rooms.filter((r) => r.floor === f && !typeOf(r.type).outdoor).length} rooms</small>
            </button>
          ))}
          {draft.floors < MAX_FLOORS && <button type="button" className="hb-ghost" onClick={addFloor}>+ Add a floor</button>}
          {draft.floors > 1 && floor === draft.floors - 1 && (
            <button type="button" className="hb-ghost hb-danger" onClick={() => (confirm === "floor" ? removeFloor() : setConfirm("floor"))}>
              {confirm === "floor" ? "Tap again to remove it" : "Remove this floor"}
            </button>
          )}
        </nav>

        <div className="hb-plan">
          <svg ref={svg} viewBox={`${view.x0} ${view.z0} ${view.w} ${view.h}`} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
            onPointerDown={() => pick(null)} role="application" aria-label={`${floorName(floor, draft.floors)} plan`}>
            <defs><pattern id="hb-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" className="hb-gridline" /></pattern></defs>
            <rect x={view.x0} y={view.z0} width={view.w} height={view.h} fill="url(#hb-grid)" />
            <text x={view.x0 + view.w / 2} y={view.z0 + 0.8} className="hb-compass" fontSize={fs * 0.8}>BACK</text>
            <text x={view.x0 + view.w / 2} y={view.z0 + view.h - 0.4} className="hb-compass" fontSize={fs * 0.8}>FRONT OF HOUSE</text>
            {below.map((r) => <polygon key={`b-${r.key}`} points={pts(roomPoly(r))} className="hb-below" />)}
            {onFloor.map((r) => (
              <g key={r.key} className={`hb-room${typeOf(r.type).outdoor ? " is-out" : ""}${r.key === selected ? " is-sel" : ""}${clashes.has(r.key) ? " is-clash" : ""}`}>
                <polygon className="hb-shape" points={pts(roomPoly(r))} onPointerDown={(e) => start(e, r, "move")} />
              </g>
            ))}
            {stairs.filter((s) => s.floor === floor - 1).map((s) => <Stairs key={`g-${s.key}`} s={s} ghost fs={fs} />)}
            {stairs.filter((s) => s.floor === floor).map((s) => (
              <Stairs key={s.key} s={s} fs={fs} sel={selected === ST + s.key} onDown={(e, h) => start(e, s, h, "stairs")} />
            ))}
            {/* Labels and handles sit on top of the stairs. */}
            {onFloor.map((r) => {
              const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0], isSel = r.key === selected, poly = roomPoly(r);
              const lf = Math.min(fs, w / Math.max(4, r.label.length * 0.62)), hr = Math.max(0.28, fs * 0.7);
              const [lx, lz] = r.points ? insidePoint(poly, ...centroid(poly)) : [r.x[0] + w / 2, r.z[0] + d / 2];
              return (
                <g key={`l-${r.key}`}>
                  <text x={lx} y={lz} fontSize={lf} className="hb-label">{r.label}</text>
                  <text x={lx} y={lz + lf * 1.3} fontSize={lf * 0.72} className="hb-size">{fmt(w)} × {fmt(d)} m</text>
                  {isSel && poly.length < MAX_POINTS && poly.map(([x1, z1], i) => {
                    const [x2, z2] = poly[(i + 1) % poly.length];
                    if (Math.hypot(x2 - x1, z2 - z1) < 1) return null;
                    const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
                    return (
                      <g key={`e${i}`} onPointerDown={(e) => start(e, r, `e${i}`)}>
                        <circle cx={mx} cy={mz} r={hr * 0.8} className="hb-add-corner" />
                        <text x={mx} y={mz} fontSize={hr * 1.3} className="hb-plus">+</text>
                      </g>
                    );
                  })}
                  {isSel && !r.points && ["nw", "ne", "sw", "se"].map((h) => (
                    <circle key={h} cx={h.includes("w") ? r.x[0] : r.x[1]} cy={h.includes("n") ? r.z[0] : r.z[1]} r={hr} className="hb-handle" onPointerDown={(e) => start(e, r, h)} />
                  ))}
                  {isSel && r.points && r.points.map(([x, z], i) => (
                    <circle key={`v${i}`} cx={x} cy={z} r={hr} className={`hb-handle is-corner${vertex === i ? " is-active" : ""}`} onPointerDown={(e) => start(e, r, `v${i}`)} />
                  ))}
                </g>
              );
            })}
          </svg>
          {clashes.size > 0 && <p className="hb-warn">Some rooms overlap (shown in orange). That's fine while you arrange them.</p>}
        </div>

        <aside className="hb-side">
          {selStairs ? (
            <div className="hb-edit">
              <p className="h3-eyebrow">{draft.floors === 2 ? "Stairs going upstairs" : `Stairs up to the ${floorName(selStairs.floor + 1, draft.floors).toLowerCase()}`}</p>
              <p className="hb-hint">Drag the stairs to where they are in your home and pull their corners to make them longer or wider. The arrow points the way up.</p>
              <div className="hb-btn-row">
                <button type="button" className="hb-ghost" onClick={() => updateStairs(selStairs.key, turnStairs)}>Turn ↻</button>
                <button type="button" className="hb-ghost" onClick={() => updateStairs(selStairs.key, (s) => ({ ...s, dir: FLIP[s.dir] }))}>Flip ⇅</button>
              </div>
              <button type="button" className="hb-ghost hb-danger" onClick={() => (confirm === selected ? removeStairs(selStairs.key) : setConfirm(selected))}>
                {confirm === selected ? "Tap again to delete" : "Delete stairs"}
              </button>
              <button type="button" className="hb-ghost" onClick={() => pick(null)}>Done</button>
            </div>
          ) : sel ? (
            <div className="hb-edit">
              <p className="h3-eyebrow">{typeOf(sel.type).outdoor ? "Outside" : floorName(sel.floor, draft.floors)}</p>
              <label className="hb-field"><span>Name</span>
                <input value={sel.label} maxLength={30} onChange={(e) => update(sel.key, (r) => ({ ...r, label: e.target.value }))} /></label>
              {areas.filter((a) => !usedNames.has(norm(a))).length > 0 && (
                <div className="hb-chips"><small>Your Home Assistant rooms</small>
                  {areas.filter((a) => !usedNames.has(norm(a))).slice(0, 12).map((a) => <button key={a} type="button" onClick={() => update(sel.key, (r) => ({ ...r, label: a }))}>{a}</button>)}
                </div>
              )}
              <label className="hb-field"><span>Type</span>
                <select value={sel.type} onChange={(e) => update(sel.key, (r) => ({ ...r, type: e.target.value, floor: ROOM_TYPES[e.target.value].outdoor ? 0 : r.floor }))}>
                  {Object.entries(ROOM_TYPES).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                </select></label>
              <div className="hb-size-row">
                <span>Width</span><button type="button" onClick={() => resize(sel.key, "x", -GRID)} aria-label="Narrower">−</button><b>{fmt(sel.x[1] - sel.x[0])} m</b><button type="button" onClick={() => resize(sel.key, "x", GRID)} aria-label="Wider">+</button>
              </div>
              <div className="hb-size-row">
                <span>Depth</span><button type="button" onClick={() => resize(sel.key, "z", -GRID)} aria-label="Shallower">−</button><b>{fmt(sel.z[1] - sel.z[0])} m</b><button type="button" onClick={() => resize(sel.key, "z", GRID)} aria-label="Deeper">+</button>
              </div>
              {sel.points ? (
                <div className="hb-btn-row">
                  {vertex !== null && sel.points.length > 3 && vertex < sel.points.length && (
                    <button type="button" className="hb-ghost" onClick={() => removeCorner(sel.key, vertex)}>Remove corner</button>
                  )}
                  <button type="button" className="hb-ghost" onClick={() => squareUp(sel.key)}>Square it up</button>
                </div>
              ) : <p className="hb-hint">Not square? Pull a + on any edge to add a corner.</p>}
              {!typeOf(sel.type).outdoor && draft.floors > 1 && (
                <label className="hb-field"><span>Floor</span>
                  <select value={sel.floor} onChange={(e) => { const f = Number(e.target.value); update(sel.key, (r) => ({ ...r, floor: f })); setFloor(f); }}>
                    {Array.from({ length: draft.floors }, (_, f) => <option key={f} value={f}>{floorName(f, draft.floors)}</option>)}
                  </select></label>
              )}
              <button type="button" className="hb-ghost hb-danger" onClick={() => (confirm === sel.key ? removeRoom(sel.key) : setConfirm(sel.key))}>
                {confirm === sel.key ? "Tap again to delete" : "Delete room"}
              </button>
              <button type="button" className="hb-ghost" onClick={() => pick(null)}>Done</button>
            </div>
          ) : (
            <div className="hb-add">
              <p className="h3-eyebrow">Add a room to the {floorName(floor, draft.floors).toLowerCase()}</p>
              <div className="hb-type-grid">
                {Object.entries(ROOM_TYPES).filter(([, t]) => floor === 0 || !t.outdoor).map(([k, t]) => (
                  <button key={k} type="button" onClick={() => addRoom(k)} disabled={rooms.length >= MAX_ROOMS}>{t.label}</button>
                ))}
              </div>
              {floor < draft.floors - 1 && (
                <button type="button" className="hb-ghost" onClick={addStairs} disabled={stairs.length >= MAX_STAIRS}>+ Add stairs</button>
              )}
              <p className="hb-hint">Tap a room on the plan to rename, resize, reshape or delete it. Tap stairs to move, turn or flip them.</p>
            </div>
          )}
        </aside>
      </div>
      {templates && <Templates onClose={() => setTemplates(false)} onPick={(l) => { setDraft(cleanLayout(l)); setFloor(0); pick(null); setTemplates(false); }} />}
    </motion.div>
  );
}

function uniqueLabel(label, rooms) {
  const used = new Set(rooms.map((r) => r.label.toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let i = 2; ; i++) if (!used.has(`${label} ${i}`.toLowerCase())) return `${label} ${i}`;
}
