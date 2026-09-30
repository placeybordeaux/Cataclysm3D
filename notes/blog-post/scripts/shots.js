// Shot list for blog-shots.ts. Each `js` is the body of an async function run in the game page
// with `c = window.cdda`; the doc views (lookView / charView / vehicleView from tools/*-views.js)
// are already loaded. World seed 1: the start is the Evac Shelter at OMT (53,39) near Holden;
// seed-1 landmarks used below were found with `blog-shots.ts --probe`.
//
// `hero: true` also writes a full-size 1920x1080 <id>-hero.jpg. `ui: true` shots keep the HUD /
// windows (others hide overlays via the views). `params` = extra URL query (a reload).

/** @typedef {{ id: string, js: string, hero?: boolean, params?: string, wait?: number, fresh?: boolean, note?: string }} Shot */

// Hide DOM overlays but keep the canvas (same as look-views.js hideOverlays).
// Recursive like look-views.js hideOverlays: HUD containers also hold small canvases.
// The first-person hands (viewmodel) go too: these are scenery shots.
const HIDE = `{ const hide = (root) => { for (const el of root.children) { if (el.id === 'view') continue; if (el.querySelector('#view')) hide(el); else el.style.visibility = 'hidden'; } }; hide(document.body); c.renderer.hideViewmodel = true; }`;
// For shots that keep the HUD / a window open: hands back on.
const HANDS = `c.renderer.hideViewmodel = false; for (const el of document.querySelectorAll('body *')) if (el.style?.visibility === 'hidden') el.style.visibility = '';`;
// Common reset for hand-made views: god mode, clear sky, first person, no leftover monsters.
const RESET = `c.godMode(true); if (c.vehicleSystem?.driving) c.exitVehicle(); c.setWeather('clear'); c.flashlight(false); c.setCameraMode('first'); c.clearMonsters?.();`;
const SETTLE = `c.settle(); await new Promise((r) => setTimeout(r, 1500)); c.settle();`;
const TOWN = `const s0 = c.startLocation(); const town = c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s0.omx, a.y - s0.omy) - Math.hypot(b.x - s0.omx, b.y - s0.omy))[0];`;

// A doc view (look-views.js / char-views.js / vehicle-views.js) with every overlay hidden.
const look = (v) => `await lookView(${JSON.stringify(v)}); ${HIDE} return ${JSON.stringify(v)};`;
const chr = (v) => `const r = await charView(${JSON.stringify(v)}); ${HIDE} return r;`;
const veh = (v) => `const r = await vehicleView(${JSON.stringify(v)}); ${HIDE} return r;`;

/** @type {Shot[]} */
export const shots = [
  // --- places ---
  {
    id: '01-evac-shelter-outside', hero: true, note: 'the Evac Shelter from outside, morning',
    js: `${RESET} c.setHour(9.5); c.teleportOmt(53, 39, 0, 2, 16); c.look(70, -4); ${SETTLE} ${HIDE} return c.omtAt(53, 39);`,
  },
  { id: '02-evac-shelter-inside', note: 'where every game starts: inside the shelter', js: look('shelter') },
  { id: '03-town-street', hero: true, note: 'a residential street in Holden, afternoon', js: look('street') },
  {
    id: '04-refugee-center', note: 'inside the Refugee Center: refugees in the lobby',
    js: `${RESET} c.setHour(10.5); const r = c.teleportRefugeeCenter('lobby'); ${SETTLE} ${HIDE} return r;`,
  },
  {
    id: '05-lab-entrance', note: 'a (micro)lab surface building',
    js: `${RESET} c.setHour(14); c.teleportOmt(54, 47, 0, 12, 23); c.look(0, -2); ${SETTLE} ${HIDE} return c.omtAt(54, 47);`,
  },
  {
    id: '06-lab-inside', note: 'inside a lab: the loot a card reader guards',
    js: `${RESET} c.setHour(14); const r = c.faceLabLoot(); c.game.player.pitch = -0.12; c.flashlight(true); ${SETTLE} ${HIDE} return r;`,
  },
  {
    id: '07-forest-cabin', note: 'a cabin in the woods',
    js: `${RESET} c.setHour(16); c.teleportOmt(84, 43, 0, 12, 2); c.look(0, 4); ${SETTLE} ${HIDE} return c.omtAt(84, 42);`,
  },
  { id: '08-top-down-town', note: 'top-down camera over the town centre (pairs with the tileset render)', js: `await lookView('top'); c.renderer.rig.topDistance = 75; ${SETTLE} ${HIDE} return 'top';` },
  // --- creatures ---
  { id: '10-horde-near', hero: true, note: 'a zombie horde, close', js: chr('horde_near') },
  { id: '11-horde-road', note: 'zombies down the road, 18-30 m', js: chr('horde_mid') },
  { id: '12-special-zombies', note: 'special zombies', js: chr('zombies2') },
  { id: '13-dogs-animals', note: 'dogs and animals', js: chr('critters') },
  { id: '14-zoo', note: 'every body plan', js: chr('zoo') },
  { id: '15-npc-group', note: 'survivors (NPCs)', js: chr('crowd') },
  { id: '17-third-person', note: 'the survivor in third-person view', js: chr('third') },
  { id: '16-night-zombies', note: 'zombies at night in the flashlight', js: chr('night') },
  // --- vehicles ---
  { id: '20-armored-vehicles', note: 'BN armoured vehicles: armored car, humvee, SWAT truck', js: veh('lineup:armored_car,humvee,truck_swat') },
  {
    id: '21-wreck-pileup', note: 'a pile-up of wrecked cars on a road',
    js: `${RESET} c.setHour(16.5); ${TOWN} c.teleportOmt(town.x, town.y); c.roadTrip('car', 4, 40); c.exitVehicle(); c.settle();
      for (const v of [...c.vehicleSystem.list]) if (Math.hypot(v.x - c.game.player.x, v.y - c.game.player.y) < 40) c.vehicleSystem.remove?.(v);
      const p = c.game.player, yaw = p.yaw * 180 / Math.PI;
      const fx = Math.sin(p.yaw), fy = -Math.cos(p.yaw);
      const at = (f, s) => [Math.round(fx * f - fy * s), Math.round(fy * f + fx * s)];
      const specs = [['car', 9, -2, 35], ['suv', 12, 3, 150], ['pickup', 16, -4, 250], ['sedan', 15, 1, 95], ['cube_van', 22, 0, 200], ['car_sports', 11, 6, 320], ['policecar', 20, -7, 60]];
      const got = [];
      for (const [pr, f, s, a] of specs) { const [dx, dy] = at(f, s); got.push(!!c.spawnVehicle(pr, dx, dy, yaw + a, { status: 1, force: true })); }
      c.look(yaw, -7); ${SETTLE} ${HIDE} return got;`,
  },
  { id: '22-drive-night', hero: true, note: 'driving at night, headlights on (chase camera)', js: veh('drivechase') },
  { id: '23-drive-cockpit', note: 'driving at night from the driver seat', js: veh('drive') },
  { id: '24-parked-cars', note: 'parked and wrecked cars that mapgen put in town', js: veh('street') },
  // --- interiors and screens (HUD kept) ---
  {
    id: '40-house-looting', note: 'looting a house: the crosshair loot panel on a pile',
    js: `await lookView('house'); ${HANDS} const m = c.game.map, p = c.game.player; let best = null, bd = 1e9;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) { const x = p.tileX + dx, y = p.tileY + dy; const n = m.itemsAt(x, y, 0).length; const d = Math.hypot(dx, dy); if (n && d > 1 && d < bd) { bd = d; best = [x, y, n]; } }
      if (best) c.lookAt(best[0] + 0.5, best[1] + 0.5, -18); c.settle(); await new Promise((r) => setTimeout(r, 800)); return best;`,
  },
  {
    id: '41-inventory', note: 'the drag-and-drop inventory (replaces the curses lists)',
    js: `await lookView('house'); ${HANDS} for (const id of ['backpack', 'jeans', 'hoodie', 'sneakers']) c.giveItem(id, { wear: true }); for (const id of ['crowbar', 'flashlight', 'water_clean', 'can_beans', 'bandages', 'lighter', 'knife_steak']) c.giveItem(id); c.ui2.toggleInventory(); await new Promise((r) => setTimeout(r, 800)); return c.ui2.state?.();`,
  },
  {
    id: '42-crafting', note: 'crafting from BN recipes',
    js: `await lookView('house'); ${HANDS} for (const id of ['rag', 'rag', 'rag', 'stick', 'stick', 'rock', 'string_36', 'duct_tape', 'knife_steak']) c.giveItem(id); c.openCrafting(); await new Promise((r) => setTimeout(r, 800)); return 'crafting';`,
  },
  {
    id: '43-dialogue', note: 'talking to the refugee center merchant',
    js: `${RESET} c.setHour(11); c.teleportRefugeeCenter('merchant'); ${SETTLE} ${HANDS} c.talk(); await new Promise((r) => setTimeout(r, 2500)); return c.dialogue?.();`,
  },
  // --- time and weather (last: setSeason sticks for the rest of the run) ---
  // (tools/look-views.js has an empty duplicate "dusk" branch that swallows lookView('dusk'): do it by hand)
  { id: '30-dusk', note: 'the street at dusk', js: `await lookView('street'); c.setHour(window.duskHour()); ${SETTLE} ${HIDE} return 'dusk';` },
  { id: '31-night-flashlight', note: 'night on the street with a flashlight', js: look('night') },
  { id: '32-rain', note: 'rain', js: look('rain') },
  { id: '33-snow', note: 'winter snow', js: look('snow') },
  { id: '34-autumn-forest', hero: true, note: 'a forest in autumn', js: look('autumn') },
  { id: '35-winter-forest', note: 'the same forest in winter', js: look('winterforest') },
  // --- the five visual styles on the same street (reboot per look; ?look= is the Options > Visual style switch) ---
  { id: '50-style-full', params: 'look=full', note: 'visual style: full', js: look('street') },
  { id: '50-style-classic', params: 'look=classic', note: 'visual style: classic', js: look('street') },
  { id: '50-style-crisp', params: 'look=crisp', note: 'visual style: crisp', js: look('street') },
  { id: '50-style-terrain', params: 'look=terrain', note: 'visual style: terrain', js: look('street') },
  { id: '50-style-voxel', params: 'look=voxel', note: 'visual style: voxel', js: look('street') },
  // --- the same place as the 2D tileset game draws it vs the 3D engine (same frame of map) ---
  // The 3D top camera height is chosen so it spans the same 33.75 m the 32 px tiles view does.
  {
    id: '60-compare-town-3d', note: 'Holden town centre, top-down in the 3D engine',
    js: `${RESET} c.setHour(13); ${TOWN} c.teleportOmt(town.x, town.y, 0, 12, 12);
      for (const [dx, dy] of [[3, -4], [5, -3], [-6, 5], [8, 6], [-9, -7]]) c.spawnMonster('mon_zombie', dx, dy, { friendly: true });
      c.setCameraMode('top'); c.look(0, -10); const rig = c.renderer.rig; rig.topDistance = 33.75 / 2 / Math.tan(rig.fovTop * Math.PI / 360);
      ${SETTLE} ${HIDE} return { fov: rig.fovTop, d: rig.topDistance, p: [c.game.player.x, c.game.player.y] };`,
  },
  {
    id: '61-compare-town-tiles', note: 'the same area drawn tile-by-tile from the UltiCa tileset, like the 2D game',
    js: `const p = c.game.player; return tilesTopDown({ cx: p.x, cy: p.y });`,
  },
  {
    id: '62-compare-shelter-3d', note: 'the Evac Shelter, top-down in the 3D engine (roofs hidden)',
    js: `${RESET} c.setHour(11); c.teleportOmt(53, 39, 0, 12, 12); c.setCameraMode('top'); c.look(0, -10); const rig = c.renderer.rig; rig.topDistance = 33.75 / 2 / Math.tan(rig.fovTop * Math.PI / 360);
      ${SETTLE} ${HIDE} return c.renderer.rig.topDistance;`,
  },
  {
    id: '63-compare-shelter-tiles', note: 'the Evac Shelter from the UltiCa tileset',
    js: `const p = c.game.player; return tilesTopDown({ cx: p.x, cy: p.y });`,
  },
  // the map last: while it is open, later teleports don't take
  {
    id: '44-map', note: 'the overmap',
    js: `${RESET} c.setHour(11); ${TOWN} c.teleportOmt(53, 39, 0, 12, 12); ${SETTLE} c.ui.open('map'); await new Promise((r) => setTimeout(r, 1500)); return 'map';`,
  },
];
