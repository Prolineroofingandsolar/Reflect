# 3D House (Smart Home)

The mirror's **House** screen: a 3D cutaway of the home, driven by Home Assistant in real time and by Jarvis.

You don't need to build anything to use it: `smarthome/dist/` is committed, so `node server.js` is enough.

## Making it look like your house
Tap **Edit house** on the House screen. Pick a starting house type, add floors and rooms, drag them into place
and pull their corners to resize. The layout is saved with your account (`/api/house-layout`) and the 3D house
is generated from it (`src/houseBuilder.js`).

## How devices get into rooms
Nothing is hard-coded. Every device comes from Home Assistant and lands in the room whose name matches its
**area**, so name rooms in the builder the way they're named in Home Assistant.
`house-map.json` adds extra area names per room key or room type (`"areas"`), can pin a device to a spot
(`"devices"`), names the cameras and defines the scenes (a Home Assistant scene/script is used first if one exists).

## Using your own 3D model
Add `"model": "models/your-house.glb"` to `house-map.json`. The GLB must follow the naming in `src/houseBuilder.js`:
`Room_<key>` groups, `<key>_room` volume, `<key>_dev_<slot>` device spots, `<key>_furn_*` furniture, `Structure_*`.

## Editing the code
`npm install`, change `src/`, then `npm run build` and commit `dist/`.
React + @react-three/fiber + drei + Framer Motion; the mirror talks to it through `window.ReflectHome3D` and `window.ReflectBridge`.
