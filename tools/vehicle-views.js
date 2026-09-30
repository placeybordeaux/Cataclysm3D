// Viewpoints for comparing vehicle renderers (docs/VEHICLES.md). Evaluated in the page by
// tools/vehicle-shots.ts after tools/look-views.js: defines window.vehicleView(name).
// Plain JS so it can be pasted into `drive.ts eval` too.
//
//   street            a town street with the parked / wrecked cars mapgen put there (3/4 view)
//   lineup:<a,b,..>   the prototypes side by side in a field, seen from the front 3/4
//   solo:<proto>[:<angle>[:<status>[:<dist>[:<hour>]]]]  (status: 0 intact, -1 used, 1 wrecked, smashed, trunk, burnt)
//                     one prototype, camera `angle` deg from its nose (90 = right side),
//                     spawn status (0 intact, -1 light damage, 1 wrecked), dist m off the body
//   drive / drivechase / driveday / drivedaychase / driverain   driving a car (night: headlights on; rain: wipers)
//   nightstreet       the street view at 23:00 with the nearest car's headlights on
//   top[:<dist>]      top-down camera over a street car (roofs hidden)
window.vehicleView = async (name) => {
  const c = window.cdda;
  c.godMode(true);
  if (c.vehicleSystem?.driving) c.exitVehicle();
  c.setWeather('clear');
  c.flashlight(false);
  c.setCameraMode('first');
  // only the 3D view: the HUD lives in #ui / #ui2 (which also hold small canvases)
  for (const el of document.body.querySelectorAll('body > *')) if (el.id !== 'view') el.style.visibility = 'hidden';
  const s = c.startLocation();
  const town = c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
  const field = () => {
    c.teleportOmt(town.x, town.y);
    const f = c.findOmt('field', 40);
    c.teleportOmt(f.x, f.y, 0, 12, 12);
    c.settle();
    // earlier spawns from a previous view would crowd the shot
    for (const v of [...c.vehicleSystem.list]) if (Math.hypot(v.x - c.game.player.x, v.y - c.game.player.y) < 40) c.vehicleSystem.remove?.(v);
  };
  const [kind, ...args] = name.split(':');
  if (kind === 'street' || kind === 'nightstreet') {
    c.setHour(kind === 'street' ? 15.5 : 23.2);
    c.teleportOmt(town.x, town.y);
    const skip = Number(args[0] ?? 0);
    const v = c.gotoVehicle('^(car|sedan|suv|pickup|car_sports|policecar|cube_van|van).*', { radius: 10, dist: 5, angle: 40, skip });
    if (!v) throw new Error('no car near town');
    if (kind === 'nightstreet') c.vehicleLights(true, v.uid);
  } else if (kind === 'lineup') {
    // a row along x, noses pointing south at the camera, which stands south-west of the row
    c.setHour(Number(args[1] ?? 15.5));
    field();
    const protos = args[0].split(',');
    const p = c.game.player;
    const x0 = p.tileX, y0 = p.tileY;
    let dx = -10;
    for (const pr of protos) {
      const r = c.spawnVehicle(pr, dx, -4, 90, { fuel: 50, status: Number(args[2] ?? 0), force: true });
      if (!r) throw new Error(`spawn ${pr} failed`);
      const v = c.vehicleSystem.list.find((q) => q.uid === r.uid);
      const [, vy0, , vy1] = v.bounds();
      // facing south: mount +y (right side) points west, so the next vehicle goes further east
      dx += vy1 - vy0 + 3;
    }
    const mid = x0 - 10 + (dx - 3 + 10) / 2;
    Object.assign(p, { x: mid - 4 + 0.5, y: y0 + Number(args[3] ?? 7) + 0.5 });
    c.look(Math.atan2(mid + 0.5 - p.x, -(y0 - 5 - p.y)) * 180 / Math.PI, -7);
  } else if (kind === 'solo') {
    const [proto, angle = '40', status = '0', dist = '3', hour = '15.5'] = args;
    c.setHour(Number(hour));
    field();
    // status 'smashed': intact car with every window broken, a flat tyre and a door open
    const smashed = status === 'smashed', trunk = status === 'trunk', burnt = status === 'burnt';
    const r = c.spawnVehicle(proto, 6, 0, 0, { fuel: 50, status: smashed || trunk ? 0 : burnt ? 1 : Number(status), force: true });
    if (!r) throw new Error(`spawn ${proto} failed`);
    if (trunk || burnt) {
      const v = c.vehicleSystem.list.find((q) => q.uid === r.uid);
      v.parts.forEach((q, i) => {
        q.open = trunk && q.def.flags.includes('MULTISQUARE');
        // burnt out: nearly everything wrecked, glass gone, one door hanging
        if (burnt && !q.def.flags.includes('WHEEL')) q.hp = (i * 7919) % 10 < 8 ? 0 : Math.round(q.def.durability * 0.2);
      });
      if (burnt) {
        v.wheels[0].hp = 0;
        v.wheels[1].hp = 0;
        const d = v.parts.find((q) => q.def.flags.includes('OPENABLE') && q.my < 0 && !q.def.flags.includes('MULTISQUARE'));
        if (d) d.open = true;
      }
      v.version++;
    }
    if (smashed) {
      const v = c.vehicleSystem.list.find((q) => q.uid === r.uid);
      for (const q of v.parts) {
        if (q.def.flags.includes('WINDSHIELD') || q.def.flags.includes('WINDOW')) q.hp = 0;
        q.open = false;
      }
      v.wheels[0].hp = 0;
      const door = v.parts.find((q) => q.def.flags.includes('OPENABLE') && q.my > 0);
      if (door) door.open = true;
      v.version++;
    }
    c.gotoVehicle(`^${proto}$`, { radius: 2, dist: Number(dist), angle: Number(angle) });
    if (Number(hour) > 20 || Number(hour) < 5) c.vehicleLights(true, r.uid);
  } else if (kind === 'drive' || kind === 'drivechase' || kind === 'driveday' || kind === 'drivedaychase' || kind === 'driverain') {
    const night = kind === 'drive' || kind === 'drivechase';
    c.setHour(night ? 23.2 : 15);
    c.teleportOmt(town.x, town.y);
    c.roadTrip(args[0] ?? 'car', 4, 40);
    // earlier drive views (and mapgen cars) can sit on the same spot: clear them away
    const me = c.vehicleSystem.driving;
    for (const v of [...c.vehicleSystem.list]) if (v !== me && Math.hypot(v.x - me.x, v.y - me.y) < 8) c.vehicleSystem.remove(v);
    if (night) c.vehicleLights(true);
    c.renderer.rig.driveCam = kind.endsWith('chase') ? 'chase' : 'cockpit';
    if (kind === 'driverain') c.setWeather('rain');
    c.drive(0, 0, 0.2);
  } else if (kind === 'top') {
    // top-down over the street: roofs hide so you see into the cabins
    c.setHour(13);
    c.teleportOmt(town.x, town.y);
    c.gotoVehicle('^(car|sedan|suv|pickup|cube_van).*', { radius: 10, dist: 2, angle: 90 });
    c.setCameraMode('top');
    c.renderer.rig.topDistance = Number(args[0] ?? 22);
  } else throw new Error(`unknown vehicle view ${name}`);
  c.settle();
  await new Promise((r) => setTimeout(r, 1500));
  c.settle();
  return name;
};
