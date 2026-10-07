// Entry point: window.ReflectHome3D. The mirror (app.js) calls setActive() when the 3D House view is shown or
// hidden; the React app mounts on first show and stops rendering frames while hidden, so it costs nothing
// on other screens. Jarvis uses the same object to show rooms, floors, cameras and scenes.
import { createRoot } from "react-dom/client";
import { App } from "./App.jsx";
import "./styles.css";

let root = null, active = false;
const notReady = () => { throw new Error("The 3D house is still loading."); };
const api = (window.ReflectHome3D = {
  setActive(on) {
    active = Boolean(on);
    document.body.classList.toggle("house3d-active", active);
    const el = document.getElementById("house3dRoot");
    if (!el) return;
    if (!root && active) root = createRoot(el);
    if (root) root.render(<App active={active} />);
  },
  ensure() { if (!root) { const el = document.getElementById("house3dRoot"); if (el) { root = createRoot(el); root.render(<App active={active} />); } } },
  showRoom: notReady, showHouse: notReady, showFloor: notReady, showCamera: notReady, closeCamera: () => {}, runScene: notReady,
  describe: () => []
});
// If the mirror opened straight onto the 3D House (it can be the default screen), start right away.
if (document.getElementById("view-house3d")?.classList.contains("is-active")) api.setActive(true);
