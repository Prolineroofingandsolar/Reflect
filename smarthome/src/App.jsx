// The 3D House screen. HOUSE → ROOM → DEVICE: the house is the navigation, touch and voice drive the same
// view state, and every control ends in a Home Assistant service call.
import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { AnimatePresence } from "framer-motion";
import { House3D, useGlbModel, useLayoutModel } from "./components/House3D.jsx";
import { HouseBuilder } from "./components/HouseBuilder.jsx";
import { DEFAULT_LAYOUT, cleanLayout, floorName } from "./houseLayout.js";
import { RoomPanel } from "./components/RoomPanel.jsx";
import { CameraPanel, FloorSwitch, HomeStatus, Indicators, Scenes, Toast, VoiceAssistant } from "./components/Hud.jsx";
import { bridge, useEntities } from "./bridge.js";
import { norm, placeEntities } from "./houseMap.js";
import { houseStatus, roomLight } from "./home.js";

const initial = { mode: "house", room: null, device: null, floor: "all", camera: null };
function reducer(s, a) {
  switch (a.type) {
    case "house": return { ...initial };
    case "floor": return { ...initial, floor: a.floor };
    case "room": return { ...s, mode: "room", room: a.room, device: a.device ?? null, camera: null, floor: "all" };
    case "device": return { ...s, device: a.device };
    case "camera": return { ...s, mode: "camera", camera: a.camera, room: null, device: null };
    default: return s;
  }
}

const LAYOUT_KEY = "reflect-house-layout";
function cachedLayout() { try { return cleanLayout(JSON.parse(localStorage.getItem(LAYOUT_KEY) || "null")); } catch { return null; } }

function GlbScene(props) { return <SceneBody {...props} model={useGlbModel(`smarthome/${props.config.model}`)} />; }
function LayoutScene(props) { return <SceneBody {...props} model={useLayoutModel(props.layout)} />; }
function SceneBody({ model, config, entities, view, dispatch, effects, onApi }) {
  const placements = useMemo(() => placeEntities(entities, model, config), [entities, model, config]);
  const rooms = useMemo(() => {
    const by = new Map(model.rooms.map((r) => [r.key, []]));
    placements.forEach((p, id) => { if (p.room) by.get(p.room).push(entities.find((e) => e.id === id)); });
    return new Map([...by].map(([k, list]) => [k, roomLight(list.filter(Boolean))]));
  }, [placements, entities, model]);
  useEffect(() => { onApi({ model, placements }); }, [model, placements, onApi]);
  return (
    <House3D model={model} rooms={rooms} placements={placements} entities={entities} view={view} effects={effects}
      onSelectRoom={(room) => dispatch({ type: "room", room })} onSelectDevice={(device) => dispatch({ type: "device", device })} />
  );
}

export function App({ active }) {
  const entities = useEntities();
  const [config, setConfig] = useState(null);
  const [view, dispatch] = useReducer(reducer, initial);
  const [effects, setEffects] = useState({ beams: [], waves: [], pulses: {} });
  const [toast, setToast] = useState("");
  const [scenesOpen, setScenesOpen] = useState(false);
  // The house layout: saved with the account (and cached on this mirror); a sample house until one is saved.
  const [layout, setLayout] = useState(() => cachedLayout() || DEFAULT_LAYOUT);
  const [layoutSaved, setLayoutSaved] = useState(() => Boolean(cachedLayout()));
  const [building, setBuilding] = useState(false);
  const world = useRef({ model: null, placements: new Map() });
  const onApi = useCallback((w) => { world.current = w; }, []);

  useEffect(() => { fetch("smarthome/house-map.json").then((r) => r.json()).then(setConfig).catch(() => setConfig({ rooms: {}, scenes: [], cameras: [] })); }, []);
  useEffect(() => {
    fetch("/api/house-layout", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((d) => {
      const l = cleanLayout(d?.layout);
      if (l) { setLayout(l); setLayoutSaved(true); try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch {} }
    }).catch(() => {});
  }, []);
  const saveLayout = useCallback((l) => {
    setLayout(l); setLayoutSaved(true); setBuilding(false); dispatch({ type: "house" });
    try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(l)); } catch {}
    fetch("/api/house-layout", { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ layout: l }) })
      .then((r) => { if (!r.ok) setToast("Saved on this mirror. Sign in to keep it with your account."); }).catch(() => setToast("Saved on this mirror only."));
  }, []);
  const areas = useMemo(() => [...new Set(entities.map((e) => e.area).filter(Boolean))].sort(), [entities]);
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(""), 4000); return () => clearTimeout(t); }, [toast]);

  // Every Home Assistant command (touch or voice) sends a beam to what it changed.
  useEffect(() => {
    const on = (e) => {
      const { entityIds = [], areaIds = [], rooms = [] } = e.detail || {};
      const p = world.current.placements, extraRooms = [...rooms];
      areaIds.forEach((a) => { const hit = [...p].find(([id, x]) => x.room && entities.find((en) => en.id === id && (en.areaId === a || norm(en.area) === norm(a)))); if (hit) extraRooms.push(hit[1].room); });
      const born = performance.now();
      setEffects((f) => ({ ...f, beams: [...f.beams.filter((b) => born - b.born < 2000), { born, entityIds, rooms: [...new Set(extraRooms)] }], pulses: { ...f.pulses, ...Object.fromEntries(extraRooms.map((r) => [r, born])) } }));
    };
    window.addEventListener("reflect:home-action", on);
    return () => window.removeEventListener("reflect:home-action", on);
  }, [entities]);

  const status = useMemo(() => houseStatus(entities), [entities]);
  const cameras = useMemo(() => {
    const cams = entities.filter((e) => e.domain === "camera");
    return cams.map((c) => {
      const rule = (config?.cameras || []).find((r) => r.match.some((m) => norm(c.id).includes(norm(m)) || norm(c.name).includes(norm(m))));
      return { id: c.id, label: rule?.label || c.name.replace(/\s*camera$/i, "") };
    });
  }, [entities, config]);

  const findRoom = useCallback((name) => {
    const m = world.current.model; if (!m || !name) return null;
    const n = norm(name).replace(/^the_/, "");
    return m.rooms.find((r) => r.key === n || norm(r.label) === n || (config?.rooms?.[r.key]?.areas || []).map(norm).includes(n))
      || m.rooms.find((r) => n.includes(r.key) || r.key.includes(n) || norm(r.label).includes(n)) || null;
  }, [config]);

  // Scenes run a Home Assistant scene/script if one exists, otherwise the actions in house-map.json.
  const runScene = useCallback(async (key) => {
    const scene = (config?.scenes || []).find((s) => s.key === key || norm(s.label) === norm(key));
    if (!scene) throw new Error(`There's no ${key} scene.`);
    const p = world.current.placements, byRoom = (room) => [...p].filter(([, x]) => x.room === room).map(([id]) => entities.find((e) => e.id === id)).filter(Boolean);
    const born = performance.now(), touched = new Set();
    setEffects((f) => ({ ...f, waves: [...f.waves.filter((w) => born - w.born < 2000), { born }] }));
    const own = (scene.entity || []).find((id) => entities.some((e) => e.id === id));
    if (own) { await bridge.call(`${own.split(".")[0]}.turn_on`, { entity_id: own }); return scene.label; }
    for (const a of scene.actions || []) {
      const domain = a.service.split(".")[0];
      let targets;
      if (a.domain) targets = entities.filter((e) => e.domain === a.domain);
      else {
        // Scene rooms name a room key or a room type ("bedroom" covers every bedroom).
        const all = world.current.model.rooms, match = (list) => all.filter((r) => (list || []).includes("*") || (list || []).includes(r.key) || (list || []).includes(r.type)).map((r) => r.key);
        const skip = new Set(all.filter((r) => (a.except || []).includes(r.key) || (a.except || []).includes(r.type)).map((r) => r.key));
        const roomKeys = match(a.rooms);
        targets = roomKeys.filter((r) => !skip.has(r)).flatMap((r) => { const list = byRoom(r).filter((e) => e.domain === domain); if (list.length) touched.add(r); return list; });
      }
      if (!targets.length) continue;
      const data = { ...(a.data || {}) };
      if (data.color_temp_kelvin && domain === "light") { data.kelvin = data.color_temp_kelvin; delete data.color_temp_kelvin; Object.assign(data, bridge.lightOptions("light", { action: "turn_on", ...data })); delete data.kelvin; }
      await bridge.call(a.service, { entity_id: targets.map((e) => e.id), ...data }, { entityIds: targets.map((e) => e.id), rooms: [...touched] });
    }
    setEffects((f) => ({ ...f, pulses: { ...f.pulses, ...Object.fromEntries([...touched].map((r) => [r, performance.now()])) } }));
    return scene.label;
  }, [config, entities]);

  // The API Jarvis (assistant.js) and the rest of the mirror use to drive this screen.
  useEffect(() => {
    const api = window.ReflectHome3D;
    api.showRoom = (name) => { const r = findRoom(name); if (!r) throw new Error(`There's no room called ${name}.`); bridge.showView("house3d"); dispatch({ type: "room", room: r.key }); return r.label; };
    api.showHouse = () => { bridge.showView("house3d"); dispatch({ type: "house" }); };
    api.showFloor = (floor) => {
      const n = world.current.model?.floors || 1, f = String(floor).toLowerCase();
      const pick = /down|ground|^0$/.test(f) ? 0 : /second|^2$/.test(f) ? 2 : /third|^3$/.test(f) ? 3 : /top|attic|loft/.test(f) ? n - 1 : /up|first|^1$/.test(f) ? 1 : "all";
      bridge.showView("house3d"); dispatch({ type: "floor", floor: typeof pick === "number" && pick < n ? pick : "all" });
    };
    api.editHouse = () => { bridge.showView("house3d"); setBuilding(true); };
    api.showCamera = (name) => {
      if (!cameras.length) throw new Error("No cameras are set up in Home Assistant.");
      const n = norm(name || "");
      const cam = cameras.find((c) => c.id === name || norm(c.label) === n) || cameras.find((c) => n && (norm(c.label).includes(n) || norm(c.id).includes(n))) || cameras[0];
      bridge.showView("house3d"); dispatch({ type: "camera", camera: cam.id }); return cam.label;
    };
    api.closeCamera = () => dispatch({ type: "house" });
    api.runScene = (key) => runScene(key);
    api.describe = () => {
      const m = world.current.model; if (!m) return [];
      const lines = [`3D house rooms (key = name): ${m.rooms.map((r) => `${r.key} = ${r.label}${m.floors > 1 && !r.outdoor ? ` (${floorName(r.floor, m.floors).toLowerCase()})` : ""}`).join(", ")}.`];
      lines.push(`3D house view: ${view.mode === "room" ? `focused on ${view.room}` : view.mode === "camera" ? `showing camera ${view.camera}` : view.floor === "all" ? "whole house" : floorName(view.floor, m.floors).toLowerCase()}.`);
      if (config?.scenes?.length) lines.push(`Scenes: ${config.scenes.map((s) => `${s.key} (${s.label})`).join(", ")}.`);
      lines.push(cameras.length ? `Cameras: ${cameras.map((c) => `${c.id} (${c.label})`).join(", ")}.` : "Cameras: none.");
      return lines;
    };
  }, [findRoom, cameras, runScene, view, config]);

  const roomEntities = useMemo(() => {
    if (!view.room) return [];
    return [...world.current.placements].filter(([, p]) => p.room === view.room).map(([id]) => entities.find((e) => e.id === id)).filter(Boolean);
  }, [view.room, entities]);
  const room = world.current.model?.rooms.find((r) => r.key === view.room);

  // Without Home Assistant the house still shows (empty rooms), with a prompt to connect it.
  const connected = bridge.connected();
  return (
    <div className={`h3-app is-${view.mode}`}>
      <Canvas className="h3-canvas" frameloop={active ? "always" : "never"} dpr={[1, 1.5]} gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: 38, near: 0.1, far: 400, position: [20, 16, 26] }} onPointerMissed={() => view.mode === "room" && dispatch({ type: "house" })}>
        {config && <Suspense fallback={null}>{config.model
          ? <GlbScene config={config} entities={entities} view={view} dispatch={dispatch} effects={effects} onApi={onApi} />
          : <LayoutScene layout={layout} config={config} entities={entities} view={view} dispatch={dispatch} effects={effects} onApi={onApi} />}</Suspense>}
      </Canvas>
      <HomeStatus status={status} weather={bridge.weather()} live={bridge.live()} connected={connected} />
      <AnimatePresence>
        {view.mode === "room" && room && <RoomPanel key={room.key} room={room} floors={world.current.model?.floors || 1} entities={roomEntities} device={view.device}
          onSelectDevice={(device) => dispatch({ type: "device", device })} onClose={() => dispatch({ type: "house" })} onError={setToast} />}
        {view.mode === "camera" && <CameraPanel key="cam" cameras={cameras} current={view.camera} onPick={(camera) => dispatch({ type: "camera", camera })} onClose={() => dispatch({ type: "house" })} />}
      </AnimatePresence>
      {!config?.model && <button type="button" className="h3-pill h3-edit-house" onClick={() => setBuilding(true)}>Edit house</button>}
      <FloorSwitch floors={world.current.model?.floors || 2} view={view} onHouse={() => dispatch({ type: "house" })} onFloor={(floor) => dispatch({ type: "floor", floor })} />
      <div className="h3-bottom">
        <VoiceAssistant />
        {connected && <Indicators status={status} />}
      </div>
      <div className="h3-actions">
        {cameras.length > 0 && view.mode !== "camera" && <button type="button" className="h3-pill" onClick={() => dispatch({ type: "camera", camera: cameras[0].id })}>Cameras</button>}
        {connected && config?.scenes?.length > 0 && <Scenes scenes={config.scenes} open={scenesOpen} setOpen={setScenesOpen} onRun={(k) => runScene(k).catch((e) => setToast(e.message))} />}
      </div>
      {!connected && (
        <div className="h3-connect">
          <p>Connect Home Assistant to fill your house with your lights, heating and cameras.</p>
          <button type="button" className="h3-pill" onClick={() => bridge.connect()}>Connect</button>
        </div>
      )}
      {connected && !layoutSaved && !config?.model && !building && view.mode === "house" && (
        <div className="h3-connect">
          <p>This is a sample house. Make it look like yours.</p>
          <button type="button" className="h3-pill" onClick={() => setBuilding(true)}>Build my house</button>
        </div>
      )}
      <AnimatePresence>{building && <HouseBuilder key="builder" layout={layout} areas={areas} onSave={saveLayout} onCancel={() => setBuilding(false)} />}</AnimatePresence>
      <Toast message={toast} />
    </div>
  );
}
