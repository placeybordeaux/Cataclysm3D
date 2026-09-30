// Page-side helpers shared by tools/perf-bench.ts (ghost car) and tools/realinput_perf.ts (real
// keyboard driving): pick a route on the seed's overmap and put a car at its start. cdda.* only
// sets the scene up; installs window.__perfBench.
export const PERF_PAGE = `(() => {
  const c = window.cdda;
  const roadRun = (x, y, dx, dy, max) => {
    let n = 0;
    while (n < max && /^road_/.test(c.omtAt(x + dx * n, y + dy * n, 0).id)) n++;
    return n;
  };
  const DIRS = [[1, 0, 0], [-1, 0, 180], [0, 1, 90], [0, -1, 270]]; // dx, dy, vehicle facing (0 = east, clockwise)
  /** Buildings (anything but road/field/forest/open ground) beside the first 'n' OMTs of a run. */
  const built = (x, y, dx, dy, n) => {
    let k = 0;
    for (let i = 0; i < n; i++) for (const s of [-1, 1]) {
      const id = c.omtAt(x + dx * i - dy * s, y + dy * i + dx * s, 0).id;
      if (!/^(road_|field|forest|swamp|river|lake|open_air|empty_rock)/.test(id)) k++;
    }
    return k;
  };
  /**
   * The best straight road run starting within 'r' OMTs of (cx, cy): the longest one (score =
   * length), or with 'dense' the one lined with the most buildings over its first 16 OMTs.
   */
  const bestRoad = (cx, cy, r, step, notIn, dense) => {
    let best = null;
    for (let oy = -r; oy <= r; oy += step) for (let ox = -r; ox <= r; ox += step) {
      const x = cx + ox, y = cy + oy;
      if (!/^road_/.test(c.omtAt(x, y, 0).id)) continue;
      if (notIn && notIn(x, y)) continue;
      for (const [dx, dy, f] of DIRS) {
        // only starts of runs: the OMT behind is not road
        if (/^road_/.test(c.omtAt(x - dx, y - dy, 0).id)) continue;
        const len = roadRun(x, y, dx, dy, 60);
        if (dense && len < 8) continue;
        const score = dense ? built(x, y, dx, dy, 16) : len;
        if (!best || score > best.score) best = { x, y, facing: f, len, dx, dy, score };
      }
    }
    return best;
  };
  window.__perfBench = {
    pick(kind) {
      const s = c.startLocation();
      const cities = c.cities();
      if (kind === 'town' || kind === 'city') {
        // town: the nearest one of size 4+; city: the biggest one within ~2 overmap regions.
        // The car starts 10 OMTs before the densest straight road, so the town streams in while
        // you drive into it (radius 8 would otherwise have built a small town before the start).
        const town = kind === 'town'
          ? cities.filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0]
          : cities.filter((t) => Math.hypot(t.x - s.omx, t.y - s.omy) < 100).sort((a, b) => b.size - a.size)[0];
        const r = bestRoad(town.x, town.y, town.size + 2, 1, null, true);
        return { ...r, town: town.name, lead: 10 };
      }
      if (kind === 'rural') {
        const inTown = (x, y) => cities.some((t) => Math.hypot(t.x - x, t.y - y) < t.size + 2);
        return bestRoad(s.omx, s.omy, 40, 2, inTown, false);
      }
      if (kind === 'forest') {
        const f = c.findOmt('forest_thick', 60);
        if (!f) throw new Error('no forest_thick near the start');
        // head away from the forest's edge: the direction with the most forest ahead
        let best = null;
        for (const [dx, dy, facing] of DIRS) {
          let n = 0;
          while (n < 30 && /forest/.test(c.omtAt(f.x + dx * n, f.y + dy * n, 0).id)) n++;
          if (!best || n > best.len) best = { x: f.x, y: f.y, facing, len: n, dx, dy };
        }
        return best;
      }
      throw new Error('unknown route kind ' + kind);
    },
    /** A car at the start of the route, facing along it, you at the wheel. */
    place(r) {
      const vs = c.vehicleSystem;
      if (vs.driving) { vs.driving.velocity = 0; c.exitVehicle(); }
      c.godMode(true);
      c.setWeather('clear');
      c.setHour(12);
      c.clearMonsters?.();
      // right-hand lane of the road, 'lead' OMTs (default 2) before its start
      const lead = r.lead ?? 2;
      const X = (r.x - r.dx * lead) * 24 + 12, Y = (r.y - r.dy * lead) * 24 + 12;
      const lx = -r.dy * 3, ly = r.dx * 3;
      c.teleport(X + lx + 0.5, Y + ly + 0.5, 0);
      const v = vs.spawn('car', Math.floor(X + lx), Math.floor(Y + ly), 0, r.facing, { fuel: 100, status: 0, force: true });
      if (!v) throw new Error('could not spawn the car');
      c.enterVehicle(v.uid);
      return v.uid;
    },
    /**
     * Real driving needs a clear road: parked and wrecked cars and monsters along the way would
     * end the run in a crash. Setup only (the driving itself is real keys): every 0.25 s,
     * everything but your car within 'm' metres goes.
     */
    clearRoute(m = 150) {
      const vs = c.vehicleSystem;
      let acc = 0;
      const sys = {
        name: 'perfClear',
        update: (_g, dt) => {
          if ((acc += dt) < 0.25) return;
          acc = 0;
          const me = vs.driving, p = c.game.player;
          for (const o of [...vs.list]) if (o !== me && Math.hypot(o.x - p.x, o.y - p.y) < m) vs.remove(o);
          c.clearMonsters?.();
          for (const part of Object.values(p.hp)) part.cur = part.max;
        },
      };
      c.game.systems.push(sys);
      this.stopClear = () => c.game.systems.splice(c.game.systems.indexOf(sys), 1);
    },
    /** Move the car (and you in it) straight ahead at mps, no collision, until stop(). */
    go(mps) {
      const vs = c.vehicleSystem, v = vs.driving, p = c.game.player;
      const [plx, ply] = v.worldToMount(p.x, p.y);
      const rad = (v.facing * Math.PI) / 180;
      const sys = {
        name: 'perfGhost',
        update: (_g, dt) => {
          v.x += Math.cos(rad) * mps * dt;
          v.y += Math.sin(rad) * mps * dt;
          vs.reindex(v);
          const [wx, wy] = v.mountToWorld(plx, ply);
          p.x = wx;
          p.y = wy;
          for (const part of Object.values(p.hp)) part.cur = part.max;
        },
      };
      c.game.systems.push(sys);
      this.stop = () => c.game.systems.splice(c.game.systems.indexOf(sys), 1);
    },
  };
})()`;

