// The quiet mirror HUD around the house: <HomeStatus /> (time, weather, security, indoor temperature,
// energy and the bottom indicators), <VoiceAssistant /> (Jarvis's listening / thinking states as a cyan
// waveform under the house), <CameraPanel />, <Scenes /> and the floor switch.
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { holo } from "./RoomPanel.jsx";

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t); }, []);
  return now;
}

export function HomeStatus({ status, weather, live }) {
  const now = useClock();
  const w = weather?.data?.current;
  return (
    <>
      <div className="h3-corner h3-tl">
        <div className="h3-time">{now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</div>
        <div className="h3-date">{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</div>
        {w && <div className="h3-weather">{Math.round(w.temperature_2m)}° · {weather.label?.(w.weather_code)} · {weather.place}</div>}
      </div>
      <div className="h3-corner h3-tr">
        {status.security && <div className={`h3-stat${status.secure ? "" : " is-warn"}`}><small>Security</small><strong>{status.security}</strong></div>}
        {status.indoor && <div className="h3-stat"><small>Indoor</small><strong>{status.indoor}</strong></div>}
        {status.energy && <div className="h3-stat"><small>Energy</small><strong>{status.energy}</strong></div>}
        <div className={`h3-live${live ? " is-live" : ""}`}>{live ? "Live" : "Syncing"}</div>
      </div>
    </>
  );
}

export function Indicators({ status }) {
  const items = [
    ["Lights", status.lights ? `${status.lightsOn} on` : null, status.lightsOn > 0],
    ["Heating", status.heating, status.heating === "Heating"],
    ["Security", status.security, !status.secure],
    ["Doors & windows", status.open ? `${status.open} open` : "All closed", status.open > 0]
  ].filter(([, v]) => v);
  return <div className="h3-indicators">{items.map(([k, v, hot]) => <div key={k} className={`h3-ind${hot ? " is-hot" : ""}`}><i />{k}<b>{v}</b></div>)}</div>;
}

// Jarvis's states, from assistant.js: idle (nothing shown), listening (waveform), thinking (pulse),
// speaking (his words, briefly), error (a small message).
export function VoiceAssistant() {
  const [s, setS] = useState({ state: "idle", heard: "", reply: "" });
  const canvas = useRef();
  useEffect(() => {
    const on = (e) => setS((prev) => ({ ...prev, ...e.detail }));
    window.addEventListener("reflect:assistant", on);
    return () => window.removeEventListener("reflect:assistant", on);
  }, []);
  useEffect(() => { if (!s.error) return; const t = setTimeout(() => setS((p) => ({ ...p, error: "" })), 4500); return () => clearTimeout(t); }, [s.error]);
  useEffect(() => {
    if (s.state !== "listening" && s.state !== "speaking") return;
    let raf, t0 = performance.now();
    const draw = () => {
      const c = canvas.current; if (!c) return;
      const g = c.getContext("2d"), w = c.width, h = c.height, t = (performance.now() - t0) / 1000;
      g.clearRect(0, 0, w, h);
      const bars = 48, amp = s.state === "listening" ? 1 : 0.55;
      for (let i = 0; i < bars; i++) {
        const x = (i + 0.5) * (w / bars), env = Math.sin((i / (bars - 1)) * Math.PI);
        const v = env * amp * (0.25 + 0.75 * Math.abs(Math.sin(t * 3.1 + i * 0.45) * Math.cos(t * 1.7 + i * 0.21)));
        const bh = Math.max(2, v * h * 0.9);
        g.fillStyle = `rgba(86,216,255,${0.35 + v * 0.65})`;
        g.fillRect(x - 1.5, (h - bh) / 2, 3, bh);
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [s.state]);
  const visible = s.state !== "idle" || Boolean(s.error);
  return (
    <AnimatePresence>
      {visible && (
        <motion.div className={`h3-voice is-${s.state === "idle" && s.error ? "error" : s.state}`} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}>
          {(s.state === "listening" || s.state === "speaking") && <canvas ref={canvas} width="520" height="64" className="h3-wave" />}
          {s.state === "thinking" && <div className="h3-pulse"><i /><i /><i /></div>}
          <p className="h3-voice-text">
            {s.state === "listening" ? (s.heard ? `“${s.heard}”` : "Listening…") : s.state === "thinking" ? (s.heard ? `“${s.heard}”` : "Working on it…") : s.state === "speaking" ? s.reply : s.error}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function CameraPanel({ cameras, current, onPick, onClose }) {
  const cam = cameras.find((c) => c.id === current) || cameras[0];
  const [bust, setBust] = useState(0);
  useEffect(() => setBust(Date.now()), [cam?.id]);
  if (!cam) return null;
  return (
    <motion.section className="h3-panel h3-camera" {...holo} aria-label={`${cam.label} camera`}>
      <header className="h3-panel-head">
        <div><p className="h3-eyebrow">Live camera</p><h2>{cam.label}</h2></div>
        <button type="button" className="h3-close" onClick={onClose} aria-label="Close camera">✕</button>
      </header>
      <div className="h3-feed"><img key={`${cam.id}-${bust}`} src={`/api/homeassistant/camera/${cam.id}?t=${bust}`} alt={`${cam.label} live view`} /><i className="h3-feed-scan" /></div>
      {cameras.length > 1 && <div className="h3-tabs">{cameras.map((c) => <button key={c.id} type="button" className={c.id === cam.id ? "is-active" : ""} onClick={() => onPick(c.id)}>{c.label}</button>)}</div>}
    </motion.section>
  );
}

export function Scenes({ scenes, onRun, open, setOpen }) {
  return (
    <div className={`h3-scenes${open ? " is-open" : ""}`}>
      <AnimatePresence>
        {open && <motion.div className="h3-scene-list" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}>
          {scenes.map((s) => <button key={s.key} type="button" onClick={() => { onRun(s.key); setOpen(false); }}>{s.label}</button>)}
        </motion.div>}
      </AnimatePresence>
      <button type="button" className="h3-pill" onClick={() => setOpen(!open)} aria-expanded={open}>Scenes</button>
    </div>
  );
}

export function FloorSwitch({ floors, view, onHouse, onFloor }) {
  if (floors < 2) return null;
  const cur = view.mode === "room" ? null : view.floor;
  return (
    <div className="h3-floors" role="group" aria-label="Floors">
      <button type="button" className={cur === "all" ? "is-active" : ""} onClick={onHouse}>House</button>
      <button type="button" className={cur === 1 ? "is-active" : ""} onClick={() => onFloor(1)}>Upstairs</button>
      <button type="button" className={cur === 0 ? "is-active" : ""} onClick={() => onFloor(0)}>Downstairs</button>
    </div>
  );
}

export function Toast({ message }) {
  return <AnimatePresence>{message && <motion.div className="h3-toast" role="status" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>{message}</motion.div>}</AnimatePresence>;
}
