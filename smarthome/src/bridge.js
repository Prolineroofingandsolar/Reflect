// The 3D House talks to the rest of the mirror through window.ReflectBridge (set up in app.js):
// live Home Assistant entities, service calls, weather and screen switching. Keeping it behind this
// one file means the React code never reaches into app.js globals directly.
import { useSyncExternalStore } from "react";

const B = () => window.ReflectBridge || null;
let version = 0;
const subs = new Set();
let hooked = false;

function hook() {
  if (hooked || !B()) return;
  hooked = true;
  B().onChange(() => { version++; subs.forEach((fn) => fn()); });
}

export function useEntities() {
  useSyncExternalStore((fn) => { hook(); subs.add(fn); return () => subs.delete(fn); }, () => version);
  return B()?.entities() || [];
}
export const bridge = {
  connected: () => Boolean(B()?.connected()),
  live: () => Boolean(B()?.live()),
  weather: () => B()?.weather() || { data: null, place: "", label: () => "" },
  showView: (name) => B()?.showView(name),
  connect: () => B()?.connect(),
  lightOptions: (domain, input) => B()?.lightOptions(domain, input) || {},
  // Every control goes through here, so voice and touch both end in the same Home Assistant service call.
  async call(service, data, highlight) {
    if (!B()) throw new Error("The mirror isn't ready yet.");
    await B().call(service, data);
    window.dispatchEvent(new CustomEvent("reflect:home-action", { detail: highlight || { entityIds: [].concat(data.entity_id || []), areaIds: [].concat(data.area_id || []) } }));
  }
};
