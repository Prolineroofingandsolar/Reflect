// Builds the starter house model (models/house.glb) for the 3D Smart Home screen.
// Run with: npm run house   (from the smarthome folder)
//
// Node names are the contract between the model and the app, so a custom model of your own house
// (made in Blender, SketchUp, etc.) works as long as it follows the same naming:
//
//   Room_<key>                     a group per room, e.g. Room_bedroom
//     <key>_room                   the room's volume (a box from floor to ceiling), used for outline and glow
//     <key>_dev_<slot>             a device anchor, e.g. bedroom_dev_ceiling_light, bedroom_dev_tv
//     <key>_furn_<name>            furniture, drawn as faint hologram detail
//   Structure_*                    roof, slabs, stairs, fence... drawn as the house shell
//
// Each Room_ group carries extras: { key, label, floor }. Devices carry { slot, kind }.
// house-map.json links Home Assistant areas and entities to these names.
import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// GLTFExporter reads Blobs through FileReader, which Node doesn't have.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then((b) => { this.result = b; this.onloadend?.(); this.onload?.({ target: this }); }); }
  readAsDataURL(blob) { blob.arrayBuffer().then((b) => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString("base64")}`; this.onloadend?.(); this.onload?.({ target: this }); }); }
};

const FLOOR = 3, CEIL = 2.7;
const mat = new THREE.MeshStandardMaterial({ color: 0x56d8ff });
const scene = new THREE.Scene();
const house = new THREE.Group(); house.name = "House"; scene.add(house);

const box = (name, w, h, d, x, y, z, parent) => {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.name = name; m.position.set(x, y, z); parent.add(m); return m;
};
const cyl = (name, r, h, x, y, z, parent, segs = 16) => {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segs), mat);
  m.name = name; m.position.set(x, y, z); parent.add(m); return m;
};

// Rooms: x/z extents in metres, front of the house faces +z.
const rooms = [
  { key: "living_room", label: "Living Room", floor: 0, x: [-6, -1.5], z: [-0.5, 4] },
  { key: "hallway", label: "Hallway", floor: 0, x: [-1.5, 1], z: [-0.5, 4] },
  { key: "gym", label: "Gym", floor: 0, x: [1, 6], z: [-0.5, 4] },
  { key: "kitchen", label: "Kitchen", floor: 0, x: [-6, 2.5], z: [-4, -0.5] },
  { key: "utility", label: "Utility", floor: 0, x: [2.5, 6], z: [-4, -0.5] },
  { key: "garage", label: "Garage", floor: 0, x: [6.3, 10.8], z: [-4, 4], height: 2.6 },
  { key: "bedroom", label: "Bedroom", floor: 1, x: [-6, -1.5], z: [-0.5, 4] },
  { key: "ensuite", label: "Ensuite", floor: 1, x: [-6, -3], z: [-4, -0.5] },
  { key: "bathroom", label: "Bathroom", floor: 1, x: [-3, 0], z: [-4, -0.5] },
  { key: "guest_room", label: "Guest Room", floor: 1, x: [1.5, 6], z: [-0.5, 4] },
  { key: "office", label: "Office", floor: 1, x: [1.5, 6], z: [-4, -0.5] },
  { key: "garden", label: "Garden", floor: 0, x: [-6, 10.8], z: [-12, -4.4], outdoor: true }
];

// Device anchors and furniture, positioned as fractions of the room (fx, fz across the floor, y above it).
const kit = {
  living_room: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.12, 0.85, "lamp"], ["tv", 0.5, 0.04, "tv"], ["speaker", 0.85, 0.06, "speaker"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.5, "thermostat"], ["led_strip", 0.5, 0.08, "strip"]],
    furn: [["sofa", 0.5, 0.75, 2.4, 0.8, 0.9], ["coffee_table", 0.5, 0.45, 1.1, 0.4, 0.6], ["tv_unit", 0.5, 0.06, 1.8, 0.45, 0.4]] },
  hallway: { dev: [["ceiling_light", 0.5, 0.6, "ceiling"], ["front_door", 0.6, 1.0, "door"], ["thermostat", 0.02, 0.5, "thermostat"], ["sensor", 0.98, 0.9, "sensor"]], furn: [], stairs: true },
  gym: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["speaker", 0.9, 0.1, "speaker"], ["tv", 0.5, 0.04, "tv"], ["blinds", 0.5, 0.99, "blinds"]],
    furn: [["treadmill", 0.25, 0.5, 0.8, 1.2, 1.9], ["bench", 0.7, 0.55, 0.5, 0.5, 1.4], ["rack", 0.85, 0.2, 1.2, 1.4, 0.5]] },
  kitchen: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["pendant", 0.5, 0.55, "pendant"], ["appliance", 0.2, 0.08, "appliance"], ["speaker", 0.9, 0.08, "speaker"], ["blinds", 0.5, 0.01, "blinds"]],
    furn: [["counter", 0.5, 0.08, 6.5, 0.9, 0.6], ["island", 0.5, 0.55, 2.2, 0.9, 0.9], ["table", 0.12, 0.6, 1.2, 0.75, 0.9]] },
  utility: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["washer", 0.3, 0.12, "appliance"], ["plug", 0.7, 0.05, "plug"]],
    furn: [["washer_body", 0.3, 0.12, 0.6, 0.85, 0.6], ["dryer", 0.55, 0.12, 0.6, 0.85, 0.6], ["sink", 0.85, 0.12, 0.8, 0.9, 0.5]] },
  garage: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["garage_door", 0.5, 1.0, "door"], ["charger", 0.95, 0.3, "plug"]],
    furn: [["car", 0.5, 0.55, 1.9, 1.4, 4.4], ["shelves", 0.08, 0.2, 0.4, 1.8, 2]] },
  bedroom: { dev: [["ceiling_light", 0.5, 0.45, "ceiling"], ["bedside_left", 0.2, 0.12, "lamp"], ["bedside_right", 0.8, 0.12, "lamp"], ["led_strip", 0.5, 0.03, "strip"], ["wardrobe", 0.06, 0.75, "cabinet"], ["tv", 0.5, 0.97, "tv"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.4, "thermostat"], ["speaker", 0.9, 0.85, "speaker"]],
    furn: [["bed", 0.5, 0.3, 2.0, 0.55, 2.2], ["side_table_left", 0.2, 0.08, 0.5, 0.5, 0.45], ["side_table_right", 0.8, 0.08, 0.5, 0.5, 0.45], ["wardrobe_body", 0.06, 0.75, 0.6, 2.1, 1.6]] },
  ensuite: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["mirror_light", 0.5, 0.05, "strip"], ["fan", 0.85, 0.85, "fan"]],
    furn: [["shower", 0.2, 0.25, 0.9, 2.0, 0.9], ["basin", 0.6, 0.1, 0.7, 0.85, 0.45], ["toilet", 0.85, 0.15, 0.4, 0.45, 0.65]] },
  bathroom: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["mirror_light", 0.7, 0.05, "strip"], ["fan", 0.15, 0.15, "fan"], ["speaker", 0.9, 0.9, "speaker"]],
    furn: [["bath", 0.3, 0.6, 0.8, 0.55, 1.7], ["basin", 0.7, 0.1, 0.7, 0.85, 0.45], ["toilet", 0.85, 0.6, 0.4, 0.45, 0.65]] },
  guest_room: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.2, 0.12, "lamp"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.4, "thermostat"]],
    furn: [["bed", 0.45, 0.3, 1.5, 0.5, 2.0], ["side_table", 0.15, 0.1, 0.45, 0.5, 0.4], ["chest", 0.85, 0.85, 1.0, 0.9, 0.5]] },
  office: { dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["desk_lamp", 0.35, 0.2, "lamp"], ["monitor", 0.5, 0.15, "tv"], ["speaker", 0.75, 0.12, "speaker"], ["blinds", 0.5, 0.01, "blinds"], ["plug", 0.9, 0.1, "plug"]],
    furn: [["desk", 0.5, 0.18, 1.8, 0.75, 0.8], ["chair", 0.5, 0.4, 0.6, 1.0, 0.6], ["bookcase", 0.95, 0.6, 0.4, 2.0, 1.6]] },
  garden: { dev: [["garden_lights", 0.3, 0.6, "lamp"], ["path_lights", 0.7, 0.9, "lamp"], ["camera", 0.95, 0.98, "camera"], ["sprinkler", 0.5, 0.4, "plug"]],
    furn: [["patio", 0.25, 0.85, 4.5, 0.05, 2.5], ["tree_a", 0.12, 0.25, 1.8, 3.2, 1.8], ["tree_b", 0.85, 0.3, 2.2, 3.8, 2.2], ["shed", 0.92, 0.12, 2.0, 2.0, 1.6], ["table", 0.25, 0.85, 1.2, 0.75, 0.8]] }
};
const devHeight = { ceiling: CEIL - 0.08, pendant: CEIL - 0.6, lamp: 0.75, tv: 1.2, speaker: 0.9, blinds: 1.6, thermostat: 1.5, strip: 0.3, door: 1.0, sensor: 2.2, appliance: 1.0, plug: 0.35, cabinet: 1.2, fan: CEIL - 0.1, camera: 2.4 };

const roomsGroup = new THREE.Group(); roomsGroup.name = "Rooms"; house.add(roomsGroup);
for (const r of rooms) {
  const g = new THREE.Group(); g.name = `Room_${r.key}`;
  g.userData = { key: r.key, label: r.label, floor: r.floor, outdoor: Boolean(r.outdoor) };
  roomsGroup.add(g);
  const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0], y0 = r.floor * FLOOR, h = r.outdoor ? 0.04 : (r.height || CEIL);
  const cx = (r.x[0] + r.x[1]) / 2, cz = (r.z[0] + r.z[1]) / 2;
  box(`${r.key}_room`, w, h, d, cx, y0 + h / 2, cz, g).userData = { role: "room" };
  const at = (fx, fz) => [r.x[0] + w * fx, r.z[0] + d * fz];
  for (const [slot, fx, fz, kind] of kit[r.key].dev) {
    const [x, z] = at(fx, fz), y = y0 + (r.outdoor ? (kind === "camera" ? 2.4 : 0.5) : devHeight[kind]);
    const m = kind === "tv" ? box(`${r.key}_dev_${slot}`, 1.1, 0.65, 0.06, x, y, z, g)
      : kind === "blinds" ? box(`${r.key}_dev_${slot}`, Math.min(2.2, w * 0.5), 1.4, 0.04, x, y, z, g)
      : kind === "strip" ? box(`${r.key}_dev_${slot}`, Math.min(2.4, w * 0.6), 0.04, 0.04, x, y, z, g)
      : kind === "door" ? box(`${r.key}_dev_${slot}`, r.key === "garage" ? 3.2 : 1.0, r.key === "garage" ? 2.2 : 2.1, 0.06, x, y0 + (r.key === "garage" ? 1.1 : 1.05), z, g)
      : kind === "ceiling" ? cyl(`${r.key}_dev_${slot}`, 0.22, 0.05, x, y, z, g)
      : kind === "lamp" ? cyl(`${r.key}_dev_${slot}`, 0.14, 0.3, x, y, z, g)
      : box(`${r.key}_dev_${slot}`, 0.22, 0.22, 0.22, x, y, z, g);
    m.userData = { role: "device", slot, kind };
  }
  for (const [name, fx, fz, fw, fh, fd] of kit[r.key].furn) {
    const [x, z] = at(fx, fz);
    const m = name.startsWith("tree") ? cyl(`${r.key}_furn_${name}`, fw / 2, fh, x, y0 + fh / 2, z, g, 6) : box(`${r.key}_furn_${name}`, Math.min(fw, w * 0.95), fh, Math.min(fd, d * 0.95), x, y0 + fh / 2, z, g);
    m.userData = { role: "furniture" };
  }
  if (kit[r.key].stairs) {
    for (let i = 0; i < 14; i++) box(`Structure_stair_${i}`, 1.0, 0.2, 0.3, r.x[0] + 0.6, y0 + 0.1 + i * (FLOOR / 14), r.z[1] - 0.4 - i * 0.28, g).userData = { role: "structure" };
  }
}

// Shell: floor slabs, landing, gable roof (as thin planes), garage roof and the garden fence.
const shell = new THREE.Group(); shell.name = "Structure"; house.add(shell);
box("Structure_slab_ground", 12.2, 0.12, 8.2, 0, -0.06, 0, shell);
box("Structure_slab_first", 12.2, 0.12, 8.2, 0, FLOOR - 0.06, 0, shell);
box("Structure_slab_garage", 4.6, 0.12, 8.2, 8.55, -0.06, 0, shell);
box("Structure_landing", 3, 0.04, 4.5, 0, FLOOR + 0.02, 1.75, shell);
const eaves = 2 * FLOOR, ridge = eaves + 2.6, run = 4.3, slope = Math.hypot(run, ridge - eaves), ang = Math.atan2(ridge - eaves, run);
for (const side of [1, -1]) {
  const p = box(`Structure_roof_${side > 0 ? "front" : "back"}`, 12.8, 0.08, slope, 0, (eaves + ridge) / 2, side * run / 2, shell);
  p.rotation.x = side * ang;
}
for (const side of [1, -1]) {
  const tri = new THREE.Shape([new THREE.Vector2(-4.1, 0), new THREE.Vector2(4.1, 0), new THREE.Vector2(0, ridge - eaves)]);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(tri), mat); m.name = `Structure_gable_${side > 0 ? "east" : "west"}`;
  m.rotation.y = Math.PI / 2; m.position.set(side * 6, eaves, 0); shell.add(m);
}
box("Structure_chimney", 0.7, 1.6, 0.7, 3.2, ridge - 0.3, -1.2, shell);
box("Structure_garage_roof", 4.8, 0.1, 8.4, 8.55, 2.7, 0, shell);
for (const [w, d, x, z] of [[16.8, 0.05, 2.4, -12], [0.05, 7.6, -6, -8.2], [0.05, 7.6, 10.8, -8.2]]) box(`Structure_fence_${x}_${z}`, w, 1.1, d, x, 0.55, z, shell);
shell.children.forEach((m) => { m.userData = { role: "structure" }; });

const exporter = new GLTFExporter();
const glb = await exporter.parseAsync(scene, { binary: true });
const out = fileURLToPath(new URL("../models/house.glb", import.meta.url));
writeFileSync(out, Buffer.from(glb));
console.log(`Wrote ${out} (${Math.round(glb.byteLength / 1024)} KB, ${rooms.length} rooms)`);
