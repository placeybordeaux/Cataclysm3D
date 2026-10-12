// Character comparison scenes (docs/CHARACTERS.md), evaluated in the page by
// tools/char-shots.ts after tools/look-views.js. Defines window.charView(name): sets up the
// street viewpoint, spawns the subject(s) ahead of the camera and waits for the pose asked for.
// Returns a short list of what is standing where. Plain JS so it can be pasted into
// `drive.ts eval` too.
window.charViews = ['horde_near', 'horde_mid', 'horde_far', 'horde_road', 'horde_dusk', 'dog', 'npc', 'windup', 'critters', 'zoo', 'night', 'third', 'props', 'bugs', 'zombies2', 'crawlers', 'crawl_move', 'crowd', 'fire', 'corpse', 'bench', 'fp_fists', 'fp_punch', 'fp_pistol', 'fp_pistol_fire', 'fp_rifle', 'fp_rifle_ads', 'fp_shotgun', 'fp_reload', 'fp_bat', 'fp_bat_swing', 'fp_guard', 'fp_knife', 'fp_axe', 'fp_spear', 'fp_katana', 'fp_flashlight', 'fp_bow', 'fp_revolver', 'fp_1911', 'fp_double', 'fp_ak', 'fp_hunting', 'fp_crowbar', 'fp_kitchen', 'fp_sledge', 'fp_lever', 'fp_lever_ads', 'fp_lever_fire', 'third_lever', 'npc_lever', 'zombie_lineup_a', 'zombie_lineup_b', 'zombie_lineup_c', 'zombie_lineup_d', 'zombie_lineup_far', 'zombie_lineup_windup', 'zombie_lineup_close', 'zombie_lineup_walk', 'zombie_lineup_dead', 'zombie_lineup_crawl', 'zombie_scene_crowd', 'zombie_scene_dusk', 'zombie_scene_night', 'zombie_scene_face'];
// An open paved strip (road, parking lot) so nothing stands in a flower bed or behind a tree:
// the nearest spot with (2*half+1) m x len m of pavement and no furniture ahead, in one of the
// four directions, preferring to look away from the sun so zombies are lit from the front.
// The game's map API (terAt/furnAt) is the ground truth.
window.zombieOpenStrip = (c, p, len, half) => {
  const m0 = c.game.map, px0 = Math.floor(p.x), py0 = Math.floor(p.y);
  const paved = (x, y) => /pavement|road|asphalt|parking|concrete|sidewalk/.test(m0.terAt(x, y, p.z).id) && m0.furnAt(x, y, p.z).id === 'f_null';
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const sun = c.renderer.skyState?.sunDir;
  const sunDot = (fx, fy) => (sun ? fx * sun.x + fy * sun.z : 0);
  let spot = null;
  for (let r = 0; r < 70 && !(spot && spot.score < -0.25); r += 2) for (let oy = -r; oy <= r; oy += 2) for (let ox = -r; ox <= r; ox += 2) {
    if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
    for (const [fx, fy] of dirs) {
      if (spot && sunDot(fx, fy) >= spot.score) continue;
      let ok = true;
      for (let f = 0; f <= len && ok; f++) for (let w = -half; w <= half && ok; w++) ok = paved(px0 + ox + fx * f - fy * w, py0 + oy + fy * f + fx * w);
      if (ok) spot = { x: px0 + ox, y: py0 + oy, fx, fy, score: sunDot(fx, fy) };
    }
  }
  if (!spot) throw new Error(`zombie views: no open paved strip ${len} m x ${2 * half + 1} m near the street view`);
  return spot;
};
window.charView = async (name) => {
  const c = window.cdda;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dusk = name === 'horde_dusk' || name === 'zombie_scene_dusk';
  c.game.paused = false;
  await window.lookView('street');
  c.clearMonsters();
  for (const n of c.npcs(true)) if (n.dist < 80) c.npcSystem.remove?.(c.npcSystem.npcByUid(n.uid));
  c.setHour(dusk ? 18.9 : 14);
  c.godMode(true);
  const p = c.game.player;
  const yaw0 = p.yaw;
  // spawn relative to the view direction: f = metres ahead, s = metres to the right
  const at = (f, s) => {
    const fx = Math.sin(yaw0), fy = -Math.cos(yaw0);
    return [Math.round(fx * f - fy * s), Math.round(fy * f + fx * s)];
  };
  const byUid = (uid) => c.monsterSystem.all.find((m) => m.uid === uid);
  // Pinned: stands still (IMMOBILE, like a turret) facing `deg` relative to the camera's view
  // (0 = away from us, 180 = toward us, 90 = broadside), idling — for portraits.
  const pin = (uid, deg) => {
    const m = byUid(uid);
    if (!m) return;
    m.type = { ...m.type, flags: [...m.type.flags, 'IMMOBILE'] };
    m.facing = yaw0 + (deg * Math.PI) / 180;
  };
  const spawnAt = (id, f, s, opts, deg) => {
    const [dx, dy] = at(f, s);
    const uid = c.spawnMonster(id, dx, dy, opts);
    if (uid === null) console.warn(`charView: could not spawn ${id} at ${dx},${dy}`);
    else if (deg !== undefined) pin(uid, deg);
    return uid;
  };
  const lookAt = (f, s, pitch) => c.look((yaw0 + Math.atan2(s, f)) * 180 / Math.PI, pitch);
  if (name.startsWith('horde')) {
    const range = name === 'horde_near' ? [4, 10] : name === 'horde_mid' ? [18, 30] : name === 'horde_dusk' ? [22, 48] : name === 'horde_road' ? [66, 110] : [38, 60];
    const ids = ['mon_zombie', 'mon_zombie', 'mon_zombie_fat', 'mon_zombie_cop', 'mon_zombie_child', 'mon_zombie_brute', 'mon_zombie_tough', 'mon_zombie_runner', 'mon_zombie_fireman', 'mon_zombie_soldier', 'mon_zombie', 'mon_zombie_hulk'];
    // near: posed facing us; further out: hostile and shambling toward the camera
    const near = name === 'horde_near';
    // stand in the road itself: the front-yard trees otherwise hide anything far down it
    c.teleport(p.x + Math.cos(yaw0) * 6, p.y + Math.sin(yaw0) * 6, p.z);
    const uids = [];
    for (let i = 0; i < 12; i++) {
      const f = range[0] + ((range[1] - range[0]) * i) / 11;
      // on the sidewalk and the road, clear of the front-yard trees
      uids.push(spawnAt(ids[i % ids.length], f, ((i * 7) % 5) - 2, near ? { friendly: true } : {}, near ? 160 + ((i * 37) % 40) : undefined));
    }
    // aim at the middle of the group as spawned (tile rounding moves them about)
    const ms = uids.map(byUid).filter(Boolean);
    const cx = ms.reduce((a, m) => a + m.x, 0) / ms.length, cy = ms.reduce((a, m) => a + m.y, 0) / ms.length;
    c.look(Math.atan2(cx - p.x, -(cy - p.y)) * 180 / Math.PI, near ? -6 : -1);
  } else if (name === 'bench') {
    // a street horde for frame timing: 60 hostiles 8-45 m out across the road
    const ids = ['mon_zombie', 'mon_zombie_fat', 'mon_zombie_cop', 'mon_zombie_child', 'mon_zombie_tough', 'mon_zombie_runner', 'mon_zombie_soldier', 'mon_dog', 'mon_zombie_dog', 'mon_zombie_brute'];
    for (let i = 0; i < 60; i++) spawnAt(ids[i % ids.length], 8 + (37 * i) / 59, 6 + ((i * 7) % 9) - 4, {});
    lookAt(20, 5, -2);
  } else if (name === 'zoo') {
    // one of every body plan, broadside, in rows (QA of the archetypes)
    const ids = ['mon_turret', 'mon_riotbot', 'mon_triffid', 'mon_fungaloid', 'mon_rattlesnake',
      'mon_manhack', 'mon_skeleton', 'mon_feral_human_pipe', 'mon_bat', 'mon_wasp',
      'mon_cat', 'mon_sewer_rat', 'mon_moose', 'mon_horse', 'mon_zombear',
      'mon_ant_soldier', 'mon_mi_go', 'mon_boomer', 'mon_chicken', 'mon_wolf'];
    ids.forEach((id, i) => spawnAt(id, 5 + Math.floor(i / 5) * 3.5, -4 + (i % 5) * 2.5 + 2, { friendly: true }, 90));
    lookAt(10, 2, -12);
  } else if (name === 'night') {
    c.setHour(23.2);
    c.flashlight(true);
    spawnAt('mon_zombie', 4, 0.5, { friendly: true }, 170);
    spawnAt('mon_zombie_fat', 7, 2, { friendly: true }, 200);
    spawnAt('mon_dog', 5.5, -1.5, { friendly: true }, 80);
    lookAt(5, 0.5, -6);
  } else if (name === 'third') {
    // the survivor's own body in the third-person camera, zombies closing in
    c.setCameraMode('third');
    spawnAt('mon_zombie', 5, -1.5, {});
    spawnAt('mon_zombie_cop', 7, 2, {});
    spawnAt('mon_zombie_dog', 9, 0.5, {});
    lookAt(1, 0, -12);
  } else if (name === 'third_lever') {
    // the survivor's own held mesh (playerModel.ts → held.ts) in the shoulder camera: a lever gun
    const p0 = c.game.player;
    if (p0.inv.wielded) p0.inv.unwield();
    c.giveItem('marlin_1894c', { wield: true });
    c.setCameraMode('third');
    lookAt(1, 0, -8);
  } else if (name === 'npc_lever') {
    // held meshes side by side at conversation range, broadside: Marlin 1894C (lever), Henry
    // (brass lever), Remington 700 (bolt hunting rifle) for contrast. The simulation is paused
    // for the shot so they stay broadside (the next view unpauses).
    const p0 = c.game.player;
    c.renderer.viewmodel.freeze(null);
    const guns = window.npcLeverGuns ?? ['marlin_1894c', 'henry_big_boy', 'remington_700'];
    const spawned = [];
    if (p0.inv.wielded) p0.inv.unwield();
    guns.forEach((id, i) => {
      const [dx, dy] = at(2.5 + i * 1.2, 0);
      const n = c.npcSystem.npcByUid(c.spawnNpc('NC_SCAVENGER', dx, dy, { attitude: 0 }));
      if (!n) return;
      c.giveItem(id, { wield: true });
      const it = p0.inv.wielded;
      // straight from the hands: unwield() can fail on a full inventory
      p0.inv.s.wielded = null;
      if (n.inv.wielded) n.inv.s.wielded = null;
      n.inv.wield(it, null);
      spawned.push(n);
    });
    // one tick so the NPC views exist; then stop the clock, point them all the same way with a
    // gun at the ready (a fight target), refresh their views by hand, and step the camera out
    // to the side so the guns are seen broadside
    c.step(1 / 30);
    c.game.paused = true;
    const view = c.game.systems.find((s) => s.name === 'npc-view');
    const fx = Math.sin(yaw0), fy = -Math.cos(yaw0);
    for (const n of spawned) {
      n.facing = yaw0 + Math.PI;
      n.goal = { kind: 'fight', x: n.x - fx * 10, y: n.y - fy * 10 };
    }
    const mid = spawned[1] ?? spawned[0];
    const sx = fy, sy = -fx; // to the left of the original view: the NPCs' right (gun) side
    const d = window.npcLeverDist ?? 2.6;
    c.teleport(mid.x + sx * d, mid.y + sy * d);
    c.look((Math.atan2(-sx, sy)) * 180 / Math.PI, window.npcLeverPitch ?? -14);
    for (let i = 0; i < 4; i++) { view?.update(c.game, 1 / 30, 1 / 30); c.renderer.render(); await wait(50); }
    c.settle();
    await wait(400);
    return name;
  } else if (name === 'bugs') {
    // round 6 body plans: wasp, bee, ant, spider, fly, mosquito, dragonfly, crow, bat
    const ids = ['mon_wasp', 'mon_bee', 'mon_ant', 'mon_spider_wolf_giant', 'mon_fly', 'mon_mosquito_giant', 'mon_dragonfly_giant', 'mon_crow', 'mon_bat'];
    ids.forEach((id, i) => spawnAt(id, 3 + Math.floor(i / 3) * 1.8, -2 + (i % 3) * 2, { friendly: true }, 90));
    lookAt(4.5, 0, -14);
  } else if (name === 'zombies2') {
    const ids = ['mon_boomer', 'mon_zombie_hulk', 'mon_skeleton', 'mon_zombie_acidic', 'mon_zombie_electric', 'mon_zombie_scorched'];
    ids.forEach((id, i) => spawnAt(id, 4 + Math.floor(i / 3) * 3, -2.5 + (i % 3) * 2.5, { friendly: true }, 170));
    lookAt(5.5, 0, -6);
  } else if (name === 'crawlers') {
    // game/crawl.ts: crawling bodies (broadside, head-on), with a walker for scale
    spawnAt('mon_zombie_crawler', 3.5, -1.2, { friendly: true }, 90);
    spawnAt('mon_zombie_crawler', 5, 1.4, { friendly: true }, 160);
    spawnAt('mon_zombie_creepy', 3, 2.6, { friendly: true }, 120);
    spawnAt('mon_zombie_crawler_pupa', 6.5, -2.6, { friendly: true }, 200);
    spawnAt('mon_crawler', 7, 3.5, { friendly: true }, 240);
    spawnAt('mon_zombie', 7.5, -0.2, { friendly: true }, 180);
    lookAt(5, 0.5, -14);
  } else if (name === 'crawl_move') {
    // a hostile crawler dragging itself toward the camera (caught mid-stroke)
    spawnAt('mon_zombie_crawler', 4.5, 0.8);
    spawnAt('mon_zombie_creepy', 6, -1.5);
    lookAt(4.5, 0, -16);
    c.settle();
    await wait(2200);
    return name;
  } else if (name === 'crowd') {
    // NPC variety: six people from the same classes side by side
    for (let i = 0; i < 6; i++) {
      const [dx, dy] = at(3 + (i % 2) * 1.2, -3 + i * 1.2);
      c.spawnNpc(i % 2 ? 'NC_SCAVENGER' : 'NC_WANDERING_SCAVENGER', dx, dy);
    }
    lookAt(3.6, 0, -6);
  } else if (name === 'fire') {
    const m = c.game.map;
    const [fx, fy] = at(3.5, 0);
    m.addField(Math.floor(p.x) + fx, Math.floor(p.y) + fy, p.z, 'fd_fire', 3);
    const [gx, gy] = at(4.5, 1.5);
    m.addField(Math.floor(p.x) + gx, Math.floor(p.y) + gy, p.z, 'fd_fire', 1);
    c.setHour(21.5);
    lookAt(4, 0.5, -10);
  } else if (name === 'props') {
    // round 5: things that used to be camera-facing billboards — a fire, loot on the floor,
    // a mannequin and a statue, arrows stuck in the ground
    const m = c.game.map;
    const T = (f, s2) => { const [dx, dy] = at(f, s2); return [Math.floor(p.x) + dx, Math.floor(p.y) + dy]; };
    const [fx, fy] = T(4, 0.5); m.addField(fx, fy, p.z, 'fd_fire', 2);
    const [mx, my] = T(5, -2.5); m.setFurn(mx, my, p.z, 'f_mannequin');
    const [sx, sy] = T(6.5, 3); m.setFurn(sx, sy, p.z, 'f_statue');
    for (const [i, id] of ['can_beans', 'bat', 'knife_combat', 'water_clean', 'jacket_leather'].entries()) {
      const [dx, dy] = at(2.5 + (i % 2), -1 + i * 0.6);
      c.spawnItem(id, dx, dy);
    }
    // real arrows on a tile, registered as landed shots so ArrowFx draws them stuck in the ground
    const [adx, ady] = at(3, 2.2);
    c.spawnItem('arrow_wood', adx, ady, { count: 3 });
    const ax = Math.floor(p.x) + adx, ay = Math.floor(p.y) + ady;
    const arrow = m.itemsAt(ax, ay, p.z).find((it) => it.typeId === 'arrow_wood');
    if (arrow && c.combat?.landed) for (let i = 0; i < 3; i++)
      c.combat.landed.push({ item: arrow, map: m, x: ax + 0.3 + i * 0.2, y: ay + 0.4 + i * 0.1, z: p.z, yaw: yaw0 + 0.4 * i, into: 'ground', hgt: 0 });
    c.setHour(18.5);
    lookAt(4, 0.5, -16);
  } else if (name.startsWith('fp_')) {
    // first-person hands and held items (fpView.ts / viewmodel.ts)
    const vm = c.renderer.viewmodel;
    vm.freeze(null);
    vm.ads = false;
    vm.bowSource = c.__bowSource ?? (c.__bowSource = vm.bowSource);
    const spec = {
      fp_fists: [null], fp_punch: [null, 'melee', 0.3], fp_pistol: ['glock_19'], fp_pistol_fire: ['glock_19', 'fire', 0.15],
      fp_rifle: ['m4a1'], fp_rifle_ads: ['m4a1', 'ads'], fp_shotgun: ['remington_870'], fp_reload: ['m4a1', 'reload'],
      fp_bat: ['bat'], fp_bat_swing: ['bat', 'swing'], fp_knife: ['knife_combat'], fp_axe: ['fire_ax'], fp_spear: ['spear_wood'],
      fp_katana: ['katana'], fp_flashlight: ['flashlight'], fp_bow: ['longbow', 'draw'], fp_guard: ['bat', 'guard'],
      fp_revolver: ['model_10_revolver'], fp_1911: ['m1911'], fp_double: ['shotgun_d'], fp_ak: ['ak47'], fp_hunting: ['remington_700'],
      fp_crowbar: ['crowbar'], fp_kitchen: ['knife_chef'], fp_sledge: ['hammer_sledge'],
      fp_lever: ['marlin_1894c'], fp_lever_ads: ['marlin_1894c', 'ads'], fp_lever_fire: ['marlin_1894c', 'fire', 0.5],
    }[name];
    if (!spec) throw new Error(`unknown view ${name}`);
    const [id, act, t] = spec;
    const p0 = c.game.player;
    if (p0.inv.wielded) p0.inv.unwield();
    if (id) c.giveItem(id, { wield: true });
    c.look(yaw0 * 180 / Math.PI + 30, -4);
    c.settle();
    await wait(400);
    // feel.ts sets ads from RMB every frame: pin it for the shot
    Object.defineProperty(vm, 'ads', act === 'ads' ? { get: () => true, set() {}, configurable: true } : { value: false, writable: true, configurable: true });
    if (act === 'ads') { /* pinned above */ }
    else if (act === 'reload') { vm.reload(1.2); await wait(350); vm.freeze && (vm.frozen = true); }
    else if (act === 'swing') vm.freeze('melee', 0.45);
    else if (act === 'guard') vm.setGuard(true);
    else if (act === 'draw') vm.bowSource = () => ({ style: 'draw', cls: 'bow', draw: 0.85, nocked: true, shake: 0, whirl: 0 });
    else if (act) vm.freeze(act, t);
    await wait(700);
    return name;
  } else if (name === 'dog') {
    spawnAt('mon_dog', 3.5, 0.5, { friendly: true }, 100);
    spawnAt('mon_zombie_dog', 5.5, 2.5, { friendly: true }, 220);
    lookAt(4.5, 1.5, -14);
  } else if (name === 'critters') {
    spawnAt('mon_squirrel', 3, 0, { friendly: true }, 100);
    spawnAt('mon_rabbit', 3, 2, { friendly: true }, 250);
    spawnAt('mon_giant_cockroach', 4.5, 4, { friendly: true }, 130);
    spawnAt('mon_spider_wolf_giant', 6, 0.5, { friendly: true }, 200);
    spawnAt('mon_crow', 4, 1, { friendly: true }, 80);
    spawnAt('mon_blob', 7, 3, { friendly: true }, 180);
    spawnAt('mon_deer', 10, 6, { friendly: true }, 100);
    spawnAt('mon_bear', 10, 1, { friendly: true }, 150);
    lookAt(6, 2.5, -10);
  } else if (name === 'npc') {
    const [dx, dy] = at(3, 0.5);
    c.spawnNpc('NC_SCAVENGER', dx, dy);
    const [dx2, dy2] = at(4.5, 2.5);
    c.spawnNpc('NC_SOLDIER', dx2, dy2);
    lookAt(3.5, 1.3, -6);
  } else if (name === 'corpse') {
    spawnAt('mon_zombie', 3, 0.5, {}, 180);
    spawnAt('mon_dog', 3.5, 2.5, {}, 90);
    spawnAt('mon_zombie_fat', 4.5, -1, {}, 200);
    spawnAt('mon_giant_cockroach', 4, 4, {}, 120);
    await wait(100);
    c.killAll(20);
    lookAt(3.5, 1.3, -30);
    await wait(1500);
  } else if (name.startsWith('zombie_scene')) {
    // Gallery scenes for choosing the zombie look (docs/GALLERY.md, ?zstyle=): zombies as you
    // meet them rather than in a row. _crowd/_dusk hide a few specials in a crowd of common
    // town zombies (picked by BN GROUP_ZOMBIE frequency) to test whether they can be picked out;
    // _night is the same question under a flashlight; _face is a fight at arm's length with a
    // bat raised: a blow coming, a heavy blow behind it and a runner crouching to lunge.
    const strip = window.zombieOpenStrip(c, p, 34, 7);
    c.teleport(strip.x + 0.5, strip.y + 0.5, p.z);
    const yaw = Math.atan2(strip.fx, -strip.fy);
    const atS = (f, s2) => [Math.round(strip.fx * f - strip.fy * s2), Math.round(strip.fy * f + strip.fx * s2)];
    // [id, metres ahead, metres right, facing (180 = toward us)]
    const crowd = [
      ['mon_zombie', 5, -1.5, 175], ['mon_zombie_fat', 6.5, 2, 195], ['mon_zombie_child', 7, -3.5, 160],
      ['mon_zombie_tough', 9, 0.5, 185], ['mon_zombie_brainless', 10, -2.5, 150], ['mon_boomer', 11, 3.5, 200],
      ['mon_zombie_rot', 12, -5, 170], ['mon_zombie', 13, 1.5, 140], ['mon_zombie_shrieker', 14, -1, 180],
      ['mon_zombie_cop', 15, 4.5, 210], ['mon_zombie_fat', 16, -3.5, 165], ['mon_zombie_brute', 17.5, 1, 190],
      ['mon_zombie_child', 18.5, 5.5, 150], ['mon_zombie_acidic', 19.5, -5.5, 175], ['mon_zombie', 21, -1.5, 200],
      ['mon_zombie_spitter', 22, 3, 160], ['mon_zombie_tough', 23.5, -4, 185], ['mon_zombie_soldier', 25, 0.5, 170],
      ['mon_zombie_brainless', 26.5, 5, 155], ['mon_zombie_necro', 28, -2.5, 190], ['mon_zombie_rot', 29.5, 2.5, 175],
      ['mon_zombie_fireman', 31, -5.5, 200], ['mon_zombie_hulk', 32.5, 1, 180],
    ];
    const night = [
      ['mon_zombie', 3.5, -0.8, 175], ['mon_zombie_fat', 5.5, 1.8, 200], ['mon_zombie_brute', 7.5, -2, 165],
      ['mon_zombie_necro', 10, 1, 185], ['mon_zombie_acidic', 12, -3, 170], ['mon_zombie_electric', 14, 2.5, 190],
    ];
    // face: [id, ahead, right, facing, telegraph kind, how far through it]
    const face = [
      ['mon_zombie', 1.5, -0.2, 180, 'melee', 0.75], ['mon_zombie_brute', 3.2, 1.3, 195, 'heavy', 0.6],
      ['mon_zombie_hunter', 5, -1.6, 165, 'leap', 0.85], ['mon_zombie_fat', 6.5, 2.4, 185, null, 0], ['mon_zombie', 8, -0.5, 175, null, 0],
    ];
    const isFace = name === 'zombie_scene_face', isNight = name === 'zombie_scene_night';
    const rows = isFace ? face : isNight ? night : crowd;
    if (isNight) { c.setHour(23.2); c.flashlight(true); }
    if (isFace) {
      if (p.inv.wielded) p.inv.unwield();
      c.giveItem('bat', { wield: true });
    }
    const uids = rows.map(([id, f, s2, deg]) => {
      const [dx, dy] = atS(f, s2);
      const uid = c.spawnMonster(id, dx, dy, { friendly: true });
      if (uid === null) { console.warn(`charView: could not spawn ${id}`); return uid; }
      const mm = byUid(uid);
      mm.type = { ...mm.type, flags: [...mm.type.flags, 'IMMOBILE'] };
      mm.facing = yaw + (deg * Math.PI) / 180;
      return uid;
    });
    c.look(yaw * 180 / Math.PI, isFace ? -4 : isNight ? -5 : -2);
    c.settle();
    await wait(600);
    c.game.paused = true;
    const mview = c.game.systems.find((s) => s.name === 'monster-view');
    const stepView = async (n) => { for (let i = 0; i < n; i++) { mview?.update(c.game, 1 / 30); c.renderer.render(); await wait(30); } };
    uids.forEach((uid, i) => {
      const mm = byUid(uid);
      if (!mm) return;
      mm.facing = yaw + (rows[i][3] * Math.PI) / 180;
      if (isFace && rows[i][4]) mm.windup = { t: 1 - rows[i][5], total: 1, kind: rows[i][4], special: null };
    });
    if (isFace) c.renderer.viewmodel?.setLowered?.(false);
    await stepView(isFace ? 3 : 20);
    await wait(300);
    return name;
  } else if (name.startsWith('zombie_lineup')) {
    // Zombie readability (docs/CHARACTERS.md "Zombie readability"): one row of zombies facing
    // us, ~4.5 m out (or 25 m for _far), idling in place, compared with the UltiCa sprite
    // sheets in docs/screenshots/zombies/. _windup freezes a few telegraphs mid-pose.
    const rows = window.zombieLineups ?? {
      zombie_lineup_a: ['mon_zombie', 'mon_zombie_fat', 'mon_zombie_tough', 'mon_zombie_child', 'mon_zombie_brainless', 'mon_zombie_rot', 'mon_zombie_acidic', 'mon_zombie_cop', 'mon_zombie_soldier'],
      zombie_lineup_b: ['mon_zombie_swat', 'mon_zombie_hazmat', 'mon_zombie_fireman', 'mon_zombie_static', 'mon_zombie_runner', 'mon_feral_human_pipe', 'mon_skeleton', 'mon_zombie_thorny', 'mon_zombie_necro'],
      zombie_lineup_c: ['mon_boomer', 'mon_boomer_huge', 'mon_zombie_brute', 'mon_zombie_shrieker', 'mon_zombie_spitter', 'mon_zombie_electric', 'mon_zombie_smoker', 'mon_zombie_grabber', 'mon_zombie_corrosive'],
      zombie_lineup_d: ['mon_zombie_master', 'mon_skeleton_brute', 'mon_zombie_screecher', 'mon_zombie_gasbag', 'mon_zombie_brute_shocker', 'mon_zombie_survivor', 'mon_zombie_bio_op', 'mon_zombie_predator', 'mon_zombie_hulk'],
      zombie_lineup_far: ['mon_zombie', 'mon_boomer', 'mon_zombie_brute', 'mon_zombie_hulk', 'mon_zombie_shrieker', 'mon_zombie_spitter', 'mon_zombie_electric', 'mon_zombie_necro', 'mon_skeleton', 'mon_zombie_cop', 'mon_zombie_child', 'mon_zombie_runner'],
      zombie_lineup_windup: ['mon_zombie', 'mon_zombie', 'mon_zombie_brute', 'mon_zombie_hunter', 'mon_zombie_hunter', 'mon_zombie_hunter'],
      // close up: individuals of one type differ (rags, a torn-off forearm, a dangling arm)
      zombie_lineup_close: ['mon_zombie', 'mon_zombie', 'mon_zombie', 'mon_zombie', 'mon_zombie'],
      // hostile, shambling toward the camera from 9-15 m (caught mid-stride)
      zombie_lineup_walk: ['mon_zombie', 'mon_zombie_fat', 'mon_zombie_brute', 'mon_zombie_runner', 'mon_boomer', 'mon_zombie', 'mon_zombie_shrieker', 'mon_zombie_cop', 'mon_zombie_hulk'],
      // bodies: the same row killed where it stood
      zombie_lineup_dead: ['mon_zombie', 'mon_boomer', 'mon_zombie_brute', 'mon_zombie_necro', 'mon_zombie_hulk', 'mon_skeleton'],
      // crawlers (game/crawl.ts) with a walker for scale
      zombie_lineup_crawl: ['mon_zombie_crawler', 'mon_zombie_creepy', 'mon_zombie', 'mon_zombie_crawler_pupa', 'mon_zombie_crawler'],
    };
    const ids = rows[name];
    if (!ids) throw new Error(`unknown lineup ${name}`);
    const far = name === 'zombie_lineup_far';
    const windup = name === 'zombie_lineup_windup';
    const close = name === 'zombie_lineup_close';
    const walking = name === 'zombie_lineup_walk', dead = name === 'zombie_lineup_dead';
    const dist = far ? 25 : windup ? 4 : close ? 2.6 : walking ? 12 : dead ? 4 : 4.5;
    const gap = far ? 2 : windup || dead ? 1.6 : 1;
    // windup: front, 3/4, broadside heavy, broadside crouch (leap), front crouch, broadside
    // lunge-grab (the strike after a leap); the rows stand at three-quarters like the sprites
    // (window.zombieLineupFacing overrides: 180 = facing us)
    const facing = windup ? [180, 140, 90, 90, 180, 90] : null;
    const rowDeg = window.zombieLineupFacing ?? 145;
    // 13 m x 30 m of open pavement (window.zombieOpenStrip)
    const spot = window.zombieOpenStrip(c, p, 30, 6);
    c.teleport(spot.x + 0.5, spot.y + 0.5, p.z);
    const yaw = Math.atan2(spot.fx, -spot.fy);
    const atL = (f, s2) => [Math.round(spot.fx * f - spot.fy * s2), Math.round(spot.fy * f + spot.fx * s2)];
    const uids = ids.map((id, i) => {
      const [dx, dy] = atL(dist + (walking ? (i % 3) * 1.5 : 0), (i - (ids.length - 1) / 2) * gap);
      const uid = c.spawnMonster(id, dx, dy, walking || dead ? {} : { friendly: true });
      if (uid === null) { console.warn(`charView: could not spawn ${id}`); return uid; }
      const mm = byUid(uid);
      if (walking) return uid;
      mm.type = { ...mm.type, flags: [...mm.type.flags, 'IMMOBILE'] };
      mm.facing = yaw + ((facing ? facing[i] : far ? 160 + ((i * 37) % 40) : rowDeg) * Math.PI) / 180;
      return uid;
    });
    c.look(yaw * 180 / Math.PI, far ? -1 : dead ? -22 : -6);
    c.settle();
    if (walking) {
      // let them come: the real AI and the real walk cycle
      await wait(1800);
      return name;
    }
    if (dead) {
      await wait(200);
      c.killAll(20);
      await wait(2200);
      return name;
    }
    await wait(600);
    // stop the clock so nobody turns away; the monster view is stepped by hand below
    c.game.paused = true;
    const mview = c.game.systems.find((s) => s.name === 'monster-view');
    const stepView = async (n) => { for (let i = 0; i < n; i++) { mview?.update(c.game, 1 / 30); c.renderer.render(); await wait(30); } };
    uids.forEach((uid, i) => { const mm = byUid(uid); if (mm && !windup) mm.facing = yaw + ((far ? 160 + ((i * 37) % 40) : rowDeg) * Math.PI) / 180; });
    if (windup) {
      // freeze the telegraphs: the clock stops, each monster gets a wind-up at a set point and
      // the monster view is stepped by hand so the pose is drawn
      const kinds = [['melee', 0.65], ['melee', 0.9], ['heavy', 0.7], ['leap', 0.8], ['leap', 0.8], ['leap', 1]];
      uids.forEach((uid, i) => {
        const m = byUid(uid);
        if (!m) return;
        const [kind, u] = kinds[i];
        m.windup = { t: 1 - u, total: 1, kind, special: null };
      });
      await stepView(3);
      // the last one has leapt: the wind-up is over and the strike (lunge-grab) plays
      const lunger = byUid(uids[5]);
      if (lunger) {
        lunger.windup = null;
        mview?.views?.get(lunger)?.c?.strike();
      }
      await stepView(1);
      await wait(300);
      return name;
    }
    await stepView(20);
    await wait(300);
    return name;
  } else if (name === 'windup') {
    spawnAt('mon_zombie', 1.6, 0);
    c.look(yaw0 * 180 / Math.PI, -2);
    // wait for a telegraphed blow and catch it about 60% of the way through its wind-up
    for (let i = 0; i < 400; i++) {
      const m = c.monsterSystem.active.find((x) => x.windup);
      if (m && 1 - m.windup.t / m.windup.total > 0.55) break;
      await wait(15);
    }
    return name;
  }
  c.settle();
  await wait(1200);
  return c.monsters(true).filter((m) => m.dist < 80).map((m) => `${m.id.replace('mon_', '')}@${Math.round(m.dist)}${m.dormant ? 'z' : ''}`).join(' ');
};
