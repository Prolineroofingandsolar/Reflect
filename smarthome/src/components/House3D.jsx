// <House3D /> is the centrepiece: the model from house.glb drawn as a cyan hologram, with each room's lights
// glowing in their real colours. It owns the camera (fly-to, idle drift) and the transient effects
// (command beams, scene waves). Rooms and devices are their own components.
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { CameraControls, useGLTF } from "@react-three/drei";
import { readModel } from "../houseMap.js";
import { Room } from "./Room.jsx";
import { Device3D } from "./Device3D.jsx";
import { Beams } from "./Beams.jsx";
import { CYAN, edgeMaterial } from "./materials.js";

const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function useHouseModel(url) {
  const { scene } = useGLTF(url);
  return useMemo(() => readModel(scene), [scene]);
}

function Structure({ model, focus, floor }) {
  const parts = useMemo(() => model.structure.map((g) => ({ edges: new THREE.EdgesGeometry(g, 25), top: new THREE.Box3().setFromBufferAttribute(g.attributes.position).min.y })), [model]);
  const mats = useRef([]);
  const firstFloorY = 3 - 0.2;
  useFrame((_, dt) => {
    parts.forEach((p, i) => {
      const m = mats.current[i]; if (!m) return;
      const isRoof = p.top > 5.5, isUpper = p.top > firstFloorY;
      let target = isRoof ? 0.22 : 0.4;
      if (focus) target = isRoof ? 0 : 0.08;
      if (floor === 0 && isUpper) target = 0;
      m.opacity = THREE.MathUtils.damp(m.opacity, target, 4, dt);
      m.visible = m.opacity > 0.005;
    });
  });
  return parts.map((p, i) => (
    <lineSegments key={i} geometry={p.edges} renderOrder={1}>
      <primitive object={edgeMaterial(0.3)} attach="material" ref={(m) => { mats.current[i] = m; }} />
    </lineSegments>
  ));
}

// The projector the hologram stands on: slow rings on the ground plane.
function Base({ model }) {
  const ref = useRef();
  const size = Math.max(model.bounds.max.x - model.bounds.min.x, model.bounds.max.z - model.bounds.min.z);
  const rings = useMemo(() => [0.62, 0.7, 0.86].map((r, i) => {
    const pts = []; const segs = 128;
    for (let s = 0; s <= segs; s++) { if (i === 2 && s % 4 > 1) continue; const a = (s / segs) * Math.PI * 2; pts.push(Math.cos(a) * r * size, 0, Math.sin(a) * r * size); }
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3)); return g;
  }), [size]);
  const center = model.bounds.getCenter(new THREE.Vector3());
  useFrame((_, dt) => { if (ref.current && !reduced) ref.current.rotation.y += dt * 0.05; });
  return (
    <group ref={ref} position={[center.x, -0.25, center.z]}>
      {rings.map((g, i) => (i === 2
        ? <points key={i} geometry={g}><pointsMaterial color={CYAN} size={0.06} transparent opacity={0.5} depthWrite={false} /></points>
        : <line key={i} geometry={g}><lineBasicMaterial color={CYAN} transparent opacity={i === 0 ? 0.35 : 0.15} depthWrite={false} /></line>))}
    </group>
  );
}

// Camera: a fixed three-quarter view of the whole house, flying to a room or floor when one is chosen.
function CameraRig({ model, view }) {
  const controls = useRef();
  const idleAt = useRef(0);
  const { size } = useThree();
  const center = useMemo(() => model.bounds.getCenter(new THREE.Vector3()), [model]);
  const span = Math.max(model.bounds.max.x - model.bounds.min.x, model.bounds.max.z - model.bounds.min.z);
  const portrait = size.height > size.width;

  useEffect(() => {
    const c = controls.current; if (!c) return;
    const dist = span * (portrait ? 2.0 : 1.35);
    if (view.mode === "room" && view.room) {
      const room = model.rooms.find((r) => r.key === view.room); if (!room) return;
      const rc = new THREE.Vector3(...room.center), dims = room.box.getSize(new THREE.Vector3());
      const out = new THREE.Vector3(rc.x - center.x, 0, rc.z - center.z);
      out.normalize().multiplyScalar(0.55).add(new THREE.Vector3(0.35, 0, 1)).normalize();
      const d = Math.max(dims.x, dims.z) * (portrait ? 2.2 : 1.55) + 4;
      const pos = rc.clone().addScaledVector(out, d).add(new THREE.Vector3(0, d * 0.62, 0));
      c.setLookAt(pos.x, pos.y, pos.z, rc.x, rc.y, rc.z, true);
      // Slide the room left of centre so the floating panel on the right never covers it.
      c.setFocalOffset(portrait ? 0 : d * 0.32, portrait ? -d * 0.2 : 0, 0, true);
      idleAt.current = performance.now() + 4000;
      return;
    } else if (view.floor === 0 || view.floor === 1) {
      const y = view.floor * 3 + 1;
      c.setLookAt(center.x + dist * 0.45, y + dist * 0.75, center.z + dist * 0.7, center.x, y, center.z, true);
    } else {
      c.setLookAt(center.x + dist * 0.55, center.y + dist * 0.5, center.z + dist * 0.85, center.x, center.y - 0.5, center.z, true);
    }
    c.setFocalOffset(0, 0, 0, true);
    idleAt.current = performance.now() + 4000;
  }, [view.mode, view.room, view.floor, model, portrait]);

  // Gentle idle sway around the house, only when nobody is interacting and the whole house is shown.
  useFrame((state, dt) => {
    const c = controls.current; if (!c || reduced) return;
    if (view.mode !== "house" || performance.now() < idleAt.current) return;
    c.rotate(Math.cos(state.clock.elapsedTime * 0.07) * 0.025 * dt, 0, false);
  });
  return (
    <CameraControls ref={controls} smoothTime={0.85} draggingSmoothTime={0.2} minDistance={6} maxDistance={span * 3}
      maxPolarAngle={Math.PI * 0.47} minPolarAngle={Math.PI * 0.12} truckSpeed={0}
      onStart={() => { idleAt.current = performance.now() + 15000; }} />
  );
}

export function House3D({ model, rooms, placements, entities, view, onSelectRoom, onSelectDevice, effects }) {
  const group = useRef();
  const [hover, setHover] = useState(null);
  const { gl } = useThree();
  useEffect(() => { gl.domElement.style.cursor = hover ? "pointer" : "default"; }, [hover, gl]);
  const center = useMemo(() => model.bounds.getCenter(new THREE.Vector3()), [model]);
  const width = model.bounds.max.x - model.bounds.min.x;

  // Floating idle motion; in camera mode the house shrinks and moves aside for the live feed.
  useFrame((state, dt) => {
    const g = group.current; if (!g) return;
    const cam = view.mode === "camera";
    const s = THREE.MathUtils.damp(g.scale.x, cam ? 0.55 : 1, 3, dt);
    g.scale.setScalar(s);
    g.position.x = THREE.MathUtils.damp(g.position.x, cam ? -width * 0.75 : 0, 3, dt);
    g.position.y = reduced ? 0 : Math.sin(state.clock.elapsedTime * 0.5) * 0.08;
  });

  const focus = view.mode === "room" ? view.room : null;
  // In the whole-house view only lit (or hovered) rooms are labelled, so the mirror stays quiet.
  const quiet = view.mode !== "room" && view.floor === "all";
  const byId = useMemo(() => new Map(entities.map((e) => [e.id, e])), [entities]);
  return (
    <>
      <CameraRig model={model} view={view} />
      <group ref={group}>
        <group position={[0, 0, 0]}>
          <Base model={model} />
          <Structure model={model} focus={focus} floor={view.floor} />
          {model.rooms.map((room) => {
            const hidden = view.floor === 0 && room.floor > 0;
            const mode = hidden ? "hidden" : focus ? (focus === room.key ? "focus" : "dim") : "normal";
            return (
              <Room key={room.key} room={room} light={rooms.get(room.key)} mode={mode} hovered={hover === room.key} quiet={quiet}
                pulse={effects.pulses[room.key]}
                onHover={(on) => setHover(on ? room.key : (h) => (h === room.key ? null : h))}
                onSelect={() => onSelectRoom(room.key)} />
            );
          })}
          {[...placements].map(([id, p]) => {
            const e = byId.get(id); if (!e || !p.spot || !p.room) return null;
            const room = model.rooms.find((r) => r.key === p.room);
            const hidden = view.floor === 0 && room.floor > 0;
            const mode = hidden ? "hidden" : focus ? (focus === p.room ? "focus" : "dim") : "normal";
            return <Device3D key={id} entity={e} spot={p.spot} mode={mode} selected={view.device === id}
              onSelect={() => { onSelectRoom(p.room); onSelectDevice(id); }} />;
          })}
          <Beams model={model} placements={placements} effects={effects} center={center} />
        </group>
      </group>
    </>
  );
}
