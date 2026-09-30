import type { Game } from './game';
import type { FurnitureDef, TerrainDef } from '../data/types';
import type { Item } from './item';
import { createItem } from './item';
import { spawnOnGround } from './moves';
import { CHUNK, chunkOf, localOf } from '../world/coords';
import { hasFlag } from '../world/registry';
import { cddaText } from './units';
import { emitSound } from './sound';
import { sfx } from '../audio/sfx';
import { invalidateNaturalLight, isOutside } from './vision';
import { interesting, targetTile, type TargetTile } from './targeting';
import { goStairs } from './zlevels';
import { goToSleep, comfortAt } from './rest';
import { ignite, fieldName } from './fields';
import { playerSeesTrap, trapAt, trapDef } from './traps';
import { curtainInteractions } from './curtains';
import { pryAttempt, pryInfo } from './pry';

// Examine / interact (`e`), after CDDA iexamine.cpp and map::open_door / close_door.
// interactionsAt() lists what can be done with a tile (pure, testable); the key handler
// runs the first one or shows a menu when there are several. interactionPrompt() is the
// HUD hint ("[e] Open closed wood door").

export interface Interaction {
  id: string;
  /** Menu / prompt text, e.g. "Open closed wood door". */
  label: string;
  run: () => void;
}

/** UI hooks so this module stays testable without a DOM (set by installInteract). */
export interface InteractUi {
  menu?: (title: string, entries: { label: string; run: () => void }[]) => void;
  text?: (title: string, body: string) => void;
  /** Pick up from a list of map items at (x, y, z). */
  pickup?: (title: string, x: number, y: number, z: number) => void;
}

/**
 * Systems owning things that aren't terrain/furniture (vehicles: src/ui/vehicle_ui.ts) get
 * the first go at `e` and at the prompt; return false/null when not aimed at theirs
 * (prompt '' = show no prompt at all, e.g. while driving).
 */
export const interactOverrides: { interact(game: Game): boolean; prompt(game: Game): string | null }[] = [];

/**
 * Extra interactions for a tile contributed by other systems (src/game/nature.ts: harvest,
 * forage, plant, fill containers, chop...). Called on every prompt refresh: keep it cheap.
 * Entries are appended after doors/locks and furniture examine actions.
 */
export const interactionProviders: ((game: Game, x: number, y: number, z: number) => Interaction[])[] = [];

/**
 * Handlers for CDDA examine_action names (string, or the object form's `type`) owned by
 * other systems (src/labs.ts: cardreader, elevator, controls_gate, chainfence). A registered
 * handler replaces the built-in placeholder for that action.
 */
export const examineHandlers = new Map<string, (game: Game, x: number, y: number, z: number, def: TerrainDef | FurnitureDef) => Interaction[]>();

let ui: InteractUi = {};
export function setInteractUi(u: InteractUi): void {
  ui = u;
}
/** Override some hooks (the UI layer installs after world interaction). */
export function patchInteractUi(u: Partial<InteractUi>): void {
  ui = { ...ui, ...u };
}

const insideOf = (game: Game) => {
  const p = game.player;
  return !isOutside(game.map, p.tileX, p.tileY, p.z);
};

function openCloseFlags(def: TerrainDef | FurnitureDef): boolean {
  return hasFlag(def, 'OPENCLOSE_INSIDE');
}

/** map::open_door. Returns a message on refusal, null on success. */
export function openDoor(game: Game, x: number, y: number, z: number): string | null {
  const map = game.map;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const inside = insideOf(game);
  if (t.open && map.terrain.has(t.open)) {
    if (openCloseFlags(t) && !inside) return hasFlag(t, 'LOCKED') ? `The ${t.name} is locked.` : `You can't open the ${t.name} from outside.`;
    map.setTer(x, y, z, t.open);
    invalidateNaturalLight(game);
    sfx.door('open', { x: x + 0.5, y: y + 0.5, z }, t.id);
    emitSound(game, { x, y, z }, 6, 'swish', { category: 'movement', source: game.player, sfxId: '' });
    game.events.emit('mapChanged', { x, y, z });
    return null;
  }
  if (f.open && map.furniture.has(f.open)) {
    if (openCloseFlags(f) && !inside) return `You can't open the ${f.name} from outside.`;
    map.setFurn(x, y, z, f.open);
    sfx.door('open', { x: x + 0.5, y: y + 0.5, z }, f.id);
    emitSound(game, { x, y, z }, 6, 'swish', { category: 'movement', source: game.player, sfxId: '' });
    return null;
  }
  return `That can't be opened.`;
}

/** map::close_door: refuses when something is in the way. */
export function closeDoor(game: Game, x: number, y: number, z: number): string | null {
  const map = game.map;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const inside = insideOf(game);
  const p = game.player;
  if (p.tileX === x && p.tileY === y && p.z === z) return "There's you in the way!";
  if (t.close && map.terrain.has(t.close)) {
    if (openCloseFlags(t) && !inside) return `You can't close the ${t.name} from outside.`;
    if (map.itemsAt(x, y, z).length) return `There's ${map.itemsAt(x, y, z).length > 1 ? 'some stuff' : 'something'} in the way!`;
    if (f.id !== 'f_null') return `There's a ${f.name} in the way!`;
    map.setTer(x, y, z, t.close);
    invalidateNaturalLight(game);
    sfx.door('close', { x: x + 0.5, y: y + 0.5, z }, t.id);
    emitSound(game, { x, y, z }, 10, 'swish', { category: 'movement', source: p, sfxId: '' });
    game.events.emit('mapChanged', { x, y, z });
    return null;
  }
  if (f.close && map.furniture.has(f.close)) {
    if (openCloseFlags(f) && !inside) return `You can't close the ${f.name} from outside.`;
    map.setFurn(x, y, z, f.close);
    sfx.door('close', { x: x + 0.5, y: y + 0.5, z }, f.id);
    emitSound(game, { x, y, z }, 10, 'swish', { category: 'movement', source: p, sfxId: '' });
    return null;
  }
  return `That can't be closed.`;
}

function say(game: Game, msg: string | null, color = 'c_light_gray'): void {
  if (msg) game.message(msg, color);
}

function examineAction(def: TerrainDef | FurnitureDef): string | null {
  const e = def.examine_action;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object' && typeof (e as { type?: unknown }).type === 'string') return (e as { type: string }).type;
  return null;
}

/** Items the player carries with a tool quality ≥ level. */
function toolWith(game: Game, q: string, level = 1): Item | null {
  return game.player.inv.findByQuality(q, level)[0] ?? null;
}

function drinkFrom(game: Game, x: number, y: number, z: number, name: string, clean: boolean): void {
  const id = clean ? 'water_clean' : 'water';
  const liquidId = game.data.items[id] ? id : 'water';
  if (!game.data.items[liquidId]) return say(game, `There's no water in the ${name}.`);
  // a sip straight from the source: a new portion, drunk on the spot
  const w = createItem(game.data, liquidId, { charges: 1 });
  const r = game.player.inv.consume(w, null);
  if (r.ok) emitSound(game, { x, y, z }, 2, 'slurp', { category: 'activity', source: game.player, sfxId: '', ambient: true });
}

function signText(game: Game, x: number, y: number, z: number): string | null {
  const c = game.map.chunk(chunkOf(x), chunkOf(y), z);
  return c?.signs.get(localOf(y) * CHUNK + localOf(x)) ?? null;
}

function lockpickAttempt(game: Game, x: number, y: number, z: number, def: TerrainDef | FurnitureDef, isFurn: boolean): void {
  const p = game.player;
  const pick = toolWith(game, 'LOCKPICK', 1);
  if (!pick) return;
  const result = typeof def.lockpick_result === 'string' ? def.lockpick_result : null;
  if (!result) return say(game, `The ${def.name} has no lock you can pick.`);
  game.activities.start({
    name: 'picking the lock',
    duration: Math.max(60, 600 - p.dex * 20 - p.getSkill('traps') * 60),
    onComplete: () => {
      // lockpick_activity_actor: skill, dexterity and tool quality against the lock.
      const q = pick.qualityLevel('LOCKPICK');
      const chance = Math.min(95, 20 + p.getSkill('traps') * 10 + (p.dex - 8) * 5 + q * 15);
      if (p.rng.chance(chance)) {
        if (isFurn) game.map.setFurn(x, y, z, result);
        else game.map.setTer(x, y, z, result);
        say(game, cddaText(def.lockpick_message) || 'With a satisfying click, the lock opens.', 'c_green');
        p.practice('traps', 5);
      } else {
        say(game, 'The lock stumps your efforts to pick it.', 'c_light_red');
        p.practice('traps', 2);
      }
    },
  });
}

/** Everything the player can do with tile (x, y, z), most relevant first. */
export function interactionsAt(game: Game, x: number, y: number, z: number): Interaction[] {
  const map = game.map;
  const p = game.player;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const out: Interaction[] = [];
  const add = (id: string, label: string, run: () => void) => out.push({ id, label, run });
  const tAct = examineAction(t), fAct = f.id !== 'f_null' ? examineAction(f) : null;
  const inside = insideOf(game);
  const onTile = p.tileX === x && p.tileY === y;

  // --- stairs
  if (hasFlag(t, 'GOES_UP')) add('stairs_up', `Go up the ${t.name}`, () => goStairs(game, 'up'));
  if (hasFlag(t, 'GOES_DOWN')) add('stairs_down', `Go down the ${t.name}`, () => goStairs(game, 'down'));

  // --- locked doors / objects
  const locked = hasFlag(t, 'LOCKED') || tAct === 'locked_object' || tAct === 'locked_object_pickable';
  if (locked && !inside) {
    const canPick = !!toolWith(game, 'LOCKPICK') && typeof t.lockpick_result === 'string';
    // BN's `pry` object (DDA's `prying` too): pry.ts
    const canPry = !!pryInfo(t)?.canPry(game);
    if (canPick) add('lockpick', `Pick the lock of the ${t.name}`, () => lockpickAttempt(game, x, y, z, t, false));
    if (canPry) add('pry', `Pry open the ${t.name}`, () => pryAttempt(game, x, y, z, t));
    if (!canPick && !canPry)
      add('locked', `Examine ${t.name} (locked)`, () => {
        sfx.doorLocked({ x: x + 0.5, y: y + 0.5, z });
        say(game, `The ${t.name} is locked.  Hit it to smash it (or [${game.keys.keyFor('smash')}]), or pry it open with a crowbar.`);
      });
  }

  // --- curtained windows (BN iexamine::curtains): curtains and window named apart (curtains.ts)
  if (tAct === 'curtains') {
    out.push(...curtainInteractions(game, x, y, z, inside, game.keys.keyFor('smash')));
  } else if (!locked || inside) {
    // --- doors, windows, gates: open / close (terrain, then furniture)
    const isDoorish = hasFlag(t, 'DOOR') || hasFlag(t, 'WINDOW') || !!t.open || !!t.close;
    const tBlocked = openCloseFlags(t) && !inside;
    if (tBlocked) {
      if (t.open || t.close) add('examine', `Examine ${t.name}`, () => say(game, `You can't reach the ${t.name}'s latch from outside.  Hit it to smash it (or [${game.keys.keyFor('smash')}]).`));
    } else if (t.open && !(locked && !inside)) add('open', `${locked ? 'Unlock and open' : 'Open'} ${t.name}`, () => say(game, openDoor(game, x, y, z)));
    else if (t.close && isDoorish && !onTile) add('close', `Close ${t.name}`, () => say(game, closeDoor(game, x, y, z)));
    if (f.open) add('open', `Open ${f.name}`, () => say(game, openDoor(game, x, y, z)));
    else if (f.close) add('close', `Close ${f.name}`, () => say(game, closeDoor(game, x, y, z)));
  }

  // --- furniture examine actions
  const later: Interaction[] = [];
  const act = fAct ?? tAct;
  const def = fAct ? f : t;
  const custom = act ? examineHandlers.get(act) : undefined;
  if (custom) out.push(...custom(game, x, y, z, def));
  else switch (act) {
    case 'sign': {
      const text = signText(game, x, y, z);
      add('read_sign', `Read the ${def.name}`, () => {
        const msg = text ? `The sign says: ${text}` : 'Nothing legible on the sign.';
        if (ui.text) ui.text(def.name, msg);
        else say(game, msg);
      });
      break;
    }
    case 'water_source':
    case 'finite_water_source':
      // BN's iuse::blech_because_unclean asks "This looks unclean, sure you want to drink it?"
      // before a sip of this water; the label carries that warning instead of a y/n popup, up front
      // because the HUD prompt truncates long labels.
      add('drink', `Drink the unclean ${def.name}`, () => drinkFrom(game, x, y, z, def.name, false));
      break;
    case 'gaspump':
    case 'pay_gas':
      add('examine', `Examine ${def.name}`, () => say(game, `The ${def.name} is out of order.  There's no power to run the pump.`));
      break;
    case 'vending':
      add('examine', `Use ${def.name}`, () => say(game, 'The vending machine is out of order.  Without power it won\'t take your money.  You could smash it open.'));
      break;
    case 'atm':
      add('examine', `Use ${def.name}`, () => say(game, 'The ATM is dark and unresponsive.'));
      break;
    case 'cardreader':
    case 'cardreader_robofac':
    case 'cardreader_fp':
      add('examine', `Examine ${def.name}`, () => say(game, 'You need an ID card to use this.'));
      break;
    case 'elevator':
      add('examine', `Use ${def.name}`, () => say(game, 'The elevator has no power.'));
      break;
    case 'fireplace':
      if (!fieldsFire(game, x, y, z)) {
        const starter = game.player.inv.allItems().find((it) => it.hasFlag('FIRESTARTER'));
        if (starter) add('light_fire', `Light a fire in the ${def.name}`, () => lightFire(game, x, y, z, starter));
      }
      break;
    case 'deployed_furniture': {
      const di = typeof f.deployed_item === 'string' ? f.deployed_item : null;
      // Looking inside a cardboard box/tent is what you usually want; taking it down comes after.
      if (di && game.data.items[di])
        later.push({ id: 'take_down', label: `Take down the ${f.name}`, run: () => {
          map.setFurn(x, y, z, 'f_null');
          spawnOnGround(map, x, y, z, createItem(game.data, di));
          say(game, `You take down the ${f.name}.`);
        } });
      break;
    }
    case 'ledge':
      break;
  }

  // --- lighting a fire on any flammable-fuel tile (a pile of wood), when holding a firestarter
  if (!out.some((o) => o.id === 'light_fire') && hasFlag(f, 'FIRE_CONTAINER') && !fieldsFire(game, x, y, z)) {
    const starter = game.player.inv.allItems().find((it) => it.hasFlag('FIRESTARTER'));
    if (starter) add('light_fire', `Light a fire in the ${f.name}`, () => lightFire(game, x, y, z, starter));
  }

  // --- sleeping spots
  if (f.id !== 'f_null' && typeof f.comfort === 'number' && f.comfort >= 3)
    add('sleep', `Sleep on the ${f.name}`, () => {
      if (!onTile) {
        p.x = x + 0.5;
        p.y = y + 0.5;
      }
      goToSleep(game);
    });

  for (const prov of interactionProviders) out.push(...prov(game, x, y, z));

  // --- containers & items (a planted crop keeps its seed as a hidden item: not a container)
  const items = map.itemsAt(x, y, z);
  // Tiny "containers" (a potted plant's 10 L of soil) only get an entry when something is in
  // them; an empty locker or dresser still invites a look.
  const storage = hasFlag(f, 'CONTAINER') && !(typeof f.max_volume === 'number' && f.max_volume <= 10000);
  if (!hasFlag(f, 'PLANT') && (items.length || (f.id !== 'f_null' && storage))) {
    const where = f.id !== 'f_null' ? f.name : t.name;
    const n = items.length;
    // Loose items on the ground read as items, not as "the floor".
    const label = f.id === 'f_null'
      ? (n === 1 ? `Pick up ${(items[0] as Item).name()}` : `Look at the ${n} items here`)
      : !hasFlag(f, 'CONTAINER') ? `Look at the items on the ${where} (${n})`
      : n ? `Look in the ${where} (${n} item${n === 1 ? '' : 's'})` : `Look in the ${where}`;
    add('pickup', label, () => {
      if (!n) return say(game, `The ${where} is empty.`);
      if (ui.pickup) ui.pickup(`${where[0].toUpperCase()}${where.slice(1)}`, x, y, z);
      else say(game, `There ${n === 1 ? 'is' : 'are'} ${n} item${n === 1 ? '' : 's'} in the ${where}.`);
    });
  }

  out.push(...later);

  // --- fallback: describe it
  if (!out.length && (f.id !== 'f_null' || !map.passable(x, y, z) || tAct)) {
    const main = f.id !== 'f_null' ? f : t;
    add('describe', `Examine ${main.name}`, () => describe(game, x, y, z));
  }
  return out;
}

function fieldsFire(game: Game, x: number, y: number, z: number): boolean {
  return game.map.fieldsAt(x, y, z).some((f) => f.type === 'fd_fire');
}

function lightFire(game: Game, x: number, y: number, z: number, starter: Item): void {
  const p = game.player;
  if (starter.ammoRemaining() <= 0 && (starter.def.max_charges ?? 0) > 0 && starter.charges <= 0) return say(game, `Your ${starter.name()} is empty.`);
  game.activities.start({
    name: 'lighting a fire',
    duration: 60,
    onComplete: () => {
      starter.ammoConsume(1);
      ignite(game, x, y, z, 1);
      say(game, 'You successfully light a fire.', 'c_green');
      p.practice('survival', 1);
    },
  });
}

/** The fallback examine: name, description, what's there. */
export function describeText(game: Game, x: number, y: number, z: number): { title: string; body: string } {
  const map = game.map;
  const t = map.terAt(x, y, z), f = map.furnAt(x, y, z);
  const parts: string[] = [];
  const main = f.id !== 'f_null' ? f : t;
  if (main.description) parts.push(cddaText(main.description));
  if (f.id !== 'f_null') parts.push(`There is a ${f.name} here, on ${t.name}.`);
  const sign = signText(game, x, y, z);
  if (sign) parts.push(`The sign says: ${sign}`);
  for (const fd of map.fieldsAt(x, y, z)) parts.push(`There is ${fieldName(game, fd)} here.`);
  if (trapAt(game, x, y, z) && playerSeesTrap(game, x, y, z)) parts.push(`There is a ${trapDef(game, trapAt(game, x, y, z)!)?.name} here.`);
  const items = map.itemsAt(x, y, z) as unknown as Item[];
  if (items.length) parts.push(`There ${items.length === 1 ? 'is' : 'are'} ${items.map((i) => (typeof i.name === 'function' ? i.name() : i.typeId)).slice(0, 6).join(', ')}${items.length > 6 ? ', …' : ''} here.`);
  if (f.id === 'f_null' && t.id !== 't_null') {
    const c = comfortAt(game, x, y, z);
    if (c.comfort >= 3) parts.push('It looks comfortable to sleep on.');
  }
  return { title: main.name, body: parts.join('\n\n') || `That is a ${main.name}.` };
}

function describe(game: Game, x: number, y: number, z: number): void {
  const d = describeText(game, x, y, z);
  if (ui.text) ui.text(d.title, d.body);
  else say(game, `${d.title}: ${d.body}`);
}

/** `e`: act on the aimed tile (the first interaction, or a menu when there are several). */
export function interact(game: Game, target: TargetTile | null = targetTile(game)): boolean {
  const p = game.player;
  if (p.dead || p.isAsleep()) return false;
  for (const o of interactOverrides) if (o.interact(game)) return true;
  // Nothing aimed at: the tile you stand on (stairs, items), CDDA examines your own square.
  const tt = target ?? { x: p.tileX, y: p.tileY, z: p.z, dist: 0 };
  const list = interactionsAt(game, tt.x, tt.y, tt.z);
  if (!list.length) {
    // Aimed at something a few steps off (the crosshair is on a cupboard across the room):
    // say it's out of reach. Playtest: "nothing to examine there" read as "this can't be used".
    const far = target ? null : targetTile(game, 6);
    const farList = far ? interactionsAt(game, far.x, far.y, far.z) : [];
    if (far && farList.length) {
      const f = game.map.furnAt(far.x, far.y, far.z), t = game.map.terAt(far.x, far.y, far.z);
      game.message(`The ${f.id !== 'f_null' ? f.name : t.name} is out of reach: step closer.`, 'c_light_gray');
    } else if (!target || !interesting(game, tt.x, tt.y, tt.z)) game.message('There is nothing to examine there.', 'c_light_gray');
    else describe(game, tt.x, tt.y, tt.z);
    return false;
  }
  // Open/close/stairs are unambiguous actions; others with alternatives get a menu.
  const primary = list[0];
  // (filling up the car at a pump is what `e` on a pump means: refuel.ts)
  if (list.length === 1 || ['open', 'close', 'stairs_up', 'stairs_down'].includes(primary.id) || primary.id.startsWith('fill_') || !ui.menu) {
    primary.run();
    return true;
  }
  const t = game.map.terAt(tt.x, tt.y, tt.z), f = game.map.furnAt(tt.x, tt.y, tt.z);
  // A burning tile is "Fire", not "Grass" (its boil-water menu read oddly).
  const title = fieldsFire(game, tt.x, tt.y, tt.z) ? 'fire' : f.id !== 'f_null' ? f.name : t.name;
  ui.menu(title.replace(/^./, (c) => c.toUpperCase()), list);
  return true;
}

/** HUD hint for the aimed tile, e.g. "[e] Open closed wood door", or null. */
export function interactionPrompt(game: Game): string | null {
  const p = game.player;
  if (p.dead || p.isAsleep() || game.activities.current) return null;
  for (const o of interactOverrides) {
    const text = o.prompt(game);
    if (text !== null) return text || null;
  }
  const t = targetTile(game);
  const key = game.keys.keyFor('interact');
  if (t) {
    const list = interactionsAt(game, t.x, t.y, t.z);
    // A bare description (walls, stools, bushes) isn't worth a prompt; `e` still shows it.
    if (list.length && !(list.length === 1 && list[0].id === 'describe')) return `[${key}] ${list[0].label}${list.length > 1 ? ' …' : ''}`;
  } else {
    // Something usable a few steps away: name it, so the player knows to walk up to it.
    const far = targetTile(game, 4);
    const list = far ? interactionsAt(game, far.x, far.y, far.z) : [];
    if (far && list.length && !(list.length === 1 && list[0].id === 'describe')) return `${list[0].label} (step closer)`;
  }
  // Standing on stairs: suggest the stair keys.
  const here = game.map.terAt(p.tileX, p.tileY, p.z);
  if (hasFlag(here, 'GOES_UP')) return `[${game.keys.keyFor('stairs_up')}] Go up the ${here.name}`;
  if (hasFlag(here, 'GOES_DOWN')) return `[${game.keys.keyFor('stairs_down')}] Go down the ${here.name}`;
  return null;
}
