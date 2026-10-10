// <HouseBuilder /> lets anyone make the 3D house look like their own home: pick a starting house type, set
// how many floors there are, add rooms, drag them into place and resize them on a floor plan, and name each
// room like its Home Assistant area so the devices land in the right place.
import { useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { GRID, MAX_FLOORS, MAX_ROOMS, ROOM_TYPES, TEMPLATES, cleanLayout, floorName, newKey, typeOf } from "../houseLayout.js";
import { norm } from "../houseMap.js";

const snap = (v) => Math.round(v / GRID) * GRID;
const MIN = 1;
const overlaps = (a, b) => a !== b && a.floor === b.floor && !typeOf(a.type).outdoor === !typeOf(b.type).outdoor
  && Math.min(a.x[1], b.x[1]) - Math.max(a.x[0], b.x[0]) > 0.01 && Math.min(a.z[1], b.z[1]) - Math.max(a.z[0], b.z[0]) > 0.01;
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

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
      {rooms.map((r) => <rect key={r.key} x={r.x[0]} y={r.z[0]} width={r.x[1] - r.x[0]} height={r.z[1] - r.z[0]} className={typeOf(r.type).outdoor ? "is-out" : ""} />)}
    </svg>
  );
}

export function HouseBuilder({ layout, areas, onSave, onCancel }) {
  const [draft, setDraft] = useState(() => structuredClone(layout));
  const [floor, setFloor] = useState(0);
  const [selected, setSelected] = useState(null);
  const [templates, setTemplates] = useState(false);
  const [confirm, setConfirm] = useState(null);
  const svg = useRef(), drag = useRef(null);
  const [dragging, setDragging] = useState(false);

  const rooms = draft.rooms;
  const sel = rooms.find((r) => r.key === selected) || null;
  const update = (key, fn) => setDraft((d) => ({ ...d, rooms: d.rooms.map((r) => (r.key === key ? fn(r) : r)) }));

  // The plan's viewport covers every floor, so rooms stay put when you switch floors.
  // (It stays still while a room is being dragged, then refits.)
  const lastView = useRef(null);
  const view = useMemo(() => {
    if (drag.current && lastView.current) return lastView.current;
    const xs = rooms.flatMap((r) => r.x), zs = rooms.flatMap((r) => r.z);
    const x0 = Math.min(-6, ...xs) - 2, x1 = Math.max(6, ...xs) + 2, z0 = Math.min(-6, ...zs) - 2, z1 = Math.max(6, ...zs) + 2.5;
    return (lastView.current = { x0, z0, w: x1 - x0, h: z1 - z0 });
  }, [rooms, dragging]); // eslint-disable-line react-hooks/exhaustive-deps
  const onFloor = rooms.filter((r) => (floor === 0 ? r.floor === 0 : r.floor === floor && !typeOf(r.type).outdoor));
  const below = floor > 0 ? rooms.filter((r) => r.floor === floor - 1 && !typeOf(r.type).outdoor) : [];
  const usedNames = new Set(rooms.map((r) => norm(r.label)));

  const toPlan = (e) => {
    const p = svg.current.createSVGPoint(); p.x = e.clientX; p.y = e.clientY;
    const q = p.matrixTransform(svg.current.getScreenCTM().inverse()); return [q.x, q.y];
  };
  const start = (e, room, handle) => {
    e.stopPropagation(); e.preventDefault();
    setSelected(room.key); setConfirm(null);
    svg.current.setPointerCapture(e.pointerId);
    drag.current = { key: room.key, handle, from: toPlan(e), x: [...room.x], z: [...room.z] };
    setDragging(true);
  };
  const move = (e) => {
    const d = drag.current; if (!d) return;
    const [px, pz] = toPlan(e), dx = snap(px - d.from[0]), dz = snap(pz - d.from[1]);
    update(d.key, (r) => {
      if (d.handle === "move") return { ...r, x: [d.x[0] + dx, d.x[1] + dx], z: [d.z[0] + dz, d.z[1] + dz] };
      const x = [...d.x], z = [...d.z];
      if (d.handle.includes("w")) x[0] = Math.min(d.x[0] + dx, d.x[1] - MIN);
      if (d.handle.includes("e")) x[1] = Math.max(d.x[1] + dx, d.x[0] + MIN);
      if (d.handle.includes("n")) z[0] = Math.min(d.z[0] + dz, d.z[1] - MIN);
      if (d.handle.includes("s")) z[1] = Math.max(d.z[1] + dz, d.z[0] + MIN);
      return { ...r, x, z };
    });
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
  const removeRoom = (key) => { setDraft((d) => ({ ...d, rooms: d.rooms.filter((r) => r.key !== key) })); setSelected(null); setConfirm(null); };
  const addFloor = () => { if (draft.floors >= MAX_FLOORS) return; setDraft((d) => ({ ...d, floors: d.floors + 1 })); setFloor(draft.floors); setSelected(null); };
  const removeFloor = () => {
    const top = draft.floors - 1;
    setDraft((d) => ({ ...d, floors: d.floors - 1, rooms: d.rooms.filter((r) => r.floor !== top) }));
    setFloor(Math.max(0, top - 1)); setSelected(null); setConfirm(null);
  };
  const resize = (key, axis, delta) => update(key, (r) => ({ ...r, [axis]: [r[axis][0], Math.max(r[axis][0] + MIN, r[axis][1] + delta)] }));
  const save = () => { const clean = cleanLayout(draft); if (clean) onSave(clean); };

  const fs = Math.max(0.32, Math.min(0.5, view.w / 50));
  return (
    <motion.div className="hb" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.35 }}>
      <header className="hb-head">
        <div><p className="h3-eyebrow">House builder</p><h2>Make it your house</h2>
          <p className="hb-hint">Drag rooms into place and pull their corners to resize. Name each room like it is in Home Assistant, and its devices appear there.</p></div>
        <div className="hb-head-actions">
          <button type="button" className="h3-pill" onClick={() => setTemplates(true)}>House types</button>
          <button type="button" className="h3-pill" onClick={onCancel}>Cancel</button>
          <button type="button" className="h3-pill hb-save" onClick={save}>Save house</button>
        </div>
      </header>

      <div className="hb-body">
        <nav className="hb-floors" aria-label="Floors">
          {Array.from({ length: draft.floors }, (_, i) => draft.floors - 1 - i).map((f) => (
            <button key={f} type="button" className={f === floor ? "is-active" : ""} onClick={() => { setFloor(f); setSelected(null); setConfirm(null); }}>
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
            onPointerDown={() => { setSelected(null); setConfirm(null); }} role="application" aria-label={`${floorName(floor, draft.floors)} plan`}>
            <defs><pattern id="hb-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" className="hb-gridline" /></pattern></defs>
            <rect x={view.x0} y={view.z0} width={view.w} height={view.h} fill="url(#hb-grid)" />
            <text x={view.x0 + view.w / 2} y={view.z0 + 0.8} className="hb-compass" fontSize={fs * 0.8}>BACK</text>
            <text x={view.x0 + view.w / 2} y={view.z0 + view.h - 0.4} className="hb-compass" fontSize={fs * 0.8}>FRONT OF HOUSE</text>
            {below.map((r) => <rect key={`b-${r.key}`} x={r.x[0]} y={r.z[0]} width={r.x[1] - r.x[0]} height={r.z[1] - r.z[0]} className="hb-below" />)}
            {onFloor.map((r) => {
              const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0], out = typeOf(r.type).outdoor, isSel = r.key === selected;
              const clash = rooms.some((o) => overlaps(r, o));
              const lf = Math.min(fs, w / Math.max(4, r.label.length * 0.62));
              return (
                <g key={r.key} className={`hb-room${out ? " is-out" : ""}${isSel ? " is-sel" : ""}${clash ? " is-clash" : ""}`}>
                  <rect x={r.x[0]} y={r.z[0]} width={w} height={d} onPointerDown={(e) => start(e, r, "move")} />
                  <text x={r.x[0] + w / 2} y={r.z[0] + d / 2} fontSize={lf} className="hb-label">{r.label}</text>
                  <text x={r.x[0] + w / 2} y={r.z[0] + d / 2 + lf * 1.3} fontSize={lf * 0.72} className="hb-size">{fmt(w)} × {fmt(d)} m</text>
                  {isSel && ["nw", "ne", "sw", "se"].map((h) => (
                    <circle key={h} cx={h.includes("w") ? r.x[0] : r.x[1]} cy={h.includes("n") ? r.z[0] : r.z[1]} r={Math.max(0.28, fs * 0.7)} className="hb-handle" onPointerDown={(e) => start(e, r, h)} />
                  ))}
                </g>
              );
            })}
          </svg>
          {rooms.some((r) => rooms.some((o) => overlaps(r, o))) && <p className="hb-warn">Some rooms overlap (shown in orange). That's fine while you arrange them.</p>}
        </div>

        <aside className="hb-side">
          {sel ? (
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
              {!typeOf(sel.type).outdoor && draft.floors > 1 && (
                <label className="hb-field"><span>Floor</span>
                  <select value={sel.floor} onChange={(e) => { const f = Number(e.target.value); update(sel.key, (r) => ({ ...r, floor: f })); setFloor(f); }}>
                    {Array.from({ length: draft.floors }, (_, f) => <option key={f} value={f}>{floorName(f, draft.floors)}</option>)}
                  </select></label>
              )}
              <button type="button" className="hb-ghost hb-danger" onClick={() => (confirm === sel.key ? removeRoom(sel.key) : setConfirm(sel.key))}>
                {confirm === sel.key ? "Tap again to delete" : "Delete room"}
              </button>
              <button type="button" className="hb-ghost" onClick={() => setSelected(null)}>Done</button>
            </div>
          ) : (
            <div className="hb-add">
              <p className="h3-eyebrow">Add a room to the {floorName(floor, draft.floors).toLowerCase()}</p>
              <div className="hb-type-grid">
                {Object.entries(ROOM_TYPES).filter(([, t]) => floor === 0 || !t.outdoor).map(([k, t]) => (
                  <button key={k} type="button" onClick={() => addRoom(k)} disabled={rooms.length >= MAX_ROOMS}>{t.label}</button>
                ))}
              </div>
              <p className="hb-hint">Tap a room on the plan to rename, resize or delete it.</p>
            </div>
          )}
        </aside>
      </div>
      {templates && <Templates onClose={() => setTemplates(false)} onPick={(l) => { setDraft(structuredClone(l)); setFloor(0); setSelected(null); setTemplates(false); }} />}
    </motion.div>
  );
}

function uniqueLabel(label, rooms) {
  const used = new Set(rooms.map((r) => r.label.toLowerCase()));
  if (!used.has(label.toLowerCase())) return label;
  for (let i = 2; ; i++) if (!used.has(`${label} ${i}`.toLowerCase())) return `${label} ${i}`;
}
