// <Room /> is one selectable area of the house: a hologram outline, a faint volume that fills with warm light
// when its lights are on, a pool of light on the floor, faint furniture, and a small floating label.
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { CYAN, ICE, edgeMaterial, fillMaterial, glowTexture } from "./materials.js";

const damp = THREE.MathUtils.damp;
const WARM = new THREE.Color(1, 0.66, 0.36);

export function Room({ room, light, mode, hovered, quiet, pulse, onHover, onSelect }) {
  const geo = useMemo(() => {
    const edges = new THREE.EdgesGeometry(room.geometry, 25);
    const furn = room.furniture.length ? new THREE.EdgesGeometry(mergeGeometries(room.furniture.map((g) => g.index ? g.toNonIndexed() : g), false), 30) : null;
    const b = room.box, w = b.max.x - b.min.x, d = b.max.z - b.min.z;
    return { edges, furn, w, d, floorY: b.min.y + 0.03, top: b.max.y };
  }, [room]);
  const mats = useMemo(() => ({ edge: edgeMaterial(0.5), fill: fillMaterial(0.02), furn: edgeMaterial(0.12, ICE), pool: new THREE.MeshBasicMaterial({ map: glowTexture(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, color: WARM.clone() }) }), []);
  const label = useRef();
  const tmp = useMemo(() => new THREE.Color(), []);

  // Everything eases toward its target, so lights fade up rather than snap on.
  useFrame((state, dt) => {
    const lv = light?.level || 0, hidden = mode === "hidden", dim = mode === "dim", focus = mode === "focus";
    const since = pulse ? (performance.now() - pulse) / 1000 : 9;
    const flash = since < 1.2 ? Math.sin(Math.min(1, since / 1.2) * Math.PI) : 0;
    const edgeTarget = hidden ? 0 : dim ? 0.1 : focus ? 1 : hovered ? 0.85 : room.outdoor ? 0.3 : 0.5;
    mats.edge.opacity = damp(mats.edge.opacity, Math.min(1, edgeTarget + flash * 0.6), 5, dt);
    mats.edge.color.copy(CYAN).lerp(ICE, focus ? 0.5 + Math.sin(state.clock.elapsedTime * 2) * 0.15 : 0);
    tmp.setRGB(...(light?.color || [1, 0.66, 0.36]));
    mats.fill.color.lerp(lv > 0 ? tmp : CYAN, 1 - Math.exp(-3 * dt));
    const fillTarget = hidden ? 0 : (lv > 0 ? (room.outdoor ? 0.04 : 0.11) * lv : 0.015) * (dim ? 0.3 : 1) + (focus ? 0.025 : 0) + flash * 0.05;
    mats.fill.opacity = damp(mats.fill.opacity, fillTarget, 3, dt);
    mats.pool.color.lerp(tmp, 1 - Math.exp(-3 * dt));
    mats.pool.opacity = damp(mats.pool.opacity, hidden ? 0 : lv * (dim ? 0.25 : 0.9), 2.5, dt);
    mats.furn.opacity = damp(mats.furn.opacity, hidden ? 0 : focus ? 0.4 : dim ? 0.03 : 0.12, 4, dt);
    [mats.edge, mats.fill, mats.pool, mats.furn].forEach((m) => { m.visible = m.opacity > 0.003; });
    if (label.current) label.current.style.opacity = hidden || dim || (quiet && !hovered && !(lv > 0)) ? "0" : "1";
  });

  const c = room.center;
  return (
    <group>
      <mesh geometry={room.geometry} material={mats.fill} renderOrder={0}
        onPointerOver={(e) => { if (mode === "hidden") return; e.stopPropagation(); onHover(true); }}
        onPointerOut={() => onHover(false)}
        onClick={(e) => { if (mode === "hidden") return; e.stopPropagation(); onSelect(); }} />
      <lineSegments geometry={geo.edges} material={mats.edge} renderOrder={2} />
      {geo.furn && <lineSegments geometry={geo.furn} material={mats.furn} renderOrder={1} />}
      <mesh position={[c[0], geo.floorY, c[2]]} rotation-x={-Math.PI / 2} material={mats.pool} renderOrder={1}>
        <planeGeometry args={[geo.w * 1.15, geo.d * 1.15]} />
      </mesh>
      <Html position={[c[0], geo.top + 0.35, c[2]]} center zIndexRange={[20, 0]} style={{ pointerEvents: "none" }}>
        <div ref={label} className={`h3-label${light?.on ? " is-lit" : ""}${mode === "focus" ? " is-focus" : ""}`}>
          {light?.on ? <i /> : null}{room.label}
        </div>
      </Html>
    </group>
  );
}
