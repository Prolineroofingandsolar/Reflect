// Turns a house layout (houseLayout.js) into a Three.js group that follows the model naming contract:
//
//   Room_<key>          group per room, userData { key, type, label, floor, outdoor }
//     <key>_room        the room's volume (floor to ceiling), used for outline and glow
//     <key>_dev_<slot>  device anchors, userData { role: "device", slot, kind }
//     <key>_furn_*      furniture, drawn as faint hologram detail
//   Structure_*         slabs, stairs, roofs and fences, userData { role: "structure", floor, roof }
//
// readModel() (houseMap.js) reads the result exactly as it reads a GLB made in Blender.
import * as THREE from "three";
import { insidePoint, roomPoly, typeOf } from "./houseLayout.js";

export const STOREY = 3, CEIL = 2.7;
const devHeight = { ceiling: CEIL - 0.08, pendant: CEIL - 0.6, lamp: 0.75, tv: 1.2, speaker: 0.9, blinds: 1.6, thermostat: 1.5, strip: 0.3, door: 1.0, sensor: 2.2, appliance: 1.0, plug: 0.35, cabinet: 1.2, fan: CEIL - 0.1, camera: 2.4 };

export function buildHouse(layout) {
  const mat = new THREE.MeshBasicMaterial();
  const house = new THREE.Group(); house.name = "House";
  const box = (name, w, h, d, x, y, z, parent, data) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w, 0.01), Math.max(h, 0.01), Math.max(d, 0.01)), mat);
    m.name = name; m.position.set(x, y, z); if (data) m.userData = data; parent.add(m); return m;
  };
  const cyl = (name, r, h, x, y, z, parent, data, segs = 16) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, segs), mat);
    m.name = name; m.position.set(x, y, z); if (data) m.userData = data; parent.add(m); return m;
  };
  // A flat shape (room outline) extruded upwards from y, for odd-shaped rooms and their slabs.
  const prism = (name, pts, h, y, parent, data) => {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const m = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: Math.max(h, 0.01), bevelEnabled: false }), mat);
    m.name = name; m.rotation.x = -Math.PI / 2; m.position.y = y; if (data) m.userData = data; parent.add(m); return m;
  };
  const shell = new THREE.Group(); shell.name = "Structure"; house.add(shell);
  const struct = (floor, roof = false) => ({ role: "structure", floor, roof });

  const indoor = layout.rooms.filter((r) => !typeOf(r.type).outdoor);
  const top = Math.max(0, ...indoor.map((r) => r.floor));
  const bboxOf = (list) => list.length ? { x: [Math.min(...list.map((r) => r.x[0])), Math.max(...list.map((r) => r.x[1]))], z: [Math.min(...list.map((r) => r.z[0])), Math.max(...list.map((r) => r.z[1]))] } : null;
  const inside = (r, b) => b && r.x[0] >= b.x[0] - 0.01 && r.x[1] <= b.x[1] + 0.01 && r.z[0] >= b.z[0] - 0.01 && r.z[1] <= b.z[1] + 0.01;

  for (const r of layout.rooms) {
    const t = typeOf(r.type), outdoor = Boolean(t.outdoor);
    const g = new THREE.Group(); g.name = `Room_${r.key}`;
    g.userData = { key: r.key, type: r.type, label: r.label, floor: r.floor, outdoor };
    house.add(g);
    const w = r.x[1] - r.x[0], d = r.z[1] - r.z[0], y0 = r.floor * STOREY, h = outdoor ? 0.04 : CEIL;
    const cx = (r.x[0] + r.x[1]) / 2, cz = (r.z[0] + r.z[1]) / 2;
    const poly = roomPoly(r);
    if (r.points) prism(`${r.key}_room`, r.points, h, y0, g, { role: "room" });
    else box(`${r.key}_room`, w, h, d, cx, y0 + h / 2, cz, g, { role: "room" });
    const at = (fx, fz) => (r.points ? insidePoint(poly, r.x[0] + w * fx, r.z[0] + d * fz) : [r.x[0] + w * fx, r.z[0] + d * fz]);
    const garage = r.type === "garage";
    for (const [slot, fx, fz, kind] of t.dev) {
      const [x, z] = at(fx, fz), y = y0 + (outdoor ? (kind === "camera" ? 2.4 : 0.5) : devHeight[kind]), data = { role: "device", slot, kind }, name = `${r.key}_dev_${slot}`;
      if (kind === "tv") box(name, Math.min(1.1, w * 0.6), 0.65, 0.06, x, y, z, g, data);
      else if (kind === "blinds") box(name, Math.min(2.2, w * 0.5), 1.4, 0.04, x, y, z, g, data);
      else if (kind === "strip") box(name, Math.min(2.4, w * 0.6), 0.04, 0.04, x, y, z, g, data);
      else if (kind === "door") box(name, Math.min(garage ? 3.2 : 1.0, w * 0.8), garage ? 2.2 : 2.1, 0.06, x, y0 + (garage ? 1.1 : 1.05), z, g, data);
      else if (kind === "ceiling") cyl(name, 0.22, 0.05, x, y, z, g, data);
      else if (kind === "lamp") cyl(name, 0.14, 0.3, x, y, z, g, data);
      else box(name, 0.22, 0.22, 0.22, x, y, z, g, data);
    }
    for (const [name, fx, fz, fw, fh, fd] of t.furn) {
      const [x, z] = at(fx, fz), data = { role: "furniture" };
      if (name.startsWith("tree")) cyl(`${r.key}_furn_${name}`, Math.min(fw, w * 0.3) / 2, fh, x, y0 + fh / 2, z, g, data, 6);
      else box(`${r.key}_furn_${name}`, Math.min(fw, w * 0.95), fh, Math.min(fd, d * 0.95), x, y0 + fh / 2, z, g, data);
    }
    if (outdoor) {
      // A low fence along the garden's edges, left open where it meets the house.
      if (r.type === "garden") poly.forEach(([x1, z1], i) => {
        const [x2, z2] = poly[(i + 1) % poly.length], mx = (x1 + x2) / 2, mz = (z1 + z2) / 2, len = Math.hypot(x2 - x1, z2 - z1);
        if (indoor.some((o) => o.floor === 0 && mx > o.x[0] - 1.2 && mx < o.x[1] + 1.2 && mz > o.z[0] - 1.2 && mz < o.z[1] + 1.2)) return;
        box(`Structure_fence_${r.key}_${i}`, len, 1.1, 0.05, mx, 0.55, mz, shell, struct(0)).rotation.y = -Math.atan2(z2 - z1, x2 - x1);
      });
      continue;
    }
    // Slab under every room, and a flat roof on rooms with nothing built above them (a garage, an extension).
    if (r.points) prism(`Structure_slab_${r.key}`, r.points, 0.12, y0 - 0.12, shell, struct(r.floor));
    else box(`Structure_slab_${r.key}`, w + 0.1, 0.12, d + 0.1, cx, y0 - 0.06, cz, shell, struct(r.floor));
    const above = bboxOf(indoor.filter((o) => o.floor === r.floor + 1));
    if (r.floor < top && !inside(r, above)) box(`Structure_flatroof_${r.key}`, w + 0.2, 0.1, d + 0.2, cx, y0 + CEIL + 0.05, cz, shell, struct(r.floor, true));
  }

  // Stairs: a flight of 14 steps across the placed footprint, rising towards dir to the floor above.
  for (const st of layout.stairs || []) {
    const steps = 14, alongZ = st.dir === "n" || st.dir === "s", len = alongZ ? st.z[1] - st.z[0] : st.x[1] - st.x[0], run = len / steps;
    const width = alongZ ? st.x[1] - st.x[0] : st.z[1] - st.z[0], y0 = st.floor * STOREY;
    for (let i = 0; i < steps; i++) {
      const y = y0 + 0.1 + i * (STOREY / steps), off = (i + 0.5) * run;
      const x = st.dir === "e" ? st.x[0] + off : st.dir === "w" ? st.x[1] - off : (st.x[0] + st.x[1]) / 2;
      const z = st.dir === "s" ? st.z[0] + off : st.dir === "n" ? st.z[1] - off : (st.z[0] + st.z[1]) / 2;
      box(`Structure_stair_${st.key}_${i}`, alongZ ? width : run * 1.05, 0.2, alongZ ? run * 1.05 : width, x, y, z, shell, struct(st.floor));
    }
  }

  // Gable roof over the top floor, ridge along its longer side; flat roof when the top floor is tiny.
  const topRooms = indoor.filter((r) => r.floor === top), b = bboxOf(topRooms);
  if (b) {
    const W = b.x[1] - b.x[0], D = b.z[1] - b.z[0], cx = (b.x[0] + b.x[1]) / 2, cz = (b.z[0] + b.z[1]) / 2;
    const eaves = (top + 1) * STOREY, alongX = W >= D, len = (alongX ? W : D) + 0.6, half = (alongX ? D : W) / 2 + 0.3;
    const rise = Math.min(3, half * 0.62), slope = Math.hypot(half, rise), ang = Math.atan2(rise, half);
    for (const side of [1, -1]) {
      const p = alongX ? box(`Structure_roof_${side}`, len, 0.08, slope, cx, eaves + rise / 2, cz + side * half / 2, shell, struct(top, true))
        : box(`Structure_roof_${side}`, slope, 0.08, len, cx + side * half / 2, eaves + rise / 2, cz, shell, struct(top, true));
      if (alongX) p.rotation.x = side * ang; else p.rotation.z = -side * ang;
    }
    for (const side of [1, -1]) {
      const tri = new THREE.Shape([new THREE.Vector2(-half, 0), new THREE.Vector2(half, 0), new THREE.Vector2(0, rise)]);
      const m = new THREE.Mesh(new THREE.ShapeGeometry(tri), mat); m.name = `Structure_gable_${side}`; m.userData = struct(top, true);
      if (alongX) { m.rotation.y = Math.PI / 2; m.position.set(cx + side * (len / 2 - 0.3), eaves, cz); }
      else m.position.set(cx, eaves, cz + side * (len / 2 - 0.3));
      shell.add(m);
    }
    box("Structure_chimney", 0.7, 1.6, 0.7, alongX ? cx + W * 0.25 : cx - half * 0.4, eaves + rise - 0.3, alongX ? cz - half * 0.4 : cz + D * 0.25, shell, struct(top, true));
  }
  return house;
}
