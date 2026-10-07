// The mapping layer between Home Assistant and the 3D model.
//
//   model   Room_<key> groups with a <key>_room volume, <key>_dev_<slot> device anchors, <key>_furn_* furniture
//   config  house-map.json: which Home Assistant areas belong to each room, pinned device spots, cameras, scenes
//   result  every entity gets a room key and (where it makes sense) a device spot in the 3D room
import * as THREE from "three";

export const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Read the model once into plain data: rooms with their box, device anchors and baked-world geometry.
export function readModel(scene) {
  scene.updateMatrixWorld(true);
  const rooms = [], structure = [];
  const bake = (mesh) => mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  scene.traverse((o) => {
    if (o.name?.startsWith("Room_")) {
      const key = o.userData.key || o.name.slice(5);
      const room = { key, label: o.userData.label || key.replace(/_/g, " "), floor: Number(o.userData.floor || 0), outdoor: Boolean(o.userData.outdoor), devices: [], furniture: [] };
      o.traverse((m) => {
        if (!m.isMesh) return;
        const role = m.userData.role || (m.name.endsWith("_room") ? "room" : m.name.includes("_dev_") ? "device" : "furniture");
        if (role === "room") { room.geometry = bake(m); room.box = new THREE.Box3().setFromBufferAttribute(room.geometry.attributes.position); }
        else if (role === "device") {
          const geometry = bake(m); geometry.computeBoundingBox();
          const center = geometry.boundingBox.getCenter(new THREE.Vector3()), size = geometry.boundingBox.getSize(new THREE.Vector3());
          room.devices.push({ slot: m.userData.slot || m.name.split("_dev_")[1], kind: m.userData.kind || "generic", position: center.toArray(), size: size.toArray(), geometry });
        } else if (role === "structure") structure.push(bake(m));
        else room.furniture.push(bake(m));
      });
      if (room.box) { room.center = room.box.getCenter(new THREE.Vector3()).toArray(); rooms.push(room); }
    } else if (o.isMesh && o.name.startsWith("Structure_") && !o.parent?.name?.startsWith("Room_")) structure.push(bake(o));
  });
  const bounds = new THREE.Box3();
  rooms.filter((r) => !r.outdoor).forEach((r) => bounds.union(r.box));
  return { rooms, structure, bounds, floors: Math.max(...rooms.map((r) => r.floor)) + 1 };
}

// Which 3D room an entity belongs to, from its Home Assistant area.
export function roomFor(entity, model, config) {
  if (!entity.areaId && !entity.area) return null;
  const ids = [norm(entity.areaId), norm(entity.area)];
  for (const r of model.rooms) {
    const extra = (config?.rooms?.[r.key]?.areas || []).map(norm);
    if (ids.includes(r.key) || ids.includes(norm(r.label)) || ids.some((id) => extra.includes(id))) return r.key;
  }
  return null;
}

// Name rules for placing a device on a model spot when house-map.json doesn't pin it.
const RULES = [
  [/bedside.*left|left.*bedside/, "bedside_left"], [/bedside.*right|right.*bedside/, "bedside_right"],
  [/led|strip/, "led_strip"], [/wardrobe|closet/, "wardrobe"], [/pendant|island/, "pendant"], [/desk/, "desk_lamp"],
  [/mirror/, "mirror_light"], [/monitor|screen/, "monitor"], [/\btv\b|television/, "tv"], [/blind|curtain|shade|shutter/, "blinds"],
  [/speaker|sonos|echo|homepod|nest audio/, "speaker"], [/garage.*door|door.*garage/, "garage_door"], [/front.*door|door.*front|doorbell/, "front_door"],
  [/wash|dryer|laundry/, "washer"], [/charg|ev\b/, "charger"], [/fan|extract/, "fan"], [/path/, "path_lights"], [/sprinkler|irrigation/, "sprinkler"],
  [/camera/, "camera"], [/thermostat|heating|radiator|trv/, "thermostat"], [/kettle|coffee|oven|fridge|dishwasher|appliance/, "appliance"],
  [/garden/, "garden_lights"], [/ceiling|main|downlight|spot|overhead/, "ceiling_light"], [/lamp/, "lamp"]
];
const KIND_FOR_DOMAIN = { light: ["ceiling", "lamp", "pendant", "strip"], climate: ["thermostat"], cover: ["blinds", "door"], media_player: ["tv", "speaker"], switch: ["plug", "appliance", "lamp"], fan: ["fan"], camera: ["camera"], lock: ["door"] };
const SHOWN_IN_3D = new Set(["light", "climate", "cover", "media_player", "switch", "fan", "camera", "lock"]);

// Place every entity: room key, plus a device spot (model anchor, or an automatic spot in the room).
export function placeEntities(entities, model, config) {
  const placed = new Map();
  const byRoom = new Map(model.rooms.map((r) => [r.key, []]));
  for (const e of entities) {
    const key = roomFor(e, model, config);
    if (key) byRoom.get(key).push(e);
    placed.set(e.id, { room: key, spot: null });
  }
  for (const room of model.rooms) {
    const list = byRoom.get(room.key), free = new Map(room.devices.map((d) => [d.slot, d]));
    const pins = config?.rooms?.[room.key]?.devices || {};
    const take = (e, slot) => { const d = free.get(slot); if (!d) return false; free.delete(slot); placed.get(e.id).spot = d; return true; };
    const visible = list.filter((e) => SHOWN_IN_3D.has(e.domain));
    // Pinned first, then name rules, then any free anchor of a fitting kind, then an automatic spot.
    const rest = visible.filter((e) => !(pins[e.id] && take(e, pins[e.id])));
    const rest2 = rest.filter((e) => { const name = `${e.name} ${e.id}`.toLowerCase(); const hit = RULES.find(([re, slot]) => re.test(name) && free.has(slot)); return !(hit && take(e, hit[1])); });
    let auto = 0;
    for (const e of rest2) {
      const kinds = KIND_FOR_DOMAIN[e.domain] || [];
      const d = [...free.values()].find((x) => kinds.includes(x.kind));
      if (d) { take(e, d.slot); continue; }
      const b = room.box, n = auto++, cols = 3, fx = 0.25 + (n % cols) * 0.25, fz = 0.3 + Math.floor(n / cols) * 0.2;
      const y = e.domain === "light" ? b.max.y - 0.15 : b.min.y + 1;
      placed.get(e.id).spot = { slot: `auto_${n}`, kind: e.domain === "light" ? "ceiling" : "generic", position: [b.min.x + (b.max.x - b.min.x) * fx, y, b.min.z + (b.max.z - b.min.z) * Math.min(0.9, fz)], size: [0.3, 0.3, 0.3] };
    }
  }
  return placed;
}
