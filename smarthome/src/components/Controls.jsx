// Device controls used inside the room panel: <LightControl />, <ClimateControl />, <CoverControl />,
// <MediaControl /> and <DeviceRow /> for everything else. Each one only calls Home Assistant through the
// bridge; the 3D house and these rows then update from Home Assistant's live state.
import { useEffect, useRef, useState } from "react";
import { bridge } from "../bridge.js";
import { glow, isOn, pct } from "../home.js";

const act = (service, data, onError) => bridge.call(service, data).catch((e) => onError?.(e.message || "That didn't work."));

// A slider that follows Home Assistant but sends only when the finger settles.
function Slider({ value, onCommit, label, min = 0, max = 100, unit = "%" }) {
  const [v, setV] = useState(value);
  const busy = useRef(false), timer = useRef();
  useEffect(() => { if (!busy.current) setV(value); }, [value]);
  const change = (n) => { busy.current = true; setV(n); clearTimeout(timer.current); timer.current = setTimeout(() => { busy.current = false; onCommit(n); }, 280); };
  return (
    <label className="h3-slider">
      <span className="sr">{label}</span>
      <input type="range" min={min} max={max} value={v} onChange={(e) => change(Number(e.target.value))} style={{ "--fill": `${((v - min) / (max - min)) * 100}%` }} />
      <output>{v}{unit}</output>
    </label>
  );
}

function Toggle({ on, onClick, label }) {
  return <button type="button" className={`h3-toggle${on ? " is-on" : ""}`} aria-pressed={on} aria-label={label} onClick={onClick}><i /></button>;
}

const SWATCHES = [["Warm", { kelvin: 2400 }, "#ffb06a"], ["Neutral", { kelvin: 4000 }, "#ffe4c4"], ["Cool", { kelvin: 6000 }, "#cfe6ff"], ["Red", { color: "red" }, "#ff3b3b"], ["Orange", { color: "orange" }, "#ff9b2f"], ["Green", { color: "lime" }, "#4dff6a"], ["Cyan", { color: "cyan" }, "#4de8ff"], ["Blue", { color: "blue" }, "#3b6bff"], ["Purple", { color: "purple" }, "#a64dff"], ["Pink", { color: "hotpink" }, "#ff5fb0"]];

export function LightControl({ entity, expanded, onSelect, onError }) {
  const on = isOn(entity), [r, g, b] = glow(entity).map((c) => Math.round(c * 255));
  const swatches = SWATCHES.filter(([, o]) => (o.color ? entity.canColor : entity.canTemp || entity.canColor));
  const turnOn = (input) => act("light.turn_on", { entity_id: entity.id, ...bridge.lightOptions("light", { action: "turn_on", ...input }) }, onError);
  return (
    <div className={`h3-row h3-light${on ? " is-on" : ""}${expanded ? " is-expanded" : ""}`} style={{ "--glow": `rgb(${r},${g},${b})` }}>
      <button type="button" className="h3-row-main" onClick={onSelect}>
        <span className="h3-bulb" /><span className="h3-name">{entity.name}</span>
        {!(on && entity.canDim) && <span className="h3-value">{on ? "On" : "Off"}</span>}
      </button>
      <Toggle on={on} label={`${entity.name} ${on ? "off" : "on"}`} onClick={() => act(on ? "light.turn_off" : "light.turn_on", { entity_id: entity.id }, onError)} />
      {entity.canDim && (expanded || on) && <Slider label={`${entity.name} brightness`} value={pct(entity) || 1} min={1} onCommit={(n) => turnOn({ brightness_pct: n })} />}
      {expanded && swatches.length > 0 && (
        <div className="h3-swatches">{swatches.map(([name, o, c]) => <button key={name} type="button" style={{ "--sw": c }} onClick={() => turnOn(o)}><i />{name}</button>)}</div>
      )}
    </div>
  );
}

export function ClimateControl({ entity, onError }) {
  const target = entity.temperature, heating = entity.hvacAction === "heating";
  const set = (t) => act("climate.set_temperature", { entity_id: entity.id, temperature: Math.round(t * 2) / 2 }, onError);
  return (
    <div className={`h3-row h3-climate${heating ? " is-heating" : ""}`}>
      <div className="h3-climate-now"><small>Now</small><strong>{entity.currentTemperature != null ? `${Number(entity.currentTemperature).toFixed(1)}°` : "–"}</strong></div>
      <div className="h3-climate-set">
        <button type="button" aria-label="Lower temperature" onClick={() => target != null && set(target - 0.5)}>−</button>
        <div><small>Target</small><strong>{target != null ? `${target}°` : "–"}</strong></div>
        <button type="button" aria-label="Raise temperature" onClick={() => target != null && set(target + 0.5)}>+</button>
      </div>
      <span className="h3-chip">{heating ? "Heating" : entity.hvacAction ? entity.hvacAction[0].toUpperCase() + entity.hvacAction.slice(1) : entity.state}</span>
    </div>
  );
}

export function CoverControl({ entity, onError }) {
  const position = entity.position;
  return (
    <div className="h3-row">
      <div className="h3-row-main"><span className="h3-icon">▤</span><span className="h3-name">{entity.name}</span><span className="h3-value">{position != null ? `${position}% open` : entity.state}</span></div>
      <div className="h3-buttons">
        <button type="button" onClick={() => act("cover.open_cover", { entity_id: entity.id }, onError)}>Open</button>
        <button type="button" onClick={() => act("cover.close_cover", { entity_id: entity.id }, onError)}>Close</button>
      </div>
      {position != null && <Slider label={`${entity.name} position`} value={position} onCommit={(n) => act("cover.set_cover_position", { entity_id: entity.id, position: n }, onError)} />}
    </div>
  );
}

export function MediaControl({ entity, onError }) {
  const playing = entity.state === "playing", m = entity.media || {};
  return (
    <div className={`h3-row h3-media${playing ? " is-on" : ""}`}>
      <div className="h3-row-main"><span className="h3-icon">▶</span><span className="h3-name">{entity.name}</span><span className="h3-value">{isOn(entity) ? entity.state : "Off"}</span></div>
      {(m.title || m.artist) && <p className="h3-now">{[m.title, m.artist].filter(Boolean).join(" · ")}</p>}
      <div className="h3-buttons">
        {isOn(entity)
          ? <><button type="button" onClick={() => act("media_player.media_play_pause", { entity_id: entity.id }, onError)}>{playing ? "Pause" : "Play"}</button>
            <button type="button" onClick={() => act("media_player.turn_off", { entity_id: entity.id }, onError)}>Turn off</button></>
          : <button type="button" onClick={() => act("media_player.turn_on", { entity_id: entity.id }, onError)}>Turn on</button>}
      </div>
      {isOn(entity) && m.volume != null && <Slider label={`${entity.name} volume`} value={Math.round(m.volume * 100)} onCommit={(n) => act("media_player.volume_set", { entity_id: entity.id, volume_level: n / 100 }, onError)} />}
    </div>
  );
}

const SENSOR_TEXT = { door: ["Closed", "Open"], window: ["Closed", "Open"], garage_door: ["Closed", "Open"], opening: ["Closed", "Open"], motion: ["Clear", "Motion"], occupancy: ["Clear", "Occupied"], presence: ["Away", "Present"], moisture: ["Dry", "Wet"], smoke: ["Clear", "Smoke!"] };
export function DeviceRow({ entity, onError }) {
  const on = isOn(entity), d = entity.domain;
  let value = on ? "On" : "Off", control = null;
  if (d === "sensor") value = `${entity.state}${entity.unit ? ` ${entity.unit}` : ""}`;
  else if (d === "binary_sensor") value = (SENSOR_TEXT[entity.deviceClass] || ["Off", "On"])[on ? 1 : 0];
  else if (d === "lock") { const locked = String(entity.state).toLowerCase() === "locked"; value = locked ? "Locked" : "Unlocked"; control = <button type="button" className="h3-small" onClick={() => act(locked ? "lock.unlock" : "lock.lock", { entity_id: entity.id }, onError)}>{locked ? "Unlock" : "Lock"}</button>; }
  else if (d === "scene" || d === "script") { value = ""; control = <button type="button" className="h3-small" onClick={() => act(`${d}.turn_on`, { entity_id: entity.id }, onError)}>Run</button>; }
  else if (d === "switch" || d === "fan") control = <Toggle on={on} label={`${entity.name} ${on ? "off" : "on"}`} onClick={() => act(`${d}.toggle`, { entity_id: entity.id }, onError)} />;
  else if (d === "camera") value = "Camera";
  return (
    <div className={`h3-row h3-device${on && d !== "sensor" ? " is-on" : ""}`}>
      <div className="h3-row-main"><span className="h3-icon">{d === "binary_sensor" || d === "sensor" ? "◉" : d === "lock" ? "⚿" : "⏻"}</span><span className="h3-name">{entity.name}</span><span className="h3-value">{value}</span></div>
      {control}
    </div>
  );
}
