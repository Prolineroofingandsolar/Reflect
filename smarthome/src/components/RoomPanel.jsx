// <RoomPanel /> floats beside the focused room and lists its REAL devices from Home Assistant, grouped as
// Lights, Climate, Blinds, Media and Other. Nothing here is hard-coded: an empty group simply doesn't show.
import { motion } from "framer-motion";
import { bridge } from "../bridge.js";
import { isOn } from "../home.js";
import { floorName } from "../houseLayout.js";
import { ClimateControl, CoverControl, DeviceRow, LightControl, MediaControl } from "./Controls.jsx";

export const holo = {
  initial: { opacity: 0, clipPath: "inset(48% 0 48% 0)", filter: "brightness(2.2) blur(4px)" },
  animate: { opacity: 1, clipPath: "inset(0% 0 0% 0)", filter: "brightness(1) blur(0px)", transition: { duration: 0.55, ease: [0.2, 0.8, 0.2, 1] } },
  exit: { opacity: 0, clipPath: "inset(50% 0 50% 0)", filter: "brightness(2) blur(4px)", transition: { duration: 0.3 } }
};

function Section({ title, children }) { return <section className="h3-section"><h3>{title}</h3>{children}</section>; }

export function RoomPanel({ room, floors, entities, device, onSelectDevice, onClose, onError }) {
  const by = (fn) => entities.filter(fn);
  const lights = by((e) => e.domain === "light");
  const climate = by((e) => e.domain === "climate");
  const covers = by((e) => e.domain === "cover");
  const media = by((e) => e.domain === "media_player");
  const other = by((e) => !["light", "climate", "cover", "media_player", "camera"].includes(e.domain));
  const lit = lights.filter(isOn).length;
  const allOff = () => bridge.call(lit ? "light.turn_off" : "light.turn_on", { entity_id: lights.map((l) => l.id) }, { entityIds: lights.map((l) => l.id) }).catch((e) => onError(e.message));
  return (
    <motion.aside className="h3-panel h3-room-panel" {...holo} aria-label={`${room.label} controls`}>
      <header className="h3-panel-head">
        <div><p className="h3-eyebrow">{room.outdoor ? "Outside" : floors > 1 ? floorName(room.floor, floors) : "Home"}</p><h2>{room.label}</h2>
          <p className="h3-sub">{lights.length ? `${lit} of ${lights.length} light${lights.length === 1 ? "" : "s"} on` : `${entities.length} device${entities.length === 1 ? "" : "s"}`}</p></div>
        <button type="button" className="h3-close" onClick={onClose} aria-label="Back to the whole house">✕</button>
      </header>
      <div className="h3-panel-body">
        {!entities.length && <p className="h3-empty">No devices in this room yet. Add them to the {room.label} area in Home Assistant and they'll appear here.</p>}
        {lights.length > 0 && <Section title={<>Lights {lights.length > 1 && <button type="button" className="h3-small" onClick={allOff}>{lit ? "All off" : "All on"}</button>}</>}>
          {lights.map((e) => <LightControl key={e.id} entity={e} expanded={device === e.id} onSelect={() => onSelectDevice(device === e.id ? null : e.id)} onError={onError} />)}
        </Section>}
        {climate.length > 0 && <Section title="Climate">{climate.map((e) => <ClimateControl key={e.id} entity={e} onError={onError} />)}</Section>}
        {covers.length > 0 && <Section title="Blinds">{covers.map((e) => <CoverControl key={e.id} entity={e} onError={onError} />)}</Section>}
        {media.length > 0 && <Section title="Media">{media.map((e) => <MediaControl key={e.id} entity={e} onError={onError} />)}</Section>}
        {other.length > 0 && <Section title="Other devices">{other.map((e) => <DeviceRow key={e.id} entity={e} onError={onError} />)}</Section>}
      </div>
    </motion.aside>
  );
}
