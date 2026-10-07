// Transient effects: when a command runs (voice or touch), a line of light travels from the projector to the
// device or room it changed; when a scene runs, a ring of light sweeps out across the house.
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { CYAN } from "./materials.js";

const LIFE = 1.6;

function Beam({ from, to, born }) {
  const line = useRef(), ring = useRef();
  const geo = useMemo(() => {
    const mid = new THREE.Vector3().lerpVectors(from, to, 0.5).add(new THREE.Vector3(0, 2.5, 0));
    const pts = new THREE.QuadraticBezierCurve3(from, mid, to).getPoints(48);
    return new THREE.BufferGeometry().setFromPoints(pts);
  }, [from, to]);
  useFrame(() => {
    const k = (performance.now() - born) / 1000 / LIFE;
    if (!line.current) return;
    const draw = Math.min(1, k * 2.2);
    line.current.geometry.setDrawRange(Math.floor(48 * Math.max(0, draw - 0.45)), Math.ceil(48 * Math.min(draw, 1) * 0.55 + 1));
    line.current.material.opacity = Math.max(0, 1 - Math.max(0, k - 0.5) * 2);
    if (ring.current) { const r = Math.max(0, k - 0.35) * 2.2; ring.current.scale.setScalar(0.2 + r); ring.current.material.opacity = Math.max(0, 0.9 - r * 0.6) * (k > 0.35 ? 1 : 0); }
  });
  return (
    <>
      <line ref={line} geometry={geo}><lineBasicMaterial color={CYAN} transparent depthWrite={false} blending={THREE.AdditiveBlending} /></line>
      <mesh ref={ring} position={to} rotation-x={-Math.PI / 2}><ringGeometry args={[0.55, 0.62, 48]} /><meshBasicMaterial color={CYAN} transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} /></mesh>
    </>
  );
}

function Wave({ center, born, radius }) {
  const ref = useRef();
  useFrame(() => {
    const k = (performance.now() - born) / 1800;
    if (!ref.current) return;
    ref.current.scale.setScalar(0.1 + k * radius);
    ref.current.material.opacity = Math.max(0, 0.7 * (1 - k));
  });
  return <mesh ref={ref} position={[center.x, 0.05, center.z]} rotation-x={-Math.PI / 2}><ringGeometry args={[0.92, 1, 96]} /><meshBasicMaterial color={CYAN} transparent depthWrite={false} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} /></mesh>;
}

export function Beams({ model, placements, effects, center }) {
  const source = useMemo(() => new THREE.Vector3(center.x, -0.3, model.bounds.max.z + 5), [model, center]);
  const radius = Math.max(model.bounds.max.x - model.bounds.min.x, model.bounds.max.z - model.bounds.min.z);
  const now = performance.now();
  const beams = effects.beams.filter((b) => now - b.born < LIFE * 1000).flatMap((b) => {
    const targets = [];
    b.entityIds.forEach((id) => { const p = placements.get(id); if (p?.spot) targets.push(new THREE.Vector3(...p.spot.position)); else if (p?.room) { const r = model.rooms.find((x) => x.key === p.room); if (r) targets.push(new THREE.Vector3(...r.center)); } });
    b.rooms.forEach((key) => { const r = model.rooms.find((x) => x.key === key); if (r) targets.push(new THREE.Vector3(r.center[0], r.box.min.y + 0.2, r.center[2])); });
    return targets.slice(0, 8).map((to, i) => ({ key: `${b.born}-${i}`, to, born: b.born + i * 60 }));
  });
  return (
    <>
      {beams.map((b) => <Beam key={b.key} from={source} to={b.to} born={b.born} />)}
      {effects.waves.filter((w) => now - w.born < 1800).map((w) => <Wave key={w.born} center={center} born={w.born} radius={radius} />)}
    </>
  );
}
