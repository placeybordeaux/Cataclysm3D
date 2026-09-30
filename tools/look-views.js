// The six comparison viewpoints for docs/LOOKS.md (seed=1). Evaluated in the page by
// tools/look-shots.sh: defines window.lookView(name) which sets the scene up and settles.
// Kept as plain JS so it can be pasted into `drive.ts eval` too.
window.lookViews = ['shelter', 'street', 'house', 'forest', 'night', 'top'];
window.lookView = async (name) => {
  const c = window.cdda;
  c.godMode(true);
  if (c.vehicleSystem?.driving) c.exitVehicle();
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
  } else if (name === 'indoornight') {
    await window.lookView('house');
    c.setHour(23.2);
    c.flashlight(true);
  } else if (name.startsWith('furn:') || name.startsWith('ter:')) {
    // furniture/fixture close-ups (docs/FURNITURE.md): furn:<id regex>[:<n-th match>[:<dist>[:<pitch>[:<hour>]]]]
    // Finds the n-th match around the town, stands `dist` tiles away on open floor in the
    // same room (the side with the most free floor) and looks at it.
    // optional 7th field: replace the found terrain/furniture with that id (e.g. break a window)
    const [kind, re, nth = '0', dist = '2', pitch = '-22', hour = '11', replace = ''] = name.split(':');
    c.setHour(Number(hour));
    c.teleportOmt(town.x, town.y);
    c.settle();
    const m = c.game.map, rx = new RegExp(re);
    const P = c.game.player, px = Math.floor(P.x), py = Math.floor(P.y);
    const hit = (x, y) => kind === 'furn' ? rx.test(m.furnAt(x, y, 0).id) : rx.test(m.terAt(x, y, 0).id);
    const found = [];
    for (let r = 0; r <= 70 && found.length <= Number(nth); r++)
      for (let y = py - r; y <= py + r; y++)
        for (let x = px - r; x <= px + r; x++) {
          if (Math.max(Math.abs(x - px), Math.abs(y - py)) !== r) continue;
          if (hit(x, y)) found.push([x, y]);
        }
    const t = found[Number(nth)];
    if (!t) throw new Error(`no ${kind} matching ${re}`);
    const free = (x, y) => { const tt = m.terAt(x, y, 0), ff = m.furnAt(x, y, 0); return tt.move_cost > 0 && !tt.flags.includes('WINDOW') && (ff.id === 'f_null' || (ff.move_cost_mod >= 0 && !/table|chair|bench/.test(ff.id))); };
    let best = null, bs = -1;
    // no good spot at the asked distance (tight rooms): try a little further out
    for (let D = Number(dist); D <= Number(dist) + 3 && !best; D++) for (let dy = -D; dy <= D; dy++) for (let dx = -D; dx <= D; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== D) continue;
      const x = t[0] + dx, y = t[1] + dy;
      if (!free(x, y)) continue;
      // clear straight line to the target and open floor around the spot
      let ok = true;
      for (let k = 1; k < D * 2; k++) {
        const ix = Math.round(x + (t[0] - x) * k / (D * 2)), iy = Math.round(y + (t[1] - y) * k / (D * 2));
        if ((ix !== t[0] || iy !== t[1]) && m.terAt(ix, iy, 0).move_cost <= 0) ok = false;
      }
      if (!ok) continue;
      let n = 0;
      for (let ey = -1; ey <= 1; ey++) for (let ex = -1; ex <= 1; ex++) if (free(x + ex, y + ey)) n++;
      // straight-on views (dx or dy = 0) show fronts, not corners
      n += dx === 0 || dy === 0 ? 3 : 0;
      if (n > bs) { bs = n; best = [x, y]; }
    }
    if (!best) throw new Error(`no free spot with a view of ${kind} ${re} at ${t}`);
    if (replace) { if (kind === 'ter') m.setTer(t[0], t[1], 0, replace); else m.setFurn(t[0], t[1], 0, replace); }
    c.teleport(best[0] + 0.5, best[1] + 0.5, 0);
    c.lookAt(t[0] + 0.5, t[1] + 0.5, Number(pitch));
  } else if (name === 'gallery' || name.startsWith('gallery:')) {
    // a showroom of furniture on open ground (gallery:<ids joined by +>), for iterating on
    // the modelled furniture: rows of 5, two tiles apart, seen from above-front
    const ids = name.includes(':') ? name.slice(8).split('+') : ['f_chair', 'f_table', 'f_sofa', 'f_armchair', 'f_bed', 'f_dresser', 'f_bookcase', 'f_desk', 'f_counter', 'f_cupboard'];
    c.setHour(11);
    c.teleportOmt(town.x, town.y);
    const f = c.findOmt('field', 30) ?? c.findOmt('forest', 30);
    c.teleportOmt(f.x, f.y, 0, 12, 12);
    const m = c.game.map, P = c.game.player, x0 = Math.floor(P.x), y0 = Math.floor(P.y);
    for (let y = y0 - 12; y <= y0 + 3; y++) for (let x = x0 - 7; x <= x0 + 7; x++) {
      m.setTer(x, y, 0, 't_floor'); m.setFurn(x, y, 0, 'f_null');
      for (const it of [...m.itemsAt(x, y, 0)]) m.removeItem(x, y, 0, it);
      m.setTer(x, y, 1, 't_open_air'); m.setFurn(x, y, 1, 'f_null');
    }
    c.clearMonsters?.();
    ids.forEach((id, i) => {
      const gx = x0 - 4 + (i % 5) * 2, gy = y0 - 3 - Math.floor(i / 5) * 2;
      if (id.startsWith('t_')) m.setTer(gx, gy, 0, id); else if (id.startsWith('i:')) c.placeItem(id.slice(2), gx - x0, gy - y0); else m.setFurn(gx, gy, 0, id);
    });
    c.teleport(x0 + 0.5, y0 + 0.2, 0);
    c.look(0, -22);
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
