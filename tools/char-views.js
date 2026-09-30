// Character comparison scenes (docs/CHARACTERS.md), evaluated in the page by
// tools/char-shots.ts after tools/look-views.js. Defines window.charView(name): sets up the
// street viewpoint, spawns the subject(s) ahead of the camera and waits for the pose asked for.
// Plain JS so it can be pasted into `drive.ts eval` too.
window.charViews = ['horde_near', 'horde_mid', 'horde_far', 'horde_dusk', 'dog', 'npc', 'windup', 'critters', 'corpse'];
window.charView = async (name) => {
  const c = window.cdda;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const dusk = name === 'horde_dusk';
  await window.lookView('street');
  c.clearMonsters();
  for (const n of c.npcs(true)) if (n.dist < 80) c.npcSystem.remove?.(c.npcSystem.npcByUid(n.uid));
  c.setHour(dusk ? 19.6 : 14);
  const p = c.game.player;
  // spawn relative to the view direction: f = metres ahead, s = metres to the right
  const at = (f, s) => {
    const yaw = p.yaw;
    const fx = Math.sin(yaw), fy = -Math.cos(yaw);
    return [Math.round(fx * f - fy * s), Math.round(fy * f + fx * s)];
  };
  const spawnAt = (id, f, s, opts) => {
    const [dx, dy] = at(f, s);
    const uid = c.spawnMonster(id, dx, dy, opts);
    if (uid === null) console.warn(`charView: could not spawn ${id} at ${dx},${dy}`);
    return uid;
  };
  if (name.startsWith('horde')) {
    const range = name === 'horde_near' ? [4, 10] : name === 'horde_mid' ? [18, 30] : [38, 60];
    const ids = ['mon_zombie', 'mon_zombie', 'mon_zombie_fat', 'mon_zombie_cop', 'mon_zombie_child', 'mon_zombie_brute', 'mon_zombie_tough', 'mon_zombie_runner', 'mon_zombie_fireman', 'mon_zombie_soldier', 'mon_zombie', 'mon_zombie_hulk'];
    let k = 0;
    for (let i = 0; i < 12; i++) {
      const f = range[0] + ((range[1] - range[0]) * i) / 11;
      // on the sidewalk and the road, clear of the front-yard trees
      spawnAt(ids[k++ % ids.length], f, 3 + ((i * 7) % 5) - 1, { friendly: true });
    }
    const mid = (range[0] + range[1]) / 2;
    c.look(p.yaw * 180 / Math.PI + Math.atan2(4, mid) * 180 / Math.PI, name === 'horde_near' ? -6 : -1);
  } else if (name === 'dog') {
    spawnAt('mon_dog', 3.5, 0.6, { friendly: true });
    spawnAt('mon_zombie_dog', 5, -1.5, { friendly: true });
    c.look(p.yaw * 180 / Math.PI, -14);
  } else if (name === 'critters') {
    spawnAt('mon_squirrel', 3, -1, { friendly: true });
    spawnAt('mon_rabbit', 3, 1, { friendly: true });
    spawnAt('mon_giant_cockroach', 4, 0, { friendly: true });
    spawnAt('mon_spider_wolf_giant', 5.5, -1.5, { friendly: true });
    spawnAt('mon_crow', 4.5, 2, { friendly: true });
    spawnAt('mon_blob', 6, 1, { friendly: true });
    spawnAt('mon_deer', 9, -1, { friendly: true });
    spawnAt('mon_bear', 10, 3, { friendly: true });
    c.look(p.yaw * 180 / Math.PI, -12);
  } else if (name === 'npc') {
    const [dx, dy] = at(3, 0);
    c.spawnNpc('NC_SCAVENGER', dx, dy);
    const [dx2, dy2] = at(4, 1.5);
    c.spawnNpc('NC_SOLDIER', dx2, dy2);
    c.look(p.yaw * 180 / Math.PI, -8);
  } else if (name === 'corpse') {
    spawnAt('mon_zombie', 3, 0);
    spawnAt('mon_dog', 3.5, 1.4);
    spawnAt('mon_zombie_fat', 4.5, -1.2);
    await wait(100);
    c.killAll(20);
    c.look(p.yaw * 180 / Math.PI, -25);
    await wait(1500);
  } else if (name === 'windup') {
    c.godMode(true);
    spawnAt('mon_zombie', 1.6, 0);
    c.look(p.yaw * 180 / Math.PI, -2);
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
