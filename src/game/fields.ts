import type { Game } from './game';
import type { Chunk, Field, MapItem } from '../world/map';
import { CHUNK, chunkOf, localOf, MAX_Z } from '../world/coords';
import { hasFlag } from '../world/registry';
import { Rng } from '../core/rng';
import type { Item } from './item';
import { consumeItem, L } from './moves';
import type { BodyPartId } from './bodyparts';
import { bash } from './bash';
import { isOutside } from './vision';
import { sfx } from '../audio/sfx';

// Map fields (CDDA field_type data: misc.field_type), after map_field.cpp:
//  - generic decay: each turn a field ages one second; when dice(2, age) > half_life it
//    loses one intensity and its age resets (blood, bile, gibs, smoke, dust …)
//  - fd_fire: burns items on its tile (material burn_data), feeds on FLAMMABLE /
//    FLAMMABLE_HARD / FLAMMABLE_ASH terrain & furniture (eventually destroying it), grows
//    with fuel and burning neighbours, spreads to flammable neighbours, makes fd_smoke,
//    is dampened by rain outdoors, and burns whoever stands in it
//  - gases (phase "gas") drift into neighbouring open tiles (percent_spread)
// Processing is limited to chunks within FIELD_RADIUS chunks of the player (z ±1) and to a
// bounded number of 1-second turns per tick; during clock warps the rest of the elapsed
// time is applied as bulk decay, so fires spread more slowly while you sleep.
//
// Chunk.version is bumped only when a field appears, disappears or changes intensity, so
// the renderer doesn't rebuild meshes every turn.

export const FIELD_RADIUS = 2;
const MAX_TURNS_PER_TICK = 8;
/** Fire turns simulated one by one per bulk step (the rest decays in bulk). */
const MAX_FIRE_TURNS_IN_BULK = 4000;

export interface FieldTypeDef {
  id: string;
  half_life?: number;
  phase?: string;
  percent_spread?: number;
  has_fire?: boolean;
  intensity_levels?: { name?: string; light_emitted?: number; dangerous?: boolean; effects?: FieldEffectDef[] }[];
  [k: string]: unknown;
}
interface FieldEffectDef {
  effect_id: string;
  body_part?: string;
  intensity?: number;
  min_duration?: number;
  max_duration?: number;
}

export function fieldType(game: Game, id: string): FieldTypeDef | undefined {
  return game.data.misc.field_type?.[id] as FieldTypeDef | undefined;
}

/** Display name of a field at an intensity ("small fire", "puddle of blood"). */
export function fieldName(game: Game, f: Field): string {
  const lv = fieldType(game, f.type)?.intensity_levels ?? [];
  for (let i = Math.min(f.intensity, lv.length) - 1; i >= 0; i--) if (lv[i]?.name) return lv[i].name!;
  return f.type;
}

interface FState {
  rng: Rng;
  acc: number;
  fireVoices: Map<string, { stop(): void }>;
}
const fstates = new WeakMap<Game, FState>();
function fstate(game: Game): FState {
  let s = fstates.get(game);
  if (!s) fstates.set(game, (s = { rng: new Rng(game.seed ^ 0xf1e1d), acc: 0, fireVoices: new Map() }));
  return s;
}
const itemBurnt = new WeakMap<object, number>();

function slot(game: Game, x: number, y: number, z: number): { c: Chunk; i: number } | null {
  if (!game.map.hasChunk(chunkOf(x), chunkOf(y), z)) return null;
  const c = game.map.chunk(chunkOf(x), chunkOf(y), z);
  return c ? { c, i: localOf(y) * CHUNK + localOf(x) } : null;
}

export function fieldsAt(game: Game, x: number, y: number, z: number): Field[] {
  return game.map.fieldsAt(x, y, z);
}
export function findField(game: Game, x: number, y: number, z: number, type: string): Field | undefined {
  return game.map.fieldsAt(x, y, z).find((f) => f.type === type);
}

/** Add a field (or raise an existing one to at least `intensity`); `age` in game seconds. */
export function addField(game: Game, x: number, y: number, z: number, type: string, intensity = 1, age = 0): Field | undefined {
  if (!fieldType(game, type)) throw new Error(`unknown field type ${type}`);
  const existing = findField(game, x, y, z, type);
  game.map.addField(x, y, z, type, intensity);
  const f = findField(game, x, y, z, type);
  if (f && !existing) f.age = age;
  if (type === 'fd_fire' && !existing) sfx.fireIgnite({ x: x + 0.5, y: y + 0.5, z });
  return f;
}

export function removeField(game: Game, x: number, y: number, z: number, type: string): boolean {
  const s = slot(game, x, y, z);
  if (!s) return false;
  const list = s.c.fields.get(s.i);
  const i = list ? list.findIndex((f) => f.type === type) : -1;
  if (i < 0) return false;
  list!.splice(i, 1);
  if (!list!.length) s.c.fields.delete(s.i);
  s.c.version++;
  return true;
}

function setIntensity(game: Game, x: number, y: number, z: number, f: Field, n: number): void {
  if (n <= 0) {
    removeField(game, x, y, z, f.type);
    return;
  }
  n = Math.min(3, n);
  if (n === f.intensity) return;
  f.intensity = n;
  const s = slot(game, x, y, z);
  if (s) s.c.version++;
}

/** Start a fire (debug `cdda.ignite`, firestarters, molotovs). */
export function ignite(game: Game, x: number, y: number, z: number, intensity = 1): Field | undefined {
  return addField(game, x, y, z, 'fd_fire', intensity);
}

/** Fire intensity at a tile (0 if none). */
export function fireAt(game: Game, x: number, y: number, z: number): number {
  return findField(game, x, y, z, 'fd_fire')?.intensity ?? 0;
}

let lastFireOutNote = -Infinity;
/**
 * A fire near you went out: say so, and why (docs/ADAPTATION.md). BN is silent; the playtester
 * lit a fire to boil water, turned to the pot, and it had already been rained out.
 */
function fireOutNote(game: Game, x: number, y: number, z: number): void {
  const p = game.player;
  if (z !== p.z || Math.max(Math.abs(x - p.tileX), Math.abs(y - p.tileY)) > 8) return;
  const now = Date.now();
  if (now - lastFireOutNote < 20_000) return;
  lastFireOutNote = now;
  const w = game.weather;
  const rained = !!w?.rains && isOutside(game.map, x, y, z);
  // Wood can be left over (a small fire burns big pieces slowly): then "burned through its fuel"
  // would be false, so say what's left instead.
  const left = game.map.itemsAt(x, y, z).length > 0;
  const msg = rained
    ? 'The fire goes out: the rain put it out.  Light it under a roof or in a fire ring, with more fuel.'
    : left
      ? "The fire goes out before the wood on it burned up.  Light it again; a fire ring burns hotter and keeps going."
      : 'The fire goes out: it has burned through its fuel.  Put more wood on it to keep one going.';
  game.message(msg, 'c_light_gray');
}

/**
 * Heat damage a monster standing here takes this turn (map::monster_in_field, fd_fire):
 * none from small fires, 10 % of turns in a fire, every turn in a raging one; flesh +3,
 * veggy +12, flammable materials +20, fire-resistant −20; FIREPROOF/FIREY immune.
 */
export function fieldDamageAt(
  game: Game, x: number, y: number, z: number,
  mon: { materials?: string[]; flags?: string[]; heatArmor?: number } = {}, rng: Rng = fstate(game).rng,
): { type: 'heat'; amount: number; intensity: number } | null {
  const i = fireAt(game, x, y, z);
  if (i <= 1) return null;
  const flags = mon.flags ?? [];
  if (flags.includes('FIREPROOF') || flags.includes('FIREY')) return null;
  if (i === 2 && !rng.oneIn(10)) return null;
  const mats = mon.materials ?? ['flesh'];
  let dam = 0;
  if (mats.some((m) => m === 'flesh' || m === 'hflesh' || m === 'iflesh')) dam += 3;
  if (mats.includes('veggy')) dam += 12;
  if (mats.some((m) => m === 'paper' || m === 'powder' || m === 'wood' || m === 'veggy')) dam += 20;
  if (mats.some((m) => m === 'stone' || m === 'kevlar' || m === 'steel')) dam -= 20;
  if (flags.includes('FLIES')) dam -= 15;
  dam -= mon.heatArmor ?? 0;
  dam += rng.int(i, i * 2);
  return dam > 0 ? { type: 'heat', amount: dam, intensity: i } : null;
}

// ------------------------------------------------------------------ fire

function flammableTile(game: Game, x: number, y: number, z: number): 'soft' | 'hard' | 'ash' | 'fash' | null {
  const t = game.map.terAt(x, y, z), f = game.map.furnAt(x, y, z);
  if (hasFlag(t, 'FIRE_CONTAINER') || hasFlag(f, 'FIRE_CONTAINER')) return null;
  if (hasFlag(t, 'FLAMMABLE') || hasFlag(f, 'FLAMMABLE')) return 'soft';
  if (hasFlag(t, 'FLAMMABLE_HARD') || hasFlag(f, 'FLAMMABLE_HARD')) return 'hard';
  if (hasFlag(t, 'FLAMMABLE_ASH')) return 'ash';
  if (hasFlag(f, 'FLAMMABLE_ASH')) return 'fash';
  return null;
}

interface BurnData { fuel?: number; smoke?: number; burn?: number; volume_per_turn?: number; immune?: boolean }

/**
 * item::simulate_burn: fuel (seconds of fire life), smoke and burn progress this turn. A
 * contained fire (fire ring, brazier, fireplace) burns at intensity 3's rates and independent of
 * the item's volume, as BN's fire_data.contained does.
 */
function simulateBurn(game: Game, it: Item, intensity: number, contained = false): { fuel: number; smoke: number; burn: number } {
  const mats = it.def.material ?? [];
  if (!mats.length) return { fuel: 0, smoke: 0, burn: 1 };
  let fuel = 0, smoke = 0, burn = 0;
  const volL = Math.max(0.001, it.volume() / 1000);
  for (const m of mats) {
    const bdl = game.data.misc.material?.[m]?.burn_data as BurnData[] | undefined;
    const bd = bdl?.[Math.min(contained ? 3 : intensity, bdl.length) - 1];
    if (!bd || bd.immune) return { fuel: 0, smoke: 0, burn: 0 };
    const rate = !contained && bd.volume_per_turn ? bd.volume_per_turn / 1000 / volL : 1;
    fuel += (bd.fuel ?? 0) * rate;
    smoke += (bd.smoke ?? 0) * rate;
    burn += (bd.burn ?? 0) * rate;
  }
  const n = mats.length;
  if (it.isLiquid() && fuel < 200) fuel -= 400 * volL;
  else if (n > 1) (fuel /= n), (smoke /= n), (burn /= n);
  if (it.countByCharges) {
    const k = Math.max(1, Math.floor(it.count() / Math.max(1, it.def.stack_size ?? 1)));
    fuel *= k; smoke *= k; burn *= k;
  }
  return { fuel, smoke, burn };
}

/** item::burn: returns true when the item is destroyed. */
function burnItem(game: Game, it: Item, intensity: number, rng: Rng, out: { fuel: number; smoke: number }, contained = false): boolean {
  if (it.hasFlag('UNBREAKABLE')) return false;
  const b = simulateBurn(game, it, intensity, contained);
  out.fuel += b.fuel;
  out.smoke += b.smoke;
  if (b.burn <= 0) return false;
  const roll = (v: number) => Math.floor(v) + (rng.next() < v - Math.floor(v) ? 1 : 0);
  if (it.countByCharges) {
    if (!it.def.volume) return true;
    it.charges -= roll((b.burn * 250 * (it.def.stack_size ?? 1)) / (3 * it.def.volume));
    return it.charges <= 0;
  }
  const burnt = (itemBurnt.get(it) ?? 0) + roll(b.burn);
  itemBurnt.set(it, burnt);
  return burnt >= Math.floor(it.volume() / 250) * 3;
}

const N8: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

function processFire(game: Game, x: number, y: number, z: number, f: Field, st: FState): void {
  const map = game.map, rng = st.rng;
  f.age = Math.max(-86400, f.age);
  const w = game.weather;
  const outside = isOutside(map, x, y, z);
  const windpower = outside ? (w?.windpower ?? 0) : 0;
  let smoke = 0, timeAdded = 0;
  const kind = flammableTile(game, x, y, z);
  const canBurn = kind !== null;
  const t = map.terAt(x, y, z), fu = map.furnAt(x, y, z);
  const canSpread = !hasFlag(t, 'FIRE_CONTAINER') && !hasFlag(fu, 'FIRE_CONTAINER');

  // Items on the tile are fuel.
  const items = map.itemsAt(x, y, z) as MapItem[];
  if (items.length) {
    const out = { fuel: 0, smoke: 0 };
    let consumed = 0;
    for (const mi of [...items]) {
      if (consumed >= f.intensity * 2) break;
      const it = mi as unknown as Item;
      if (!it.def) continue;
      if (burnItem(game, it, f.intensity, rng, out, !canSpread)) {
        consumeItem(it, L.ground(map, x, y, z));
        consumed++;
      }
    }
    smoke += Math.round(out.smoke);
    // roll_remainder, as BN: a stick yields ~0.16 s of fuel a turn at intensity 1, which
    // Math.round made 0 every turn, so a campfire died beside an unburnt woodpile (playtest).
    timeAdded += Math.floor(out.fuel) + (rng.next() < out.fuel - Math.floor(out.fuel) ? 1 : 0);
  }

  if (canBurn) {
    const destroyChance = 200 - f.intensity * 50;
    if (kind === 'soft' || (kind === 'hard' && rng.oneIn(3)) || kind === 'ash' || kind === 'fash') {
      timeAdded += (kind === 'hard' ? 4 : 5) - f.intensity;
      smoke += 2 + Math.floor(windpower / 5);
      if (f.intensity > 1 && rng.oneIn(destroyChance)) {
        if (kind === 'fash') {
          map.setFurn(x, y, z, map.furniture.has('f_ash') ? 'f_ash' : 'f_null');
        } else bash(game, x, y, z, 999, { destroy: true, bashFloor: true, silent: false });
      }
    }
  }
  // Rain puts out fires in the open.
  if (outside && w?.rains) timeAdded -= w.precip === 'heavy' ? 30 : w.precip === 'light' ? 12 : 5;

  if (timeAdded !== 0) f.age -= timeAdded;
  else if (canBurn) f.age += 10 * f.intensity; // nothing left to burn: die out faster

  // Growth and flashover.
  let adjacent = 0;
  const neigh = N8.map(([dx, dy]) => [x + dx, y + dy] as [number, number]);
  if (canSpread) {
    if (f.intensity > 1 && rng.oneIn(3)) {
      for (const [nx, ny] of neigh) {
        if (f.age >= 0) break;
        const nf = findField(game, nx, ny, z, 'fd_fire');
        if (!nf) continue;
        adjacent++;
        if (nf.intensity <= f.intensity || nf.age > f.age) {
          if (nf.intensity < 2) setIntensity(game, nx, ny, z, nf, nf.intensity + 1);
          nf.age -= 300;
          f.age += 300;
        }
      }
    } else if (f.age < 0 && f.intensity < 3) {
      let maxI = 1;
      if (f.age < -30000) maxI = 3;
      else {
        for (const [nx, ny] of neigh) if (findField(game, nx, ny, z, 'fd_fire')) adjacent++;
        maxI = 1 + (adjacent >= 3 ? 1 : 0) + (adjacent >= 7 ? 1 : 0);
        if (maxI < 2 && f.age < -3000) maxI = 2;
      }
      if (f.intensity < maxI) {
        setIntensity(game, x, y, z, f, f.intensity + 1);
        f.age += 600 * f.intensity;
      }
    }
  }

  // Spread to flammable neighbours.
  if (canSpread) {
    const start = rng.int(0, 7);
    for (let k = 0; k < 8; k++) {
      if (rng.oneIn(f.intensity * 2)) continue;
      const [nx, ny] = neigh[(start + k) % 8];
      if (findField(game, nx, ny, z, 'fd_fire')) continue;
      const spreadChance = 25 * (f.intensity - 1);
      const power = f.intensity + (rng.oneIn(5) ? 1 : 0);
      const nk = flammableTile(game, nx, ny, z);
      const flammableItems = map.itemsAt(nx, ny, z).some((mi) => !!(mi as unknown as Item).def && simulateBurn(game, mi as unknown as Item, 1).fuel > 0);
      if (rng.int(1, 100) < spreadChance && (
        (power >= 2 && (nk === 'soft' || nk === 'ash' || nk === 'fash') && rng.oneIn(2)) ||
        (power >= 3 && nk === 'hard' && rng.oneIn(5)) ||
        (rng.oneIn(5) && flammableItems))) {
        if (!map.passable(nx, ny, z) && !nk) continue;
        addField(game, nx, ny, z, 'fd_fire', 1, 120);
        f.age += 60;
      }
    }
  }

  // Smoke: above if open air, else on the tile.
  if (rng.int(0, 100 - Math.min(100, windpower)) <= smoke && rng.int(3, 35) < f.intensity * 10) {
    if (fieldType(game, 'fd_smoke')) {
      if (z < MAX_Z && !map.hasFloor(x, y, z + 1)) addField(game, x, y, z + 1, 'fd_smoke', rng.int(1, f.intensity));
      else addField(game, x, y, z, 'fd_smoke', f.intensity);
    }
  }
}

// ------------------------------------------------------------------ generic

/** field_entry decay: dice(2, age) > half_life drops one intensity. */
function decay(game: Game, x: number, y: number, z: number, f: Field, ft: FieldTypeDef, rng: Rng, dt: number): void {
  const hl = ft.half_life ?? 0;
  if (hl <= 0) return;
  f.age += dt;
  if (f.age > 0 && rng.dice(2, Math.max(1, Math.floor(f.age))) > hl) {
    f.age = 0;
    setIntensity(game, x, y, z, f, f.intensity - 1);
  }
}

function spreadGas(game: Game, x: number, y: number, z: number, f: Field, ft: FieldTypeDef, rng: Rng): void {
  const pct = ft.percent_spread ?? 0;
  if (pct <= 0 || f.intensity <= 1 || rng.int(1, 100) > pct) return;
  const [dx, dy] = N8[rng.int(0, 7)];
  const nx = x + dx, ny = y + dy;
  if (!game.map.passable(nx, ny, z) && game.map.opaque(nx, ny, z)) return;
  const there = findField(game, nx, ny, z, f.type);
  if (there && there.intensity >= f.intensity) return;
  addField(game, nx, ny, z, f.type, 1);
  setIntensity(game, x, y, z, f, f.intensity - 1);
}

// ------------------------------------------------------------------ the player in fields

const FIRE_MSG = ['You burn your legs and feet!', "You're burning up!", "You're set ablaze!", 'Your whole body is burning!'];
const FIRE_WARN = ["You're standing in a fire!", "You're waist-deep in a fire!", "You're surrounded by raging fire!", "You're lying in fire!"];

function playerInFields(game: Game, rng: Rng): void {
  const p = game.player;
  if (p.dead) return;
  for (const f of [...fieldsAt(game, p.tileX, p.tileY, p.z)]) {
    if (f.type === 'fd_fire') {
      if (f.intensity === 1) continue;
      if (f.intensity === 2 && !rng.oneIn(10)) continue;
      const i = f.intensity;
      const onGround = p.isAsleep() || p.hasEffect('downed');
      const parts: BodyPartId[] = onGround
        ? ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r']
        : i >= 3 ? ['arm_l', 'arm_r', 'torso', 'leg_l', 'leg_r'] : i === 2 ? ['torso', 'leg_l', 'leg_r'] : ['leg_l', 'leg_r'];
      let total = 0;
      for (const bp of parts) total += p.takeHit(bp, [{ type: 'heat', amount: rng.int(i, 3 * i + 3) }]).damage;
      const msgI = onGround ? 3 : i - 1;
      game.message(total > 0 ? FIRE_MSG[msgI] : FIRE_WARN[msgI], 'c_red');
      if (p.isAsleep()) p.wakeUp();
      continue;
    }
    const lv = fieldType(game, f.type)?.intensity_levels;
    const effs = lv?.[Math.min(f.intensity, lv.length) - 1]?.effects ?? lv?.[0]?.effects;
    if (!effs) continue;
    for (const e of effs) {
      if (!game.data.misc.effect_type?.[e.effect_id]) continue;
      const dur = rng.int(e.min_duration ?? 1, e.max_duration ?? e.min_duration ?? 1);
      const bp = e.body_part as BodyPartId | undefined;
      p.addEffect(e.effect_id, Math.max(1, dur), { bp: bp && ['eyes', 'mouth', 'head', 'torso'].includes(bp) ? bp : undefined, intensity: e.intensity ?? 1 });
    }
  }
}

// ------------------------------------------------------------------ system

/** Process all fields near the player for `turns` one-second turns (+ bulk decay `extra`). */
export function processFields(game: Game, turns: number, extra = 0): void {
  const st = fstate(game);
  const p = game.player;
  const pcx = chunkOf(p.tileX), pcy = chunkOf(p.tileY);
  const chunks: Chunk[] = [];
  for (let z = p.z - 1; z <= p.z + 1; z++)
    for (let cy = pcy - FIELD_RADIUS; cy <= pcy + FIELD_RADIUS; cy++)
      for (let cx = pcx - FIELD_RADIUS; cx <= pcx + FIELD_RADIUS; cx++) {
        if (!game.map.hasChunk(cx, cy, z)) continue;
        const c = game.map.chunk(cx, cy, z)!;
        if (c.fields.size) chunks.push(c);
      }
  for (let t = 0; t < turns; t++) {
    for (const c of chunks) {
      const snap: [number, Field][] = [];
      for (const [i, list] of c.fields) for (const f of list) snap.push([i, f]);
      for (const [i, f] of snap) {
        const x = c.cx * CHUNK + (i % CHUNK), y = c.cy * CHUNK + Math.floor(i / CHUNK);
        if (!(c.fields.get(i)?.includes(f))) continue;
        const ft = fieldType(game, f.type);
        if (!ft) continue;
        if (f.type === 'fd_fire') {
          processFire(game, x, y, c.z, f, st);
          if (!(c.fields.get(i)?.includes(f))) {
            fireOutNote(game, x, y, c.z);
            continue;
          }
        } else if (ft.phase === 'gas') spreadGas(game, x, y, c.z, f, ft, st.rng);
        decay(game, x, y, c.z, f, ft, st.rng, 1);
        if (f.type === 'fd_fire' && !(c.fields.get(i)?.includes(f))) fireOutNote(game, x, y, c.z);
      }
    }
    playerInFields(game, st.rng);
  }
  if (extra > 0) {
    // Fires get their turns one by one even in bulk: bulk decay knows nothing of fuel, so while
    // time was warped (waiting, crafting, eating) a campfire aged as if it had nothing to burn
    // and went out beside its unburnt woodpile (playtest, round 6). Fires are few; a budget
    // keeps a big blaze during a long wait from stalling the frame.
    let budget = MAX_FIRE_TURNS_IN_BULK;
    for (const c of chunks)
      for (const [i, list] of [...c.fields])
        for (const f of [...list]) {
          const ft = fieldType(game, f.type);
          if (!ft) continue;
          const x = c.cx * CHUNK + (i % CHUNK), y = c.cy * CHUNK + Math.floor(i / CHUNK);
          let left = extra;
          if (f.type === 'fd_fire') {
            for (; left > 0 && budget > 0 && c.fields.get(i)?.includes(f); left--, budget--) {
              processFire(game, x, y, c.z, f, st);
              if (c.fields.get(i)?.includes(f)) decay(game, x, y, c.z, f, ft, st.rng, 1);
            }
            if (!(c.fields.get(i)?.includes(f))) {
              fireOutNote(game, x, y, c.z);
              continue;
            }
          }
          if (left > 0) decay(game, x, y, c.z, f, ft, st.rng, left);
        }
  }
}

/** Keeps a crackling loop playing at each nearby fire. */
function updateFireAudio(game: Game, st: FState): void {
  const p = game.player;
  const want = new Set<string>();
  const pcx = chunkOf(p.tileX), pcy = chunkOf(p.tileY);
  for (let cy = pcy - 1; cy <= pcy + 1; cy++)
    for (let cx = pcx - 1; cx <= pcx + 1; cx++) {
      if (!game.map.hasChunk(cx, cy, p.z)) continue;
      const c = game.map.chunk(cx, cy, p.z)!;
      for (const [i, list] of c.fields) {
        const f = list.find((q) => q.type === 'fd_fire');
        if (!f) continue;
        const x = cx * CHUNK + (i % CHUNK), y = cy * CHUNK + Math.floor(i / CHUNK);
        if (Math.hypot(x - p.x, y - p.y) > 14 || want.size >= 4) continue;
        const key = `${x},${y},${p.z}`;
        want.add(key);
        if (!st.fireVoices.has(key)) {
          const v = sfx.fireLoop({ x: x + 0.5, y: y + 0.5, z: p.z }, f.intensity);
          if (v) st.fireVoices.set(key, v);
        }
      }
    }
  for (const [k, v] of st.fireVoices) if (!want.has(k)) (v.stop(), st.fireVoices.delete(k));
}

export function installFields(game: Game): void {
  const st = fstate(game);
  let audioT = 0;
  game.systems.push({
    name: 'fields',
    update(g, realDt, gameDt) {
      st.acc += gameDt;
      const turns = Math.floor(st.acc);
      if (turns <= 0) return;
      st.acc -= turns;
      const run = Math.min(turns, MAX_TURNS_PER_TICK);
      processFields(g, run, turns - run);
      if ((audioT -= realDt) <= 0) {
        audioT = 0.5;
        updateFireAudio(g, st);
      }
    },
  });
}
