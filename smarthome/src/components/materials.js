// Shared hologram materials and textures. Everything is unlit and additive so the mirror stays truly
// black wherever nothing is drawn.
import * as THREE from "three";

export const CYAN = new THREE.Color(0.34, 0.85, 1);
export const ICE = new THREE.Color(0.75, 0.95, 1);

export const edgeMaterial = (opacity = 0.5, color = CYAN) =>
  new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });

export const fillMaterial = (opacity = 0.03, color = CYAN) =>
  new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending });

let glowTex = null;
// A soft round falloff used for light pools on floors and halos around bulbs.
export function glowTexture() {
  if (glowTex) return glowTex;
  const c = document.createElement("canvas"); c.width = c.height = 128;
  const g = c.getContext("2d"), r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, "rgba(255,255,255,1)"); r.addColorStop(0.25, "rgba(255,255,255,0.55)"); r.addColorStop(0.6, "rgba(255,255,255,0.12)"); r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  glowTex = new THREE.CanvasTexture(c); glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}
