import type { DebugApi } from '../debug';
import { L, destroyWhere } from '../game/moves';

// The gallery's viewpoints (docs/GALLERY.md). Most reuse the comparison views the area agents
// built for their screenshots (tools/look-views.js, char-views.js, vehicle-views.js: plain JS
// that defines window.lookView / charView / vehicleView), so a gallery scene and a doc
// screenshot of the same name are the same shot. World seed 1 (the gallery's default).
//
// Every scene starts from the same reset (clock back to the boot day so an earlier autumn
// scene doesn't leave the season behind, empty hands, no spawned creatures or lamps), so
// clicking a scene twice, or in any order, gives the same picture.

export interface Scene {
  id: string;
  group: string;
  label: string;
  /** Wields a gun: the aim-model sway path is drawn over it. */
  gun?: boolean;
  run(c: GalleryCdda, ctx: SceneCtx): Promise<unknown>;
}

export interface SceneCtx {
  /** Lamps added by this scene (removed by the next reset). */
  lights: { remove(): void }[];
}

/** window.cdda plus the view functions the tools scripts add to window. */
export type GalleryCdda = DebugApi;
type ViewFn = (name: string) => Promise<unknown>;
interface ViewWindow {
  lookView?: ViewFn;
  charView?: ViewFn;
  vehicleView?: ViewFn;
  duskHour?: () => number;
}
const w = () => window as unknown as ViewWindow;

let viewsLoaded: Promise<void> | null = null;
/**
 * Load the tools' view scripts into this page. They're served (and, in a build, emitted) as
 * standalone files; `new URL` keeps TypeScript from type-checking plain JS it can't see.
 */
export function loadViews(): Promise<void> {
  viewsLoaded ??= (async () => {
    const urls = [
      new URL('../../tools/look-views.js', import.meta.url).href,
      new URL('../../tools/char-views.js', import.meta.url).href,
      new URL('../../tools/vehicle-views.js', import.meta.url).href,
    ];
    for (const u of urls) await import(/* @vite-ignore */ u);
    if (!w().lookView || !w().charView || !w().vehicleView) throw new Error('gallery: the tools/*-views.js scripts did not define lookView/charView/vehicleView');
  })();
  return viewsLoaded;
}

const look = (name: string): Scene['run'] => async () => w().lookView!(name);
const char = (name: string): Scene['run'] => async () => w().charView!(name);
const vehicle = (name: string): Scene['run'] => async () => w().vehicleView!(name);

/** The nearest town of size >= 4 to the start (what the tools views use). */
function town(c: GalleryCdda): { x: number; y: number } {
  const s = c.startLocation();
  const t = (c.cities() as { x: number; y: number; size: number }[])
    .filter((q) => q.size >= 4)
    .sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
  if (!t) throw new Error('gallery: no town near the start');
  return t;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Settle like the tools views do (light map, exposure, shadows converge). */
async function settle(c: GalleryCdda): Promise<void> {
  c.settle();
  await wait(1200);
  c.settle();
}

/**
 * Stand in the street in front of a house and look at its front. Houses face the road, so
 * walk out from the house OMT's centre in each direction until the tiles are road, then turn
 * back to face the building.
 */
async function houseFront(c: GalleryCdda): Promise<void> {
  c.setHour(10.5);
  const t = town(c);
  c.teleportOmt(t.x, t.y);
  const m = c.game.map;
  const tried: string[] = [];
  for (let skip = 0; skip < 12; skip++) {
    const h = findNth(c, t, (id) => /^house/.test(id), skip);
    if (!h) break;
    const cx = h.x * 24 + 12, cy = h.y * 24 + 12;
    c.teleportOmt(h.x, h.y);
    c.settle();
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      // road within 13-22 tiles of the centre along this axis
      for (let k = 13; k <= 22; k++) {
        const id: string = m.terAt(cx + dx * k, cy + dy * k, 0).id;
        if (/pavement|road|asphalt/.test(id)) {
          const back = k + 3;
          c.teleport(cx + dx * back + 0.5, cy + dy * back + 0.5, 0);
          c.lookAt(cx + 0.5, cy + 0.5, -4);
          return;
        }
      }
    }
    tried.push(`${h.x},${h.y}`);
  }
  throw new Error(`gallery: no house with a road in front near town (tried ${tried.join(' ')})`);
}

/** The n-th OMT around the town whose id passes `test` (rings outwards, deterministic). */
function findNth(c: GalleryCdda, t: { x: number; y: number }, test: (id: string) => boolean, n: number): { x: number; y: number } | null {
  let seen = 0;
  for (let r = 0; r < 30; r++)
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const o = c.omtAt(t.x + ox, t.y + oy, 0);
        if (o && test(o.id) && seen++ === n) return { x: t.x + ox, y: t.y + oy };
      }
  return null;
}

/** Inside the nearest shop (grocery / pharmacy / hardware / general store), looking down the shelves. */
async function shop(c: GalleryCdda): Promise<void> {
  c.setHour(11);
  const t = town(c);
  const s = findNth(c, t, (id) => /^s_(grocery|pharm|hardware|general|clothes|gun|electronics|liquor|convenience|sports)/.test(id), 0);
  if (!s) throw new Error('gallery: no shop near town');
  c.teleportOmt(s.x, s.y);
  c.settle();
  const m = c.game.map, X0 = s.x * 24, Y0 = s.y * 24;
  // the indoor floor tile with the most shelving in view within 6 tiles
  const shelf = (x: number, y: number) => /rack|shelf|display|counter|fridge|freezer|cooler/.test(m.furnAt(x, y, 0).id);
  const free = (x: number, y: number) => {
    const ter = m.terAt(x, y, 0);
    return ter.move_cost > 0 && !ter.flags.includes('WINDOW') && !ter.flags.includes('DOOR') && m.furnAt(x, y, 0).id === 'f_null' && c.renderer.chunks.covered(x, y, 0);
  };
  let best: [number, number] | null = null, bs = -1;
  for (let y = Y0 + 2; y < Y0 + 22; y++)
    for (let x = X0 + 2; x < X0 + 22; x++) {
      if (!free(x, y)) continue;
      let n = 0;
      for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) if (shelf(x + dx, y + dy)) n++;
      if (n > bs) (bs = n), (best = [x, y]);
    }
  if (!best) throw new Error(`gallery: no floor inside ${c.omtAt(s.x, s.y, 0).id}`);
  // face the densest shelving direction
  let yaw = 0, yb = -1;
  for (let a = 0; a < 360; a += 15) {
    const r = (a * Math.PI) / 180;
    let n = 0;
    for (let d = 1; d <= 8; d++) {
      for (const s2 of [-1.5, 0, 1.5]) {
        const x = Math.round(best[0] + Math.sin(r) * d + Math.cos(r) * s2), y = Math.round(best[1] - Math.cos(r) * d + Math.sin(r) * s2);
        if (shelf(x, y)) n++;
      }
    }
    if (n > yb) (yb = n), (yaw = a);
  }
  c.teleport(best[0] + 0.5, best[1] + 0.5, 0);
  c.look(yaw, -12);
}

export const SCENES: Scene[] = [
  // --- town, outdoors
  { id: 'street', group: 'Town', label: 'Street by day', run: look('street') },
  { id: 'housefront', group: 'Town', label: 'House from the street', run: async (c) => houseFront(c) },
  { id: 'far', group: 'Town', label: 'Long road, zombies 15-60 m', run: look('far') },
  { id: 'farroad', group: 'Town', label: 'Zombies down the road 66-110 m', run: char('horde_road') },
  { id: 'dusk', group: 'Town', label: 'Dusk street', run: look('dusk') },
  { id: 'fardusk', group: 'Town', label: 'Long road at dusk', run: look('fardusk') },
  { id: 'night', group: 'Town', label: 'Night street, flashlight', run: look('night') },
  { id: 'rain', group: 'Town', label: 'Rain', run: look('rain') },
  { id: 'snow', group: 'Town', label: 'Snow', run: look('snow') },
  { id: 'intosun', group: 'Town', label: 'Into the sun (form lighting)', run: look('intosun') },
  // --- creatures
  { id: 'horde', group: 'Creatures', label: 'Zombie horde, close', run: char('horde_near') },
  { id: 'hordemid', group: 'Creatures', label: 'Zombie horde, 18-30 m', run: char('horde_mid') },
  { id: 'zombies2', group: 'Creatures', label: 'Special zombies', run: char('zombies2') },
  { id: 'zlineup', group: 'Creatures', label: 'Zombie lineup: specials', run: char('zombie_lineup_c') },
  { id: 'zlineup_common', group: 'Creatures', label: 'Zombie lineup: common', run: char('zombie_lineup_a') },
  { id: 'zlineup_far', group: 'Creatures', label: 'Zombie lineup at 25 m', run: char('zombie_lineup_far') },
  { id: 'zwindup', group: 'Creatures', label: 'Zombie wind-ups and lunge crouch', run: char('zombie_lineup_windup') },
  { id: 'npcs', group: 'Creatures', label: 'NPC group', run: char('crowd') },
  { id: 'critters', group: 'Creatures', label: 'Dogs and animals', run: char('critters') },
  { id: 'zoo', group: 'Creatures', label: 'Zoo: every body plan', run: char('zoo') },
  { id: 'bugs', group: 'Creatures', label: 'Bugs and birds', run: char('bugs') },
  { id: 'corpses', group: 'Creatures', label: 'Bodies', run: char('corpse') },
  { id: 'nightcreatures', group: 'Creatures', label: 'Night, flashlight, zombies', run: char('night') },
  { id: 'props', group: 'Creatures', label: 'Props: fire, loot, mannequin', run: char('props') },
  // --- interiors
  { id: 'house', group: 'Interiors', label: 'House, main room', run: look('house') },
  { id: 'kitchen', group: 'Interiors', label: 'Kitchen', run: look('furn:^f_oven$:0:3:-16') },
  { id: 'living', group: 'Interiors', label: 'Living room', run: look('furn:^f_sofa$:0:3:-14') },
  { id: 'bathroom', group: 'Interiors', label: 'Bathroom', run: look('furn:^f_toilet$:0:2:-24') },
  { id: 'bedroom', group: 'Interiors', label: 'Bedroom', run: look('furn:^f_bed$:0:3:-16') },
  { id: 'wrecked', group: 'Interiors', label: 'Wrecked house', run: look('house:2') },
  { id: 'shop', group: 'Interiors', label: 'Shop', run: async (c) => shop(c) },
  // dropped weapons (render/furniture/groundHeld.ts): a pile, a pistol on a table, a spread of
  // long guns and melee weapons on bare floor
  { id: 'loot_weapons', group: 'Interiors', label: 'Dropped weapons', run: look('gallery:i:marlin_1894c+i:remington_870+i:ak47+i:shotgun_d+f_table&i:glock_19+i:machete+i:bat+i:fire_ax+i:katana+i:remington_700&i:m4a1&i:knife_combat') },
  { id: 'indoornight', group: 'Interiors', label: 'House at night, flashlight', run: look('indoornight') },
  {
    id: 'lamp', group: 'Interiors', label: 'Lamp-lit room at night',
    run: async (c, ctx) => {
      await w().lookView!('house');
      c.setHour(23.2);
      c.flashlight(false);
      // a warm table lamp a little ahead and to the side
      const p = c.game.player;
      const dx = Math.round(Math.sin(p.yaw) * 2 + Math.cos(p.yaw)), dy = Math.round(-Math.cos(p.yaw) * 2 + Math.sin(p.yaw));
      ctx.lights.push(c.addLight(dx, dy, { intensity: 1.4, radius: 7, color: 0xffc070 }));
      await settle(c);
    },
  },
  // --- nature
  { id: 'forest', group: 'Nature', label: 'Forest, spring', run: look('springforest') },
  { id: 'forestsummer', group: 'Nature', label: 'Forest, summer', run: look('forest') },
  { id: 'autumn', group: 'Nature', label: 'Forest, autumn', run: look('autumn') },
  { id: 'winter', group: 'Nature', label: 'Forest, winter', run: look('winterforest') },
  { id: 'lineup', group: 'Nature', label: 'Tree lineup, 14 m', run: look('lineup') },
  { id: 'lineupfar', group: 'Nature', label: 'Tree lineup, 60 m', run: look('lineupfar') },
  { id: 'lineupautumn', group: 'Nature', label: 'Tree lineup, autumn', run: look('lineup-autumn') },
  // --- vehicles
  { id: 'cars', group: 'Vehicles', label: 'Car lineup', run: vehicle('lineup:car,sedan,car_sports') },
  { id: 'trucks', group: 'Vehicles', label: 'SUV, pickup, van', run: vehicle('lineup:suv,pickup,cube_van') },
  { id: 'streetcars', group: 'Vehicles', label: 'Parked cars in town', run: vehicle('street') },
  { id: 'wreck', group: 'Vehicles', label: 'Wrecked car', run: vehicle('solo:car:40:1') },
  { id: 'burnt', group: 'Vehicles', label: 'Burnt-out car', run: vehicle('solo:sedan:140:burnt') },
  { id: 'cockpit', group: 'Vehicles', label: 'Driving: cockpit', run: vehicle('driveday') },
  { id: 'chase', group: 'Vehicles', label: 'Driving: chase camera', run: vehicle('drivedaychase') },
  { id: 'drivenight', group: 'Vehicles', label: 'Driving at night', run: vehicle('drive') },
  // --- first person
  { id: 'fp_fists', group: 'First person', label: 'Fists', run: char('fp_fists') },
  { id: 'fp_pistol', group: 'First person', label: 'Pistol', gun: true, run: char('fp_pistol') },
  { id: 'fp_rifle', group: 'First person', label: 'Rifle', gun: true, run: char('fp_rifle') },
  { id: 'fp_shotgun', group: 'First person', label: 'Shotgun', gun: true, run: char('fp_shotgun') },
  { id: 'fp_bat', group: 'First person', label: 'Baseball bat', run: char('fp_bat') },
  { id: 'fp_axe', group: 'First person', label: 'Fire axe', run: char('fp_axe') },
  { id: 'fp_bow', group: 'First person', label: 'Longbow, drawn', gun: true, run: char('fp_bow') },
];

export function sceneById(id: string): Scene {
  const s = SCENES.find((q) => q.id === id);
  if (!s) throw new Error(`gallery: unknown scene "${id}" (have ${SCENES.map((q) => q.id).join(', ')})`);
  return s;
}

/** Undo whatever the previous scene left behind, so every scene starts from the same state. */
export function resetWorld(c: GalleryCdda, ctx: SceneCtx, bootSeconds: number): void {
  for (const l of ctx.lights.splice(0)) l.remove();
  if (c.vehicleSystem?.driving) c.exitVehicle();
  c.renderer.rig.driveCam = 'cockpit';
  c.game.clock.seconds = bootSeconds;
  c.clearMonsters();
  const npcs = c.npcSystem;
  if (npcs) for (const n of [...npcs.npcs]) npcs.remove(n);
  const p = c.game.player;
  // gone, not stashed: a survivor with no bag has nowhere to put the last scene's longbow
  destroyWhere(L.hands(p), () => true);
  const vm = c.renderer.viewmodel;
  if (vm) {
    // char-views pins `ads` with a getter and swaps the bow source for its poses
    Object.defineProperty(vm, 'ads', { value: false, writable: true, configurable: true });
    const src = (c as Record<string, unknown>).__bowSource;
    if (src) vm.bowSource = src as typeof vm.bowSource;
    vm.freeze(null);
    vm.setGuard?.(false);
  }
  c.renderer.sky.cloudiness = 0.2;
  c.setWeather('clear');
  c.flashlight(false);
  c.setCameraMode('first');
}
