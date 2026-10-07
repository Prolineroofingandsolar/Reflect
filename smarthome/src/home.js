// Small helpers for reading Home Assistant entity state the way the 3D house shows it.
export const isOn = (e) => !!e && !["off", "unavailable", "unknown", "closed", "locked", "idle", "standby", "disarmed"].includes(String(e.state).toLowerCase());
export const lightLevel = (e) => (e?.domain === "light" || e?.domain === "switch") && isOn(e) ? (e.brightness != null ? Math.max(0.15, e.brightness / 255) : 1) : 0;
export const pct = (e) => e?.brightness != null ? Math.round(e.brightness / 2.55) : (isOn(e) ? 100 : 0);

// Light colour as [r,g,b] 0..1. White lights glow warm (the spec's "subtle warm orange"), tinted by colour temperature.
export function glow(e) {
  if (e?.rgb) return e.rgb.map((v) => v / 255);
  const k = e?.colorTemp;
  if (k) return k < 2800 ? [1, 0.62, 0.3] : k < 3600 ? [1, 0.72, 0.45] : k < 5000 ? [1, 0.86, 0.7] : [0.85, 0.92, 1];
  return [1, 0.66, 0.36];
}

// How a room should look: overall brightness and the mix of its lights' colours.
export function roomLight(list) {
  const lights = list.filter((e) => e.domain === "light");
  const lit = lights.filter((e) => lightLevel(e) > 0);
  if (!lit.length) return { level: 0, color: [1, 0.66, 0.36], on: 0, total: lights.length };
  const color = [0, 0, 0];
  let weight = 0;
  lit.forEach((e) => { const w = lightLevel(e); glow(e).forEach((c, i) => { color[i] += c * w; }); weight += w; });
  return { level: Math.min(1, weight / Math.max(1, Math.sqrt(lights.length))), color: color.map((c) => c / weight), on: lit.length, total: lights.length };
}

export const isDoorOrWindow = (e) => e.domain === "binary_sensor" && ["door", "window", "garage_door", "opening"].includes(e.deviceClass);

// The idle screen's readouts: security, indoor temperature, energy, and the bottom indicator row.
export function houseStatus(entities) {
  const lights = entities.filter((e) => e.domain === "light");
  const climates = entities.filter((e) => e.domain === "climate");
  const temps = entities.filter((e) => e.domain === "sensor" && e.deviceClass === "temperature" && /indoor|inside|living|hall|house|home|room/i.test(e.name) && !Number.isNaN(Number(e.state)));
  const indoor = temps.length ? temps.reduce((a, e) => a + Number(e.state), 0) / temps.length
    : climates.filter((c) => c.currentTemperature != null).reduce((a, c, _, arr) => a + c.currentTemperature / arr.length, 0) || null;
  const alarm = entities.find((e) => e.domain === "alarm_control_panel");
  const locks = entities.filter((e) => e.domain === "lock"), unlocked = locks.filter((l) => String(l.state).toLowerCase() !== "locked");
  const open = entities.filter((e) => (isDoorOrWindow(e) && isOn(e)) || (e.domain === "cover" && e.deviceClass === "garage" && isOn(e)));
  const power = entities.find((e) => e.domain === "sensor" && e.deviceClass === "power" && !Number.isNaN(Number(e.state)));
  const energy = power ? (Number(power.state) >= 1000 ? `${(Number(power.state) / 1000).toFixed(1)} kW` : `${Math.round(Number(power.state))} W`) : null;
  const security = alarm ? (String(alarm.state).startsWith("armed") ? "Armed" : alarm.state === "triggered" ? "Alarm!" : "Disarmed")
    : locks.length ? (unlocked.length ? `${unlocked.length} unlocked` : "Locked") : null;
  return {
    lightsOn: lights.filter(isOn).length, lights: lights.length,
    heating: climates.some((c) => c.hvacAction === "heating") ? "Heating" : climates.length ? "Idle" : null,
    security, secure: alarm ? String(alarm.state).startsWith("armed") : !unlocked.length,
    open: open.length, openNames: open.map((e) => e.name),
    indoor: indoor != null ? `${indoor.toFixed(1)}°` : null, energy
  };
}
