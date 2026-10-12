import type { HosePoint } from './activity';
import type { Game } from './game';
import type { Item } from './item';
import { createItem } from './item';
import { liquidTargets, type LiquidTarget } from './liquid';
import { L, moveItem } from './moves';
import { PUMP_L_PER_S, fillTanks, playerReaches, tankRoom, vehiclesByPump } from './refuel';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { distinctVehicleNames } from './vehicleNames';
import type { BodyRect } from './vehicleShape';

/** Runtime vehicle tanks store ml; BN liquid items count charges of varying volumes. */
export function tankMlPerCharge(v: Vehicle, tank: VehiclePart): number {
  const perLitre = v.vdata.fuels[tank.fuelType ?? '']?.chargesPerL;
  return perLitre && perLitre > 0 ? 1000 / perLitre : 0;
}
export function liquidSample(game: Game, v: Vehicle, tank: VehiclePart): Item | null {
  if (!tank.fuelType || !game.data.items[tank.fuelType]) return null;
  const ml = tankMlPerCharge(v, tank);
  if (!ml || tank.charges < ml) return null;
  const item = createItem(game.data, tank.fuelType, { charges: Math.floor(tank.charges / ml + 1e-9) });
  return item.isLiquid() ? item : null;
}

export function siphonReason(game: Game, v: Vehicle, tank: VehiclePart): string | null {
  if (!v.parts.includes(tank) || !has(tank, 'FLUIDTANK') || tank.hp <= 0) return 'Select an intact liquid tank.';
  if (Math.abs(v.velocity) > 0.05) return 'You cannot siphon from a moving vehicle.';
  if (!game.player.inv.hasQuality('HOSE', 1)) return 'You need a hose to siphon liquid.';
  // BN siphons from veh_interact, opened next to any part of the vehicle: the hose reaches the
  // tank from there. Asking for the tank's own square was a port rule nobody could see.
  if (!playerReaches(game, v)) return `Stand next to the ${v.name} to reach it with the hose.`;
  if (!liquidSample(game, v, tank)) return 'There is no transferable liquid left in this tank.';
  return null;
}

export function siphonTargets(game: Game, v: Vehicle, tank: VehiclePart): LiquidTarget[] {
  const sample = liquidSample(game, v, tank);
  return sample ? liquidTargets(game, sample) : [];
}

/** Convert actual stored ml to real liquid items, draining only the successful move. */
export function siphonInto(game: Game, v: Vehicle, tank: VehiclePart, container: Item, ml: number): number {
  if (siphonReason(game, v, tank)) return 0;
  return transferTankInto(game, v, tank, container, ml);
}

/** Shared tank-to-item conversion. Caller must validate its physical access method. */
export function transferTankInto(game: Game, v: Vehicle, tank: VehiclePart, container: Item, ml: number): number {
  if (!Number.isFinite(ml) || ml <= 0 || !v.parts.includes(tank) || !has(tank, 'FLUIDTANK') || tank.hp <= 0) return 0;
  if (!siphonTargets(game, v, tank).some(t => t.item === container)) return 0;
  const sample = liquidSample(game, v, tank)!;
  const perCharge = tankMlPerCharge(v, tank);
  const count = Math.floor(Math.min(ml, tank.charges) / perCharge + 1e-9);
  if (count <= 0) return 0;
  sample.charges = count;
  const result = moveItem(sample, null, L.in(container), { partial: true, actor: game.player, quiet: true });
  if (!result.ok) return 0;
  const movedMl = result.moved * perCharge;
  tank.charges = Math.max(0, tank.charges - movedMl);
  v.version++;
  return movedMl;
}

/** BN fill-liquid rate, timed and interruptible; completed transfers survive interruption. */
export function startSiphoning(game: Game, v: Vehicle, tank: VehiclePart, container: Item): boolean {
  const reason = siphonReason(game, v, tank);
  if (reason) { game.message(reason, 'c_yellow'); return false; }
  const target = siphonTargets(game, v, tank).find(t => t.item === container);
  if (!target) { game.message('That container cannot take the liquid or is out of reach.', 'c_yellow'); return false; }
  const perCharge = tankMlPerCharge(v, tank);
  const wanted = Math.min(Math.floor(tank.charges / perCharge) * perCharge, target.room * perCharge);
  let creditMl = 0;
  let transferredMl = 0;
  let aborted = false;
  return game.activities.start({
    name: `siphoning ${liquidSample(game, v, tank)!.baseName()} into ${container.baseName()}`,
    duration: wanted / (PUMP_L_PER_S * 1000),
    kind: 'siphon', target: tank,
    hose: { style: 'hose', from: () => tankPoint(game, v, tank), to: () => containerPoint(game, container), color: liquidColor(tank.fuelType), path: (a, b) => hosePath(game, a, b, [v]) },
    at: { x: Math.floor(v.x), y: Math.floor(v.y), z: v.z },
    onProgress: dt => {
      const reason = siphonReason(game, v, tank);
      if (reason || !siphonTargets(game, v, tank).some(t => t.item === container)) {
        aborted = true;
        game.activities.cancel(reason ?? 'The container is full or out of reach.');
        return;
      }
      creditMl += dt * PUMP_L_PER_S * 1000;
      const moved = siphonInto(game, v, tank, container, Math.min(creditMl, wanted - transferredMl));
      creditMl -= moved;
      transferredMl += moved;
    },
    onComplete: () => {
      if (aborted) return;
      game.message(`You siphon ${(transferredMl / 1000).toFixed(2)} L into the ${container.baseName()}.`);
    },
    onCancel: () => game.message(`Siphoning stops; ${(transferredMl / 1000).toFixed(2)} L already transferred is kept.`),
  });
}

/**
 * Other vehicles the hose reaches that can take this tank's liquid, nearest first. BN
 * liquid_handler offers "Fill nearby vehicle %s" for vehicles next to you with a tank that
 * can be reloaded with the liquid; the port measures reach like the gas pump does.
 */
export function siphonVehicleTargets(game: Game, v: Vehicle, tank: VehiclePart): { vehicle: Vehicle; roomMl: number }[] {
  const vs = game.vehicles;
  if (!vs || !tank.fuelType || !liquidSample(game, v, tank)) return [];
  const p = game.player;
  return vehiclesByPump(vs, p.tileX, p.tileY, p.z)
    .filter(o => o !== v)
    .map(o => ({ vehicle: o, roomMl: tankRoom(o, tank.fuelType!) }))
    .filter(t => t.roomMl > 0);
}

/** Tank to another vehicle's tanks, ml for ml (both store ml). Caller-independent guards. */
export function siphonIntoVehicle(game: Game, v: Vehicle, tank: VehiclePart, to: Vehicle, ml: number): number {
  if (!Number.isFinite(ml) || ml <= 0 || siphonReason(game, v, tank)) return 0;
  if (!siphonVehicleTargets(game, v, tank).some(t => t.vehicle === to)) return 0;
  const moved = fillTanks(to, tank.fuelType!, Math.min(ml, tank.charges));
  if (moved <= 0) return 0;
  tank.charges = Math.max(0, tank.charges - moved);
  v.version++;
  return moved;
}

/**
 * Timed like the container fill. BN pours into a vehicle in one go for 1000 moves; the port
 * keeps the hose rate so a 50 L tank takes as long as filling cans would.
 */
export function startSiphoningToVehicle(game: Game, v: Vehicle, tank: VehiclePart, to: Vehicle): boolean {
  const reason = siphonReason(game, v, tank);
  if (reason) { game.message(reason, 'c_yellow'); return false; }
  const target = siphonVehicleTargets(game, v, tank).find(t => t.vehicle === to);
  if (!target) { game.message(`The ${to.name} can't take it or is out of reach.`, 'c_yellow'); return false; }
  const wanted = Math.min(tank.charges, target.roomMl);
  // "the red Car to your left" when the source is a Car too (vehicleNames.ts)
  const the = distinctVehicleNames(game, [to], [v, ...siphonVehicleTargets(game, v, tank).map(t => t.vehicle)]).get(to)!;
  let creditMl = 0;
  let transferredMl = 0;
  let aborted = false;
  return game.activities.start({
    name: `siphoning ${liquidSample(game, v, tank)!.baseName()} into ${the}`,
    duration: wanted / (PUMP_L_PER_S * 1000),
    kind: 'siphon', target: tank,
    hose: { style: 'hose', from: () => tankPoint(game, v, tank), to: () => nearestTankPoint(game, to, tank.fuelType!), color: liquidColor(tank.fuelType), path: (a, b) => hosePath(game, a, b, [v, to]) },
    at: { x: Math.floor(v.x), y: Math.floor(v.y), z: v.z },
    onProgress: dt => {
      const reason = siphonReason(game, v, tank);
      if (reason || !siphonVehicleTargets(game, v, tank).some(t => t.vehicle === to)) {
        aborted = true;
        game.activities.cancel(reason ?? `The ${to.name} is full or out of reach.`);
        return;
      }
      creditMl += dt * PUMP_L_PER_S * 1000;
      const moved = siphonIntoVehicle(game, v, tank, to, Math.floor(Math.min(creditMl, wanted - transferredMl) + 1e-6));
      creditMl -= moved;
      transferredMl += moved;
    },
    onComplete: () => {
      if (aborted) return;
      game.message(`You siphon ${(transferredMl / 1000).toFixed(2)} L into ${the}.`);
    },
    onCancel: () => game.message(`Siphoning stops; ${(transferredMl / 1000).toFixed(2)} L already transferred is kept.`),
  });
}

// ---- where the hose runs (src/render/hoseFx.ts reads these through ActivitySpec.hose)

/** Filler-cap height on a vehicle tank, metres above the floor (a car's rear quarter panel). */
const TANK_NECK_H = 0.8;
/** The cap stands this far proud of the paint, so the hose doesn't start inside the body. */
const NECK_OUT = 0.04;
/** How far from a body the hose lies on the ground (its corners are rounded off by the curve). */
const HOSE_CLEAR = 0.3;

const LIQUID_COLORS: Record<string, number> = {
  gasoline: 0xd8b040, avgas: 0xd8b040, diesel: 0x9a8a30, biodiesel: 0x9a8a30, jp8: 0xb8a050,
  lamp_oil: 0xc0a040, water: 0x6a90b0, water_clean: 0x5aa0d8, milk: 0xf0f0e8,
};
export function liquidColor(id: string | undefined): number {
  return LIQUID_COLORS[id ?? ''] ?? 0xb09060;
}

/** The body as drawn (its chassis template) in mount coordinates, else its whole tiles. */
function bodyOf(game: Game, v: Vehicle): BodyRect {
  const b = game.vehicles?.bodyRect(v);
  if (b) return b;
  const xs = v.parts.map(p => p.mx), ys = v.parts.map(p => p.my);
  return { x0: Math.min(...xs) - 0.5, x1: Math.max(...xs) + 0.5, y0: Math.min(...ys) - 0.5, y1: Math.max(...ys) + 0.5 };
}

/**
 * The point on `v`'s body side nearest mount point (mx, my), `h` up, standing `out` metres
 * proud of the paint, with the side's outward facing. A point inside the body goes to its
 * nearest side; one outside is clamped onto the side facing it.
 */
function sidePoint(game: Game, v: Vehicle, mx: number, my: number, h: number, out: number): HosePoint {
  const b = bodyOf(game, v);
  const cx = Math.min(b.x1, Math.max(b.x0, mx)), cy = Math.min(b.y1, Math.max(b.y0, my));
  const edges: [number, number, number][] = [[cx - b.x0, -1, 0], [b.x1 - cx, 1, 0], [cy - b.y0, 0, -1], [b.y1 - cy, 0, 1]];
  const [, ex, ey] = edges.reduce((a, e) => (e[0] < a[0] ? e : a));
  const px = ex ? (ex < 0 ? b.x0 : b.x1) + ex * out : cx;
  const py = ey ? (ey < 0 ? b.y0 : b.y1) + ey * out : cy;
  const [x, y] = v.mountToWorld(px, py);
  const [ox, oy] = v.mountToWorld(px + ex, py + ey);
  return { x, y, z: v.z, h, nx: ox - x, ny: oy - y };
}

/**
 * The tank's filler cap: on the body's side nearest the tank (a car's tank sits at the rear
 * corner; its tile centre is outside the painted body, or deep inside a wide one), facing out.
 */
export function tankPoint(game: Game, v: Vehicle, tank: VehiclePart): HosePoint | null {
  if (!v.parts.includes(tank)) return null;
  return sidePoint(game, v, tank.mx, tank.my, TANK_NECK_H, NECK_OUT);
}

/** The body side nearest world point (x, y) at filler height: where a can is poured from there. */
export function sidePointNear(game: Game, v: Vehicle, x: number, y: number): HosePoint {
  const [mx, my] = v.worldToMount(x, y);
  return sidePoint(game, v, mx, my, TANK_NECK_H, NECK_OUT);
}

/** The tank of `fuel` on `v` nearest the survivor (where the hose goes in), else its nearest tank. */
export function nearestTankPoint(game: Game, v: Vehicle, fuel: string): HosePoint | null {
  const tanks = v.parts.filter(p => has(p, 'FLUIDTANK') && p.hp > 0);
  const pick = tanks.filter(p => p.fuelType === fuel).length ? tanks.filter(p => p.fuelType === fuel) : tanks;
  let best: HosePoint | null = null, bestD = Infinity;
  for (const t of pick) {
    const pt = tankPoint(game, v, t)!;
    const d = Math.hypot(pt.x - game.player.x, pt.y - game.player.y);
    if (d < bestD) { bestD = d; best = pt; }
  }
  return best;
}

/** A carried container is held in front of you; one on the ground sits on its tile. */
export function containerPoint(game: Game, container: Item): HosePoint | null {
  const p = game.player;
  if (p.inv.has(container)) return { x: p.x + Math.sin(p.yaw) * 0.3, y: p.y - Math.cos(p.yaw) * 0.3, z: p.z, h: 0.9 };
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const mi of game.map.itemsAt(p.tileX + dx, p.tileY + dy, p.z) as Item[])
        if (typeof mi.walk === 'function' && [...mi.walk()].includes(container))
          return { x: p.tileX + dx + 0.5, y: p.tileY + dy + 0.5, z: p.z, h: 0.2 };
  return null;
}

type P2 = { x: number; y: number };

/** Does segment p→q pass through the inside of rect r (Liang–Barsky, touching edges is fine)? */
function crosses(p: P2, q: P2, r: BodyRect): boolean {
  const e = 1e-4, x0 = r.x0 + e, x1 = r.x1 - e, y0 = r.y0 + e, y1 = r.y1 - e;
  let t0 = 0, t1 = 1;
  const dx = q.x - p.x, dy = q.y - p.y;
  for (const [pp, qq] of [[-dx, p.x - x0], [dx, x1 - p.x], [-dy, p.y - y0], [dy, y1 - p.y]]) {
    if (pp === 0) { if (qq < 0) return false; continue; }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Move a point lying inside rect r out through its nearest side. */
function pushOut(p: P2, r: BodyRect): P2 {
  if (p.x <= r.x0 || p.x >= r.x1 || p.y <= r.y0 || p.y >= r.y1) return p;
  const d = [p.x - r.x0, r.x1 - p.x, p.y - r.y0, r.y1 - p.y];
  const i = d.indexOf(Math.min(...d));
  return [{ x: r.x0, y: p.y }, { x: r.x1, y: p.y }, { x: p.x, y: r.y0 }, { x: p.x, y: r.y1 }][i];
}

/** The shortest way from p to q around rect r's corners (both outside it): the corners passed. */
function around(p: P2, q: P2, r: BodyRect): P2[] {
  const c: P2[] = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
  const d = (a: P2, b: P2) => Math.hypot(a.x - b.x, a.y - b.y);
  let best: P2[] = [], bestL = Infinity;
  for (let i = 0; i < 4; i++) {
    if (crosses(p, c[i], r)) continue;
    for (const dir of [1, 3]) {
      const walk = [c[i]];
      let L = d(p, c[i]);
      for (let k = i; walk.length <= 4; ) {
        if (!crosses(walk[walk.length - 1], q, r)) {
          L += d(walk[walk.length - 1], q);
          if (L < bestL) { bestL = L; best = [...walk]; }
          break;
        }
        const n = (k + dir) % 4;
        L += d(c[k], c[n]);
        walk.push(c[n]);
        k = n;
      }
    }
  }
  return best;
}

/**
 * Ground waypoints for a hose between two ends (ActivitySpec.hose.path): out from each end
 * (along a filler's facing, else a step toward the other end), then around every body in
 * `bodies` it would otherwise run through, a little clear of the paint. Rectangles are in each
 * vehicle's mount frame, so a turned vehicle is walked around along its own sides.
 */
export function hosePath(game: Game, a: HosePoint, b: HosePoint, bodies: Vehicle[]): P2[] {
  const lead = (e: HosePoint, o: HosePoint): P2 => {
    if (e.nx !== undefined && e.ny !== undefined) return { x: e.x + e.nx * HOSE_CLEAR, y: e.y + e.ny * HOSE_CLEAR };
    const d = Math.hypot(o.x - e.x, o.y - e.y) || 1;
    return { x: e.x + (o.x - e.x) / d * 0.35, y: e.y + (o.y - e.y) / d * 0.35 };
  };
  let path: P2[] = [lead(a, b), lead(b, a)];
  for (const v of bodies) {
    const r0 = bodyOf(game, v);
    const r = { x0: r0.x0 - HOSE_CLEAR, x1: r0.x1 + HOSE_CLEAR, y0: r0.y0 - HOSE_CLEAR, y1: r0.y1 + HOSE_CLEAR };
    const toM = (p: P2): P2 => { const [x, y] = v.worldToMount(p.x, p.y); return { x, y }; };
    const toW = (p: P2): P2 => { const [x, y] = v.mountToWorld(p.x, p.y); return { x, y }; };
    const m = path.map(p => pushOut(toM(p), r));
    const out: P2[] = [m[0]];
    for (let i = 1; i < m.length; i++) {
      if (crosses(m[i - 1], m[i], r)) out.push(...around(m[i - 1], m[i], r));
      out.push(m[i]);
    }
    path = out.map(toW);
  }
  return path;
}
