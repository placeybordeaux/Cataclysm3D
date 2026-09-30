// Character comparison scenes (docs/CHARACTERS.md), evaluated in the page by
// tools/char-shots.ts after tools/look-views.js. Defines window.charView(name): sets up the
// street viewpoint, spawns the subject(s) ahead of the camera and waits for the pose asked for.
// Returns a short list of what is standing where. Plain JS so it can be pasted into
// `drive.ts eval` too.
window.charViews = ['horde_near', 'horde_mid', 'horde_far', 'horde_road', 'horde_dusk', 'dog', 'npc', 'windup', 'critters', 'zoo', 'night', 'third', 'props', 'bugs', 'zombies2', 'crowd', 'fire', 'corpse', 'bench', 'fp_fists', 'fp_punch', 'fp_pistol', 'fp_pistol_fire', 'fp_rifle', 'fp_rifle_ads', 'fp_shotgun', 'fp_reload', 'fp_bat', 'fp_bat_swing', 'fp_guard', 'fp_knife', 'fp_axe', 'fp_spear', 'fp_katana', 'fp_flashlight', 'fp_bow', 'fp_revolver', 'fp_1911', 'fp_double', 'fp_ak', 'fp_hunting', 'fp_crowbar', 'fp_kitchen', 'fp_sledge'];
window.charView = async (name) => {
  const c = window.cdda;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dusk = name === 'horde_dusk';
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
  } else if (name === 'bugs') {
    // round 6 body plans: wasp, bee, ant, spider, fly, mosquito, dragonfly, crow, bat
    const ids = ['mon_wasp', 'mon_bee', 'mon_ant', 'mon_spider_wolf_giant', 'mon_fly', 'mon_mosquito_giant', 'mon_dragonfly_giant', 'mon_crow', 'mon_bat'];
    ids.forEach((id, i) => spawnAt(id, 3 + Math.floor(i / 3) * 1.8, -2 + (i % 3) * 2, { friendly: true }, 90));
    lookAt(4.5, 0, -14);
  } else if (name === 'zombies2') {
    const ids = ['mon_boomer', 'mon_zombie_hulk', 'mon_skeleton', 'mon_zombie_acidic', 'mon_zombie_electric', 'mon_zombie_scorched'];
    ids.forEach((id, i) => spawnAt(id, 4 + Math.floor(i / 3) * 3, -2.5 + (i % 3) * 2.5, { friendly: true }, 170));
    lookAt(5.5, 0, -6);
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
