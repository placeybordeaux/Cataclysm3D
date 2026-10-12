import type { Game } from './game';
import type { Vehicle } from './vehicle';
import { liveryFromId } from './chassis/layout';

// Telling vehicles of the same name apart in menus and messages. BN's liquid menu offers
// "Fill nearby vehicle Car" once per car, which is fine on a grid where you can look at the
// map; in 3D two parked Cars read the same. When a list holds several vehicles of one name,
// each is named by its paint (when the paint tells them apart) and by where it is from you:
// "the red Car to your left". Unique names stay plain ("the Car").

/** Colour names for the spawn paints (vehicle.ts PAINTS) and the fixed liveries. */
const PAINT_NAMES: [number, string][] = [
  [0x8a2c28, 'red'], [0x2c4a86, 'blue'], [0xc9c9c0, 'silver'], [0x2a2a2e, 'black'], [0x6c6f76, 'grey'],
  [0x305e3c, 'green'], [0xb8973a, 'gold'], [0xdedcd2, 'white'], [0x5a3a28, 'brown'], [0x7a1e4a, 'maroon'],
];
const LIVERY_NAMES: Record<string, string> = {
  police: 'black-and-white', fbi: 'black', swat: 'dark grey', ambulance: 'white', school: 'yellow', prison: 'white',
  fire: 'red', military: 'olive', security: 'grey', icecream: 'white', hippie: 'teal', hazmat: 'white', transit: 'white',
  motorhome: 'cream', food: 'white',
};

/** What colour the vehicle is drawn (render/vehicleSkin.ts liveryColors: plain = its paint). */
export function vehicleColour(v: Vehicle): string {
  // the Abrams is drawn desert tan whatever the livery says (render/vehicleTank.ts)
  if (/abrams/.test(v.protoId)) return 'tan';
  const livery = liveryFromId(v.protoId);
  if (livery !== 'plain') return LIVERY_NAMES[livery] ?? 'grey';
  let best = 'grey', bd = Infinity;
  const r = (v.paint >> 16) & 255, g = (v.paint >> 8) & 255, b = v.paint & 255;
  for (const [c, name] of PAINT_NAMES) {
    const d = (r - ((c >> 16) & 255)) ** 2 + (g - ((c >> 8) & 255)) ** 2 + (b - (c & 255)) ** 2;
    if (d < bd) (bd = d), (best = name);
  }
  return best;
}

/** Where (x, y) is from the player, by where they look: ahead, to your right, behind you, to your left. */
export function directionFromPlayer(game: Game, x: number, y: number): string {
  const p = game.player;
  // game yaw: 0 north, clockwise; y grows south
  const bearing = Math.atan2(x - p.x, -(y - p.y));
  const rel = Math.atan2(Math.sin(bearing - p.yaw), Math.cos(bearing - p.yaw));
  const a = Math.abs(rel);
  if (a <= Math.PI / 4) return 'ahead';
  if (a >= (3 * Math.PI) / 4) return 'behind you';
  return rel > 0 ? 'to your right' : 'to your left';
}

/**
 * "the Car" for each vehicle in `list`, or, where two or more share a name, "the red Car to
 * your left": colour when it differs within the group, direction always, the distance as a
 * last resort when both match too. `extra` vehicles share the namespace without being named
 * (the car you're siphoning from, when the targets are Cars as well).
 */
export function distinctVehicleNames(game: Game, list: readonly Vehicle[], extra: readonly Vehicle[] = []): Map<Vehicle, string> {
  const out = new Map<Vehicle, string>();
  const all = [...new Set([...list, ...extra])];
  const p = game.player;
  const centre = (v: Vehicle): [number, number] => {
    const [x0, y0, x1, y1] = v.bounds();
    return v.mountToWorld((x0 + x1) / 2, (y0 + y1) / 2);
  };
  for (const v of list) {
    const same = all.filter((o) => o.name === v.name);
    if (same.length < 2) {
      out.set(v, `the ${v.name}`);
      continue;
    }
    const colours = new Set(same.map(vehicleColour));
    const colour = colours.size > 1 ? `${vehicleColour(v)} ` : '';
    const describe = (o: Vehicle) => `${colours.size > 1 ? vehicleColour(o) : ''}|${directionFromPlayer(game, ...centre(o))}`;
    const [cx, cy] = centre(v);
    let label = `the ${colour}${v.name} ${directionFromPlayer(game, cx, cy)}`;
    if (same.filter((o) => describe(o) === describe(v)).length > 1) label += ` (${Math.round(Math.hypot(cx - p.x, cy - p.y))} m)`;
    out.set(v, label);
  }
  return out;
}
