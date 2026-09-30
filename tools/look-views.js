// The six comparison viewpoints for docs/LOOKS.md (seed=1). Evaluated in the page by
// tools/look-shots.sh: defines window.lookView(name) which sets the scene up and settles.
// Kept as plain JS so it can be pasted into `drive.ts eval` too.
window.lookViews = ['shelter', 'street', 'house', 'forest', 'night', 'top'];
// hide every DOM overlay: the comparison is about the 3D image
const hideOverlays = (root = document.body) => {
  for (const el of root.children) {
    if (el.tagName === 'CANVAS') continue;
    if (el.querySelector('canvas')) hideOverlays(el);
    else el.style.visibility = 'hidden';
  }
};
// A quarter hour before today's sunset (the real sun moves with the season: a fixed 19:30 is
// already night in early spring).
window.duskHour = () => {
  const r = window.cdda.renderer;
  window.cdda.settle();
  if (!r.sunT) throw new Error('duskHour: renderer has no sun times yet');
  return r.sunT.sunset - 0.25;
};
window.lookView = async (name) => {
  const c = window.cdda;
  c.godMode(true);
  if (c.vehicleSystem?.driving) c.exitVehicle();
  c.setWeather('clear');
  c.flashlight(false);
  c.setCameraMode('first');
  hideOverlays();
  const s = c.startLocation();
  const town = c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
  if (name === 'shelter') {
    c.setHour(11);
    c.teleport(s.x + 0.5, s.y + 0.5, s.z);
    c.look(200, -8);
  } else if (name === 'street') {
    // a residential street: on the verge in front of the nearest house, looking along it
    c.setHour(15.5);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 18, -1);
    c.look(-95, -2);
  } else if (name === 'house') {
    c.setHour(11);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 20);
    // stand in the middle of the biggest room, facing its nearest window
    const m = c.game.map, X0 = h.x * 24, Y0 = h.y * 24;
    c.teleportOmt(h.x, h.y, 0, 12, 12);
    c.settle();
    const indoor = (x, y) => { const t = m.terAt(x, y, 0); return c.renderer.chunks.covered(x, y, 0) && t.move_cost > 0 && !t.flags.includes('WINDOW') && !t.flags.includes('DOOR') && m.furnAt(x, y, 0).id === 'f_null'; };
    let best = null, bs = -1;
    for (let y = Y0 + 3; y < Y0 + 21; y++) for (let x = X0 + 3; x < X0 + 21; x++) {
      if (!indoor(x, y)) continue;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (indoor(x + dx, y + dy)) n++;
      if (n > bs) { bs = n; best = [x, y]; }
    }
    let win = null, wd = 1e9;
    for (let y = Y0; y < Y0 + 24; y++) for (let x = X0; x < X0 + 24; x++) {
      if (!m.terAt(x, y, 0).flags.includes('WINDOW')) continue;
      const d = Math.hypot(x - best[0], y - best[1]);
      if (d < wd && d > 2) { wd = d; win = [x, y]; }
    }
    c.teleport(best[0] + 0.5, best[1] + 0.5, 0);
    const yaw = win ? Math.atan2(win[0] - best[0], -(win[1] - best[1])) * 180 / Math.PI : 0;
    c.look(yaw + 25, -8);
  } else if (name === 'forest') {
    c.setHour(15);
    c.teleportOmt(town.x, town.y);
    const f = c.findOmt('forest', 60);
    c.teleportOmt(f.x, f.y, 0, 12, 22);
    c.look(-20, -3);
  } else if (name === 'night') {
    c.setHour(23.2);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 20, -1);
    c.look(-100, -8);
    c.flashlight(true);
  } else if (name === 'top') {
    c.setHour(13);
    c.teleportOmt(town.x, town.y);
    c.setCameraMode('top');
    c.renderer.rig.topDistance = 40;
  } else if (name === 'drive' || name === 'drivechase') {
    // night driving on a straight road, headlights on (docs/QA_V2.md #20)
    c.setHour(23.2);
    c.teleportOmt(town.x, town.y);
    c.roadTrip('car', 4, 40);
    c.vehicleLights(true);
    c.renderer.rig.driveCam = name === 'drive' ? 'cockpit' : 'chase';
  } else if (name === 'sky') {
    // clouds (QA_V2 #23): looking up over open ground
    c.setHour(10);
    c.setWeather('clear');
    c.renderer.sky.cloudiness = 0.6;
    c.teleportOmt(town.x, town.y);
    const f = c.findOmt('field', 30) ?? c.findOmt('forest', 30);
    c.teleportOmt(f.x, f.y, 0, 12, 12);
    c.look(30, 22);
  } else if (name === 'zombie' || name === 'zombie2') {
    // a zombie at arm's length / two tiles, dead ahead at eye level (QA_V2 #24)
    c.setHour(12);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 18, -1);
    c.clearMonsters();
    c.look(-90, 0);
    // friendly: it stays put and never swings (no hit shake in the shot)
    c.spawnMonster('mon_zombie', name === 'zombie' ? -1 : -2, 0, { friendly: true });
  } else if (name === 'zproxy') {
    // monsters without tileset art (QA_V2 #25: a floating green "Z" by the road)
    c.setHour(12);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 18, -1);
    c.clearMonsters();
    c.look(-90, -3);
    c.spawnMonster('mon_zombie_soldier_camo_1', -4, -1);
    c.spawnMonster('mon_zombie_nurse', -5, 1);
    c.spawnMonster('mon_zombie_dancer', -7, 0);
  } else if (name === 'snow') {
    c.setSeason('winter', 20);
    c.setHour(13);
    c.setWeather('snow');
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 18, -1);
    c.look(-95, -4);
  } else if (name === 'far' || name === 'fardusk' || name === 'farrain') {
    // Long-distance readability: stand at the south end of a straight north-south road in
    // town, looking up it, with zombies at ~15/30/50/75/100 m (can you spot them?).
    c.setHour(14);
    if (name === 'fardusk') c.setHour(window.duskHour());
    if (name === 'farrain') c.setWeather('rain');
    c.teleportOmt(town.x, town.y);
    const p = c.game.player;
    const ox = Math.floor(p.x / 24), oy = Math.floor(p.y / 24);
    let at = null;
    for (let r = 0; r <= 12 && !at; r++)
      for (let dy = -r; dy <= r && !at; dy++)
        for (let dx = -r; dx <= r && !at; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          let ok = true;
          for (let k = 0; k < 5 && ok; k++) ok = /^road_ns/.test(c.omtAt(ox + dx, oy + dy - k).id);
          if (ok) at = [ox + dx, oy + dy];
        }
    if (!at) throw new Error('far view: no straight road in town');
    c.teleportOmt(at[0], at[1], 0, 8, 22);
    c.look(4, -1);
    c.clearMonsters();
    // (monsters beyond the 60-tile reality bubble are dormant and not drawn at all)
    for (const [dx, dy] of [[1, -15], [3, -28], [-1, -42], [4, -58]]) c.spawnMonster('mon_zombie', dx, dy, { friendly: true });
  } else if (name === 'dusk') {
    await window.lookView('street');
    c.setHour(window.duskHour());
  } else if (name === 'rain') {
    await window.lookView('street');
    c.setWeather('rain');
  } else if (name === 'indoornight') {
    await window.lookView('house');
    c.setHour(23.2);
    c.flashlight(true);
  } else if (name.startsWith('at:')) {
    // probe form for picking viewpoints: at:<omt text|town>:<lx>:<ly>:<yaw>:<pitch>:<hour>[:top]
    const [, what, lx, ly, yaw, pitch, hour, mode] = name.split(':');
    c.setHour(Number(hour));
    c.teleportOmt(town.x, town.y);
    const o = what === 'town' ? town : c.findOmt(what, 40);
    c.teleportOmt(o.x, o.y, 0, Number(lx), Number(ly));
    c.look(Number(yaw), Number(pitch));
    if (mode === 'top') { c.setCameraMode('top'); c.renderer.rig.topDistance = 60; }
  } else throw new Error(`unknown view ${name}`);
  c.settle();
  // let the light map, exposure and shadows converge
  await new Promise((r) => setTimeout(r, 1500));
  c.settle();
  // popups (discovery hints, spotted-monster toasts) appear after setup: hide them too
  hideOverlays();
  return name;
};
