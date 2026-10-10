// A house layout is plain data the builder edits and the 3D house is generated from:
//
//   { version: 1, floors: 2,
//     rooms: [{ key, type, label, floor, x: [x0, x1], z: [z0, z1], points?: [[x, z], ...] }],
//     stairs: [{ key, floor, x: [x0, x1], z: [z0, z1], dir: "n" | "s" | "e" | "w" }] }
//
// A room is a rectangle (x/z) unless it has points, which make it any shape (an L-shaped garden, a
// kitchen with a bay); x/z are then its bounding box. Stairs start on their floor and go up towards dir
// (n = towards the back of the house, s = the front, w = left, e = right).
//
// Sizes are metres. On the plan, x runs left to right and z runs from the back of the house (top) to the
// front (bottom). Room types decide the furniture and device spots drawn in 3D; the label is what the room
// is called, and it is matched against Home Assistant area names, so naming a room like its area links it.

export const GRID = 0.5;
export const MAX_ROOMS = 40;
export const MAX_FLOORS = 4;

// Room types: label, whether it is outside, a default size (w x d), and which device spots and furniture it gets.
// Device spots: [slot, fx, fz, kind] with fx/fz as fractions across the room. Furniture: [name, fx, fz, w, h, d].
export const ROOM_TYPES = {
  living_room: { label: "Living Room", size: [4.5, 4.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.12, 0.85, "lamp"], ["tv", 0.5, 0.04, "tv"], ["speaker", 0.85, 0.06, "speaker"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.5, "thermostat"], ["led_strip", 0.5, 0.08, "strip"]],
    furn: [["sofa", 0.5, 0.75, 2.4, 0.8, 0.9], ["coffee_table", 0.5, 0.45, 1.1, 0.4, 0.6], ["tv_unit", 0.5, 0.06, 1.8, 0.45, 0.4]] },
  kitchen: { label: "Kitchen", size: [4.5, 3.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["pendant", 0.5, 0.55, "pendant"], ["appliance", 0.2, 0.08, "appliance"], ["speaker", 0.9, 0.08, "speaker"], ["blinds", 0.5, 0.01, "blinds"], ["thermostat", 0.98, 0.5, "thermostat"]],
    furn: [["counter", 0.5, 0.08, 6.5, 0.9, 0.6], ["island", 0.5, 0.55, 2.2, 0.9, 0.9]] },
  dining_room: { label: "Dining Room", size: [4, 3.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["pendant", 0.5, 0.5, "pendant"], ["lamp", 0.1, 0.1, "lamp"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.5, "thermostat"]],
    furn: [["table", 0.5, 0.5, 1.8, 0.75, 1.0], ["sideboard", 0.5, 0.06, 1.6, 0.8, 0.45]] },
  bedroom: { label: "Bedroom", size: [4, 4],
    dev: [["ceiling_light", 0.5, 0.45, "ceiling"], ["bedside_left", 0.2, 0.12, "lamp"], ["bedside_right", 0.8, 0.12, "lamp"], ["led_strip", 0.5, 0.03, "strip"], ["wardrobe", 0.06, 0.75, "cabinet"], ["tv", 0.5, 0.97, "tv"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.4, "thermostat"], ["speaker", 0.9, 0.85, "speaker"]],
    furn: [["bed", 0.5, 0.3, 2.0, 0.55, 2.2], ["side_table_left", 0.2, 0.08, 0.5, 0.5, 0.45], ["side_table_right", 0.8, 0.08, 0.5, 0.5, 0.45], ["wardrobe_body", 0.06, 0.75, 0.6, 2.1, 1.6]] },
  guest_room: { label: "Guest Room", size: [3.5, 3.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.2, 0.12, "lamp"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.4, "thermostat"]],
    furn: [["bed", 0.45, 0.3, 1.5, 0.5, 2.0], ["side_table", 0.15, 0.1, 0.45, 0.5, 0.4], ["chest", 0.85, 0.85, 1.0, 0.9, 0.5]] },
  kids_room: { label: "Kids' Room", size: [3, 3.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["night_light", 0.2, 0.15, "lamp"], ["blinds", 0.5, 0.99, "blinds"], ["thermostat", 0.98, 0.4, "thermostat"]],
    furn: [["bed", 0.3, 0.3, 1.0, 0.5, 2.0], ["toy_box", 0.8, 0.8, 0.9, 0.5, 0.5], ["desk", 0.8, 0.15, 1.0, 0.7, 0.5]] },
  bathroom: { label: "Bathroom", size: [3, 3],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["mirror_light", 0.7, 0.05, "strip"], ["fan", 0.15, 0.15, "fan"], ["speaker", 0.9, 0.9, "speaker"]],
    furn: [["bath", 0.3, 0.6, 0.8, 0.55, 1.7], ["basin", 0.7, 0.1, 0.7, 0.85, 0.45], ["toilet", 0.85, 0.6, 0.4, 0.45, 0.65]] },
  ensuite: { label: "Ensuite", size: [2.5, 2.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["mirror_light", 0.5, 0.05, "strip"], ["fan", 0.85, 0.85, "fan"]],
    furn: [["shower", 0.2, 0.25, 0.9, 2.0, 0.9], ["basin", 0.6, 0.1, 0.7, 0.85, 0.45], ["toilet", 0.85, 0.15, 0.4, 0.45, 0.65]] },
  toilet: { label: "Toilet", size: [1.5, 2],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["fan", 0.5, 0.1, "fan"]],
    furn: [["toilet", 0.5, 0.25, 0.4, 0.45, 0.65], ["basin", 0.5, 0.85, 0.5, 0.85, 0.35]] },
  hallway: { label: "Hallway", size: [2.5, 4.5], stairs: true,
    dev: [["ceiling_light", 0.5, 0.6, "ceiling"], ["front_door", 0.6, 1.0, "door"], ["thermostat", 0.02, 0.5, "thermostat"], ["sensor", 0.98, 0.9, "sensor"]], furn: [] },
  landing: { label: "Landing", size: [2.5, 4], stairs: true,
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["sensor", 0.98, 0.9, "sensor"]], furn: [] },
  office: { label: "Office", size: [3.5, 3],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["desk_lamp", 0.35, 0.2, "lamp"], ["monitor", 0.5, 0.15, "tv"], ["speaker", 0.75, 0.12, "speaker"], ["blinds", 0.5, 0.01, "blinds"], ["plug", 0.9, 0.1, "plug"]],
    furn: [["desk", 0.5, 0.18, 1.8, 0.75, 0.8], ["chair", 0.5, 0.4, 0.6, 1.0, 0.6], ["bookcase", 0.95, 0.6, 0.4, 2.0, 1.6]] },
  utility: { label: "Utility", size: [2.5, 3],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["washer", 0.3, 0.12, "appliance"], ["plug", 0.7, 0.05, "plug"]],
    furn: [["washer_body", 0.3, 0.12, 0.6, 0.85, 0.6], ["dryer", 0.55, 0.12, 0.6, 0.85, 0.6], ["sink", 0.85, 0.12, 0.8, 0.9, 0.5]] },
  conservatory: { label: "Conservatory", size: [4, 3],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.15, 0.2, "lamp"], ["blinds", 0.5, 0.01, "blinds"], ["thermostat", 0.98, 0.5, "thermostat"]],
    furn: [["sofa", 0.5, 0.7, 2.0, 0.8, 0.85], ["plant", 0.1, 0.85, 0.5, 1.2, 0.5], ["table", 0.5, 0.35, 0.8, 0.45, 0.8]] },
  playroom: { label: "Playroom", size: [3.5, 3.5],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.15, 0.15, "lamp"], ["tv", 0.5, 0.04, "tv"], ["speaker", 0.85, 0.06, "speaker"]],
    furn: [["toy_box", 0.2, 0.8, 1.0, 0.5, 0.5], ["beanbag", 0.6, 0.6, 0.9, 0.6, 0.9]] },
  gym: { label: "Gym", size: [4, 4],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["speaker", 0.9, 0.1, "speaker"], ["tv", 0.5, 0.04, "tv"], ["blinds", 0.5, 0.99, "blinds"]],
    furn: [["treadmill", 0.25, 0.5, 0.8, 1.2, 1.9], ["bench", 0.7, 0.55, 0.5, 0.5, 1.4], ["rack", 0.85, 0.2, 1.2, 1.4, 0.5]] },
  garage: { label: "Garage", size: [3.5, 6],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["garage_door", 0.5, 1.0, "door"], ["charger", 0.95, 0.3, "plug"]],
    furn: [["car", 0.5, 0.55, 1.9, 1.4, 4.4], ["shelves", 0.08, 0.2, 0.4, 1.8, 2]] },
  other: { label: "Room", size: [3, 3],
    dev: [["ceiling_light", 0.5, 0.5, "ceiling"], ["lamp", 0.15, 0.15, "lamp"], ["plug", 0.9, 0.1, "plug"], ["thermostat", 0.98, 0.5, "thermostat"]], furn: [] },
  garden: { label: "Garden", size: [12, 8], outdoor: true,
    dev: [["garden_lights", 0.3, 0.6, "lamp"], ["path_lights", 0.7, 0.9, "lamp"], ["camera", 0.95, 0.98, "camera"], ["sprinkler", 0.5, 0.4, "plug"]],
    furn: [["patio", 0.25, 0.85, 4.5, 0.05, 2.5], ["tree_a", 0.12, 0.25, 1.8, 3.2, 1.8], ["tree_b", 0.85, 0.3, 2.2, 3.8, 2.2], ["shed", 0.92, 0.12, 2.0, 2.0, 1.6]] },
  driveway: { label: "Driveway", size: [4, 6], outdoor: true,
    dev: [["camera", 0.95, 0.05, "camera"], ["drive_lights", 0.05, 0.5, "lamp"], ["charger", 0.95, 0.5, "plug"]],
    furn: [["car", 0.5, 0.5, 1.9, 1.4, 4.4]] }
};
export const typeOf = (t) => ROOM_TYPES[t] || ROOM_TYPES.other;
export const floorName = (f, floors) => floors === 2 ? (f ? "Upstairs" : "Downstairs") : ["Ground floor", "First floor", "Second floor", "Third floor"][f] || `Floor ${f + 1}`;

const R = (type, label, floor, x, z, key) => ({ key: key || type, type, label, floor, x, z });

// Starting points; everyone can then drag, resize, rename, add and remove rooms.
export const TEMPLATES = [
  { key: "flat", label: "Flat", note: "One floor, one bedroom", layout: { version: 1, floors: 1, rooms: [
    R("living_room", "Living Room", 0, [-4, 0.5], [-2, 2.5]), R("kitchen", "Kitchen", 0, [0.5, 4], [-2, 0.5]),
    R("hallway", "Hallway", 0, [0.5, 4], [0.5, 2.5]), R("bedroom", "Bedroom", 0, [-4, 0], [-5.5, -2]), R("bathroom", "Bathroom", 0, [0, 2.5], [-5.5, -2])] } },
  { key: "bungalow", label: "Bungalow", note: "One floor, two bedrooms and a garden", layout: { version: 1, floors: 1, rooms: [
    R("living_room", "Living Room", 0, [-6, -1.5], [0, 4]), R("hallway", "Hallway", 0, [-1.5, 1], [0, 4]), R("bedroom", "Bedroom", 0, [1, 5.5], [0, 4]),
    R("kitchen", "Kitchen", 0, [-6, -1.5], [-3.5, 0]), R("bathroom", "Bathroom", 0, [-1.5, 1.5], [-3.5, 0]), R("guest_room", "Second Bedroom", 0, [1.5, 5.5], [-3.5, 0]),
    R("garden", "Garden", 0, [-6, 5.5], [-11, -4])] } },
  { key: "semi", label: "Three-bed house", note: "Two floors, garden", layout: { version: 1, floors: 2, rooms: [
    R("living_room", "Living Room", 0, [-4.5, 0], [-0.5, 4]), R("hallway", "Hallway", 0, [0, 2.5], [-0.5, 4]), R("kitchen", "Kitchen", 0, [-4.5, 2.5], [-4, -0.5]),
    R("bedroom", "Bedroom", 1, [-4.5, 0], [-0.5, 4]), R("landing", "Landing", 1, [0, 2.5], [-0.5, 4]), R("guest_room", "Second Bedroom", 1, [-4.5, -1.5], [-4, -0.5], "guest_room"),
    R("kids_room", "Third Bedroom", 1, [-1.5, 0.5], [-4, -0.5]), R("bathroom", "Bathroom", 1, [0.5, 2.5], [-4, -0.5]),
    R("garden", "Garden", 0, [-4.5, 2.5], [-11, -4.5])] } },
  { key: "detached", label: "Four-bed house", note: "Two floors, garage, gym, garden", layout: { version: 1, floors: 2, rooms: [
    R("living_room", "Living Room", 0, [-6, -1.5], [-0.5, 4]), R("hallway", "Hallway", 0, [-1.5, 1], [-0.5, 4]), R("gym", "Gym", 0, [1, 6], [-0.5, 4]),
    R("kitchen", "Kitchen", 0, [-6, 2.5], [-4, -0.5]), R("utility", "Utility", 0, [2.5, 6], [-4, -0.5]), R("garage", "Garage", 0, [6.5, 10.5], [-4, 4]),
    R("bedroom", "Bedroom", 1, [-6, -1.5], [-0.5, 4]), R("landing", "Landing", 1, [-1.5, 1.5], [-0.5, 4]), R("ensuite", "Ensuite", 1, [-6, -3], [-4, -0.5]), R("bathroom", "Bathroom", 1, [-3, 0], [-4, -0.5]),
    R("guest_room", "Guest Room", 1, [1.5, 6], [-0.5, 4]), R("office", "Office", 1, [0, 6], [-4, -0.5]),
    R("garden", "Garden", 0, [-6, 10.5], [-12, -4.5])] } }
];
export const MAX_STAIRS = 8, MAX_POINTS = 24;

const snap = (v) => Math.round(v / GRID) * GRID;
const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
export const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "room";

// A unique key for a new room of this type ("bedroom", then "bedroom_2"...).
export function newKey(type, rooms) {
  const used = new Set(rooms.map((r) => r.key));
  if (!used.has(type)) return type;
  for (let i = 2; ; i++) if (!used.has(`${type}_${i}`)) return `${type}_${i}`;
}

// Geometry helpers shared by the builder and the 3D generator.
export const roomPoly = (r) => r.points || [[r.x[0], r.z[0]], [r.x[1], r.z[0]], [r.x[1], r.z[1]], [r.x[0], r.z[1]]];
export const bboxOf = (pts) => ({ x: [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))], z: [Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))] });
export function pointIn(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
// The point inside a room nearest to (x, z): used to keep labels and devices inside odd-shaped rooms.
export function insidePoint(poly, x, z) {
  if (pointIn(poly, x, z)) return [x, z];
  const b = bboxOf(poly); let best = null, bd = Infinity;
  for (let px = b.x[0] + 0.25; px < b.x[1]; px += 0.25) for (let pz = b.z[0] + 0.25; pz < b.z[1]; pz += 0.25) {
    if (!pointIn(poly, px, pz)) continue;
    const d = (px - x) ** 2 + (pz - z) ** 2; if (d < bd) { bd = d; best = [px, pz]; }
  }
  return best || [x, z];
}
// Do two rooms on the same floor share floor space? (Sampled on a 25 cm grid, so any shape works.)
export function roomsOverlap(a, b) {
  const x0 = Math.max(a.x[0], b.x[0]), x1 = Math.min(a.x[1], b.x[1]), z0 = Math.max(a.z[0], b.z[0]), z1 = Math.min(a.z[1], b.z[1]);
  if (x1 - x0 <= 0.01 || z1 - z0 <= 0.01) return false;
  if (!a.points && !b.points) return true;
  const pa = roomPoly(a), pb = roomPoly(b);
  for (let x = x0 + 0.125; x < x1; x += 0.25) for (let z = z0 + 0.125; z < z1; z += 0.25) if (pointIn(pa, x, z) && pointIn(pb, x, z)) return true;
  return false;
}

// Stairs for layouts made before stairs could be placed: one flight in each hallway/landing with a floor above.
function defaultStairs(rooms) {
  const top = Math.max(0, ...rooms.filter((r) => !typeOf(r.type).outdoor).map((r) => r.floor));
  return rooms.filter((r) => typeOf(r.type).stairs && r.floor < top).map((r, i) => {
    const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0];
    if (d >= w) { const L = Math.max(2, Math.min(4, snap(d - 0.5))); return { key: `stairs_${i + 1}`, floor: r.floor, x: [r.x[0], r.x[0] + 1], z: [r.z[1] - 0.5 - L, r.z[1] - 0.5], dir: "n" }; }
    const L = Math.max(2, Math.min(4, snap(w - 0.5))); return { key: `stairs_${i + 1}`, floor: r.floor, x: [r.x[0] + 0.5, r.x[0] + 0.5 + L], z: [r.z[0], r.z[0] + 1], dir: "e" };
  });
}

// Anything loaded (saved, or from an older version) is cleaned before it is drawn.
export function cleanLayout(input) {
  if (!input || !Array.isArray(input.rooms)) return null;
  const rooms = [], used = new Set();
  for (const r of input.rooms.slice(0, MAX_ROOMS)) {
    if (!r || typeof r !== "object") continue;
    const type = ROOM_TYPES[r.type] ? r.type : "other";
    let key = slug(r.key || type); while (used.has(key)) key = `${key}_x`; used.add(key);
    const room = { key, type, label: String(r.label || typeOf(type).label).slice(0, 30), floor: ROOM_TYPES[type]?.outdoor ? 0 : Math.round(clampN(r.floor, 0, MAX_FLOORS - 1)), x: span(r.x), z: span(r.z) };
    const pts = cleanPoints(r.points);
    if (pts) { const b = bboxOf(pts); Object.assign(room, { points: pts, x: b.x, z: b.z }); }
    rooms.push(room);
  }
  if (!rooms.length) return null;
  const floors = Math.max(1, Math.min(MAX_FLOORS, Math.max(Number(input.floors) || 1, ...rooms.map((r) => r.floor + 1))));
  // Stairs need a floor above them to go up to.
  const stairs = (Array.isArray(input.stairs) ? input.stairs : defaultStairs(rooms)).slice(0, MAX_STAIRS).filter((s) => s && typeof s === "object" && Math.round(Number(s.floor) || 0) < floors - 1).map((s, i) => ({
    key: `stairs_${i + 1}`, floor: Math.round(clampN(s.floor, 0, floors - 2)), x: span(s.x), z: span(s.z), dir: ["n", "s", "e", "w"].includes(s.dir) ? s.dir : "n"
  }));
  return { version: 1, floors, rooms, stairs };
}
const span = (v) => { const a = snap(clampN(v?.[0], -60, 60)), b = snap(clampN(v?.[1], -60, 60)); const lo = Math.min(a, b), hi = Math.max(a, b); return [lo, Math.max(hi, lo + 1)]; };
// Points: snapped to the grid, repeats dropped, at least three corners that enclose some area.
function cleanPoints(points) {
  if (!Array.isArray(points)) return null;
  const pts = [];
  for (const p of points.slice(0, MAX_POINTS)) {
    if (!Array.isArray(p)) continue;
    const q = [snap(clampN(p[0], -60, 60)), snap(clampN(p[1], -60, 60))], last = pts[pts.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);
  }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  if (pts.length < 3) return null;
  let area = 0; for (let i = 0; i < pts.length; i++) { const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % pts.length]; area += x1 * z2 - x2 * z1; }
  return Math.abs(area) / 2 >= 0.5 ? pts : null;
}
export const DEFAULT_LAYOUT = cleanLayout(TEMPLATES[3].layout);
