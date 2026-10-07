// <Device3D /> is a real Home Assistant device placed in its room: bulbs glow in their colour and fade with
// brightness, TVs light up when playing, blinds lower and rise with their position, heating glows when it
// runs, locks and doors change colour. Clicking one opens its controls.
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame } from "@react-three/fiber";
import { CYAN, glowTexture } from "./materials.js";
import { glow, isOn, lightLevel } from "../home.js";

const damp = THREE.MathUtils.damp;
const AMBER = new THREE.Color(1, 0.6, 0.25), DARK = new THREE.Color(0.12, 0.3, 0.38), WHITE = new THREE.Color(0.9, 0.97, 1);

export function Device3D({ entity, spot, mode, selected, onSelect }) {
  const hidden = mode === "hidden", interactive = mode !== "hidden";
  const core = useRef(), halo = useRef(), blind = useRef();
  const kind = entity.domain === "light" ? "light" : entity.domain === "cover" ? (spot.kind === "door" ? "door" : "blinds")
    : entity.domain === "climate" ? "thermostat" : entity.domain === "media_player" ? (spot.kind === "speaker" ? "speaker" : "tv")
    : entity.domain === "lock" ? "lock" : entity.domain === "camera" ? "camera" : "plug";
  const mats = useMemo(() => ({
    core: new THREE.MeshBasicMaterial({ color: DARK.clone(), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }),
    halo: new THREE.SpriteMaterial({ map: glowTexture(), color: AMBER.clone(), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
    edge: new THREE.LineBasicMaterial({ color: CYAN, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending })
  }), []);
  const geo = useMemo(() => spot.geometry ? new THREE.EdgesGeometry(spot.geometry) : null, [spot]);
  const tmp = useMemo(() => new THREE.Color(), []);
  const [x, y, z] = spot.position, size = spot.size || [0.3, 0.3, 0.3];

  useFrame((state, dt) => {
    const t = state.clock.elapsedTime, vis = hidden ? 0 : mode === "dim" ? 0.25 : 1, on = isOn(entity);
    let level = 0, color = CYAN;
    if (kind === "light") { level = lightLevel(entity); color = tmp.setRGB(...glow(entity)); }
    else if (kind === "tv") { level = entity.state === "playing" ? 0.7 + Math.sin(t * 7) * 0.08 + Math.sin(t * 2.3) * 0.1 : on ? 0.35 : 0; color = WHITE; }
    else if (kind === "speaker") { level = entity.state === "playing" ? 0.45 + Math.abs(Math.sin(t * 4)) * 0.3 : 0; color = CYAN; }
    else if (kind === "thermostat") { level = entity.hvacAction === "heating" ? 0.6 + Math.sin(t * 1.8) * 0.2 : on ? 0.25 : 0; color = entity.hvacAction === "heating" ? AMBER : CYAN; }
    else if (kind === "lock") { level = 0.5; color = String(entity.state).toLowerCase() === "locked" ? CYAN : AMBER; }
    else if (kind === "door") { level = on ? 0.6 : 0.2; color = on ? AMBER : CYAN; }
    else if (kind === "blinds") { level = 0.25; color = CYAN; }
    else { level = on ? 0.6 : 0; color = CYAN; }
    if (selected) level = Math.max(level, 0.4 + Math.sin(t * 4) * 0.15);
    mats.core.color.lerp(level > 0 ? color : DARK, 1 - Math.exp(-4 * dt));
    mats.core.opacity = damp(mats.core.opacity, vis * (0.35 + level * 0.65), 3, dt);
    mats.halo.color.lerp(color, 1 - Math.exp(-4 * dt));
    mats.halo.opacity = damp(mats.halo.opacity, vis * level * (kind === "light" ? 0.95 : 0.45), 2.2, dt);
    mats.edge.opacity = damp(mats.edge.opacity, vis * (selected ? 1 : 0.55), 4, dt);
    [mats.core, mats.halo, mats.edge].forEach((m) => { m.visible = m.opacity > 0.004; });
    if (halo.current) { const s = (kind === "light" ? 1.6 : 0.9) * (0.6 + level * 0.8); halo.current.scale.setScalar(s); }
    // Blinds: the panel lowers from the top as the blind closes.
    if (blind.current && entity.position != null) {
      const closed = 1 - Math.max(0, Math.min(100, entity.position)) / 100;
      blind.current.scale.y = damp(blind.current.scale.y, Math.max(0.04, closed), 3, dt);
      blind.current.position.y = y + size[1] / 2 - (size[1] * blind.current.scale.y) / 2;
    } else if (blind.current) blind.current.scale.y = damp(blind.current.scale.y, isOn(entity) ? 0.06 : 1, 3, dt);
  });

  const click = (e) => { if (!interactive) return; e.stopPropagation(); onSelect(); };
  const hit = { onClick: click, onPointerOver: (e) => { if (interactive) { e.stopPropagation(); document.body.style.cursor = "pointer"; } }, onPointerOut: () => { document.body.style.cursor = ""; } };
  return (
    <group>
      {kind === "blinds"
        ? <mesh ref={blind} position={[x, y, z]} material={mats.core} {...hit}><boxGeometry args={size} /></mesh>
        : kind === "tv" || kind === "door"
          ? <mesh position={[x, y, z]} material={mats.core} {...hit}><boxGeometry args={size} /></mesh>
          : <mesh ref={core} position={[x, y, z]} material={mats.core} {...hit}><sphereGeometry args={[kind === "light" ? 0.13 : 0.11, 16, 12]} /></mesh>}
      {geo && kind !== "light" && <lineSegments geometry={geo} material={mats.edge} />}
      <sprite ref={halo} position={[x, y, z]} material={mats.halo} />
      {/* A larger invisible target so devices are easy to tap on a touchscreen. */}
      <mesh position={[x, y, z]} visible={false} {...hit}><sphereGeometry args={[0.45, 8, 6]} /></mesh>
    </group>
  );
}
