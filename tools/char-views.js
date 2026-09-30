// Character comparison scenes (docs/CHARACTERS.md), evaluated in the page by
// tools/char-shots.ts after tools/look-views.js. Defines window.charView(name): sets up the
// street viewpoint, spawns the subject(s) ahead of the camera and waits for the pose asked for.
// Returns a short list of what is standing where. Plain JS so it can be pasted into
// `drive.ts eval` too.
window.charViews = ['horde_near', 'horde_mid', 'horde_far', 'horde_road', 'horde_dusk', 'dog', 'npc', 'windup', 'critters', 'zoo', 'night', 'third', 'corpse', 'bench'];
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
  const byUid = (uid) => c.monsterSystem.active.find((m) => m.uid === uid);
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
    const uids = [];
    for (let i = 0; i < 12; i++) {
      const f = range[0] + ((range[1] - range[0]) * i) / 11;
      // on the sidewalk and the road, clear of the front-yard trees
      uids.push(spawnAt(ids[i % ids.length], f, 6 + ((i * 7) % 5) - 2, near ? { friendly: true } : {}, near ? 160 + ((i * 37) % 40) : undefined));
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
