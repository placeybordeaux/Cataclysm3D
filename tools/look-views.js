// The six comparison viewpoints for docs/LOOKS.md (seed=1). Evaluated in the page by
// tools/look-shots.sh: defines window.lookView(name) which sets the scene up and settles.
// Kept as plain JS so it can be pasted into `drive.ts eval` too.
window.lookViews = ['shelter', 'street', 'house', 'forest', 'night', 'top'];
window.lookView = async (name) => {
  const c = window.cdda;
  c.godMode(true);
  c.setWeather('clear');
  c.flashlight(false);
  c.setCameraMode('first');
  // hide every DOM overlay: the comparison is about the 3D image
  for (const el of document.body.querySelectorAll('body > *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
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
    const f = c.findOmt('forest', 60);
    c.teleportOmt(f.x, f.y, 0, 12, 22);
    c.look(-20, -3);
  } else if (name === 'night') {
    c.setHour(23.2);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 40);
    c.teleportOmt(h.x, h.y, 0, 23, 0);
    c.look(-100, -8);
    c.flashlight(true);
  } else if (name === 'top') {
    c.setHour(13);
    c.teleportOmt(town.x, town.y);
    c.setCameraMode('top');
    c.renderer.rig.topDistance = 40;
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
  return name;
};
