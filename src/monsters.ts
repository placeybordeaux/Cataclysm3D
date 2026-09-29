import type { Game, LookCreature } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { WorldGenerator } from './world/worldgen';
import { MonsterSystem } from './game/monai';
import { findPath } from './game/pathfind';
import { Spawner, type OvermapView } from './game/spawner';
import { PlayerCombat, type ViewModelHook } from './game/playercombat';
import { MonsterView, NEAR_CLAMP } from './render/monsterView';
import { HitFx } from './render/hitFx';
import { butcherSeconds, butcherToolQuality, butcherYield, type ButcherKind, canDissect, dissectPracticeCap, dissectSeconds, dissectToolMessage, dissectToolQuality, dissectYield } from './game/butchery';
import { monsterSize, type Monster } from './game/monster';
import { createItem, loadAmmo, type Item } from './game/item';
import { snippet } from './data/index';
import { openMenu } from './ui/framework';
import { registerOption } from './ui/options';
import { cycleDensity, defaultDensity, densityLabel, registerDensityHost } from './game/density';
import { registerSaveable } from './save/registry';

// Wiring for monsters & combat: simulation systems, spawning, player attacks, keys, danger
// checks, rendering and window.cdda helpers. main.ts calls installMonsters() once.

export interface MonstersHandle {
  sys: MonsterSystem;
  spawner: Spawner;
  combat: PlayerCombat;
  view: MonsterView | null;
}

/** Adapter from the world generator's overmap to what the spawner needs. */
export function overmapView(wg: WorldGenerator): OvermapView {
  return {
    omtType: (x, y, z) => wg.overmap.omtAt(x, y, z).type,
    mondensity: (x, y) => wg.wg.overmap.terrains[wg.overmap.omtAt(x, y, 0).type]?.mondensity ?? 0,
    citiesNear: (x, y) => wg.overmap.citiesNear(x, y),
  };
}

export function installMonsters(game: Game, renderer: Renderer | null, worldgen: WorldGenerator | null, api?: DebugApi): MonstersHandle {
  const sys = new MonsterSystem(game);
  const spawner = new Spawner(sys, worldgen ? overmapView(worldgen) : null);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  // Zombie density (CDDA SPAWN_DENSITY): the remembered choice until character creation
  // or a loaded save says otherwise. In the browser, spawns wait for the game to start so
  // the chunks generated behind the title screen use the density picked for the new game.
  spawner.opts.density = defaultDensity();
  registerDensityHost(game, { get: () => spawner.opts.density, set: (v) => void (spawner.opts.density = v) });
  registerSaveable<number>(game, 'zombieDensity', {
    order: 19,
    save: () => spawner.opts.density,
    load: (v) => void (spawner.opts.density = v),
    missing: () => void (spawner.opts.density = 1),
  });
  if (renderer) {
    spawner.hold();
    game.events.on('gameLoaded', () => spawner.discardHeld());
    registerOption({
      name: 'Zombie density',
      value: () => densityLabel(spawner.opts.density),
      change: (d) => void (spawner.opts.density = cycleDensity(spawner.opts.density, d)),
      desc: 'CDDA spawn density for this world (0.5x / 1.0x / 2.0x), already eased for real time at 1.0x.  Changes apply to areas you haven\'t visited yet.',
    });
  }
  spawner.install();
  let view: MonsterView | null = null;
  if (renderer) {
    view = new MonsterView(game, renderer, sys, combat);
    game.systems.push(view);
    combat.viewmodel = () => (renderer as unknown as { viewmodel?: ViewModelHook }).viewmodel;
    const fx = new HitFx(game, renderer, view);
    if (api) Object.assign(api, { hitFx: fx, nearClamp: NEAR_CLAMP });
  }
  (game as unknown as { monsters: MonsterSystem }).monsters = sys;

  // Danger checks (CDDA activity distractions). You can't start with a hostile in view
  // within 30 tiles; once busy, you're interrupted when a hostile comes within 30 or a new
  // one is spotted anywhere in view (CDDA hostile_spotted_far: MAX_VIEW_DISTANCE 60), but not
  // by one that was already in sight far away when you started.
  const DANGER_NEAR = 30, VIEW = 60;
  let snap: { act: unknown; seen: Set<Monster> } | null = null;
  const seeName = (m: Monster) => {
    const n = m.displayName();
    return `You see ${m.name ? n : `${/^[aeiou]/i.test(n) ? 'an' : 'a'} ${n}`}!`;
  };
  game.activities.dangerChecks.push(() => {
    const act = game.activities.current;
    if (!act) {
      const m = sys.visibleHostile(DANGER_NEAR);
      return m ? seeName(m) : null;
    }
    const list = sys.visibleHostiles(VIEW);
    if (snap?.act !== act) snap = { act, seen: new Set(list.filter((m) => sys.distToPlayer(m) > DANGER_NEAR)) };
    for (const m of list) {
      if (sys.distToPlayer(m) <= DANGER_NEAR) return seeName(m);
      if (!snap.seen.has(m)) return `${m.displayName().replace(/^./, (ch) => ch.toUpperCase())} spotted!`;
    }
    return null;
  });

  // Look mode / crosshair raycasts see monsters.
  game.creatureAt = (x, y, z) => {
    const m = sys.monsterAt(x, y, z);
    return m ? { name: m.displayName(), symbol: m.type.symbol, color: m.type.color, describe: () => describeMonster(m), monster: m } as LookCreature : null;
  };

  // Sidebar safe-mode indicator: danger while a hostile is in view (CDDA safe mode).
  let safeT = 0;
  game.systems.push({
    name: 'safe-mode',
    update(_g, dt) {
      if ((safeT -= dt) > 0) return;
      safeT = 0.5;
      const hud = api?.hud as { safeMode?: { text: string; color: string } } | undefined;
      if (!hud) return;
      const m = sys.visibleHostile(40);
      hud.safeMode = m ? { text: 'DANGER', color: 'c_red' } : { text: 'SAFE', color: 'c_green' };
    },
  });

  game.keys.register('fire', 'Fire wielded weapon', () => {
    if (game.player.inv.wielded?.isGun()) combat.fire();
    else game.message('You are not wielding a ranged weapon.');
  });
  game.keys.register('throw', 'Throw item', () => throwMenu(game, combat));
  game.keys.register('butcher', 'Butcher corpse', () => butcherMenu(game, sys));

  if (api) installDebug(api, game, sys, spawner, combat);
  return { sys, spawner, combat, view };
}

/** Look-mode text: CDDA monster::extended_description basics (health, attitude, description). */
export function describeMonster(m: Monster): string {
  const f = m.hp / m.hpMax;
  const health = f >= 1 ? '<color_green>It is uninjured.</color>' : f > 0.75 ? '<color_light_green>It is lightly injured.</color>'
    : f > 0.5 ? '<color_yellow>It is moderately injured.</color>' : f > 0.25 ? '<color_light_red>It is heavily injured.</color>' : '<color_red>It is nearly dead!</color>';
  const att = { attack: '<color_red>Hostile!</color>', flee: '<color_light_green>Fleeing!</color>', follow: '<color_yellow>Tracking.</color>', ignore: '<color_light_gray>Ignoring.</color>', friend: '<color_green>Friendly.</color>' }[m.attitude()];
  const status = [m.hasEffect('downed') ? 'downed' : '', m.hasEffect('stunned') ? 'stunned' : '', m.hasEffect('grabbing') ? 'grabbing' : ''].filter(Boolean).join(', ');
  return `${att}  ${health}${status ? `  <color_light_blue>(${status})</color>` : ''}\n${m.type.description ?? ''}`;
}

// ------------------------------------------------------------------ throw / butcher UI

function throwMenu(game: Game, combat: PlayerCombat): void {
  const p = game.player;
  const items = [p.inv.wielded, ...p.inv.carried()].filter((i): i is Item => !!i);
  if (!items.length) return game.message('You have nothing to throw.');
  openMenu<Item>({
    title: 'Throw item',
    entries: items.map((it) => ({ label: it.name(), value: it, header: it === p.inv.wielded ? 'Wielded' : 'Inventory' })),
    onSelect: (it) => {
      combat.throwItem(it);
    },
  });
}

interface CorpseAt {
  item: Item;
  x: number;
  y: number;
  z: number;
}

/** Corpse items on and around the survivor's tile. */
export function corpsesNear(game: Game): CorpseAt[] {
  const p = game.player;
  const out: CorpseAt[] = [];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++) {
      const x = p.tileX + dx, y = p.tileY + dy;
      for (const it of game.map.itemsAt(x, y, p.z) as Item[]) if (it.typeId === 'corpse' && typeof it.vars?.corpse === 'string') out.push({ item: it, x, y, z: p.z });
    }
  return out;
}

/** Start a butchering activity on a corpse. Returns false (with a message) when impossible. */
export function startButcher(game: Game, sys: MonsterSystem, c: CorpseAt, kind: ButcherKind): boolean {
  const p = game.player;
  const def = game.data.monsters[c.item.vars.corpse as string];
  if (!def) {
    game.message('You can\'t make sense of this corpse.');
    return false;
  }
  const q = butcherToolQuality(p);
  if (q < 0) {
    game.message("You don't have a sharp item to butcher with.");
    return false;
  }
  const secs = butcherSeconds(def, q, kind);
  return game.activities.start({
    name: `butchering the ${def.name}`,
    duration: secs,
    onComplete: () => {
      if (!game.map.itemsAt(c.x, c.y, c.z).includes(c.item as any)) return game.message('The corpse is gone.');
      const res = butcherYield(game.data, p, def, q, kind, sys.rng);
      const h = def.harvest ? game.data.misc.harvest?.[def.harvest] : undefined;
      const tag = typeof h?.message === 'string' ? /^<(.+)>$/.exec(h.message) : null;
      const flavour = tag ? snippet(game.data, tag[1], sys.rng) : (h?.message as string | undefined);
      if (flavour && res.ok) game.message(flavour);
      for (const msg of res.messages) game.message(msg);
      if (!res.ok) return;
      sys.removeCorpseItem(c.item, c.x, c.y, c.z);
      for (const it of res.items) game.map.addItem(c.x, c.y, c.z, it);
      const cap = Math.max(0, { tiny: 0, small: 1, medium: 2, large: 3, huge: 4 }[monsterSize(def)] - 2) + 4;
      p.practice('survival', res.practice, cap);
      game.message(`You finish butchering the ${def.name}.`);
    },
  });
}

/** Start dissecting a corpse (CDDA ACT_DISSECT). Returns false (with a message) when impossible. */
export function startDissect(game: Game, sys: MonsterSystem, c: CorpseAt): boolean {
  const p = game.player;
  const def = game.data.monsters[c.item.vars.corpse as string];
  if (!def) {
    game.message('You can\'t make sense of this corpse.');
    return false;
  }
  if (!canDissect(game.data, def)) {
    game.message(`There's nothing to dissect in the ${def.name}.`);
    return false;
  }
  const q = dissectToolQuality(p);
  const toolMsg = dissectToolMessage(q);
  if (q <= 0) {
    game.message(toolMsg!);
    return false;
  }
  if (toolMsg) game.message(toolMsg);
  return game.activities.start({
    name: `dissecting the ${def.name}`,
    duration: dissectSeconds(def, q),
    onComplete: () => {
      if (!game.map.itemsAt(c.x, c.y, c.z).includes(c.item as any)) return game.message('The corpse is gone.');
      const res = dissectYield(game.data, p, def, q, sys.rng, c.item.damageLevel());
      const h = def.dissect ? game.data.misc.harvest?.[def.dissect] : undefined;
      if (typeof h?.message === 'string' && res.ok) game.message(h.message);
      for (const msg of res.messages) game.message(msg, /^You discover/.test(msg) ? 'c_light_green' : undefined);
      if (!res.ok) return;
      sys.removeCorpseItem(c.item, c.x, c.y, c.z);
      for (const it of res.items) game.map.addItem(c.x, c.y, c.z, it);
      p.practice('firstaid', res.practice, dissectPracticeCap(def, q));
      game.message(`You finish dissecting the ${def.name}.`);
    },
  });
}

function butcherMenu(game: Game, sys: MonsterSystem): void {
  const list = corpsesNear(game);
  if (!list.length) return game.message('There are no corpses here to butcher.');
  const pickKind = (c: CorpseAt) => {
    const def = game.data.monsters[c.item.vars.corpse as string];
    const q = Math.max(0, butcherToolQuality(game.player));
    const fmt = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} hours` : `${Math.round(s / 60)} minutes`);
    const fine = dissectToolQuality(game.player);
    const dissectable = !!def && canDissect(game.data, def);
    openMenu<ButcherKind | 'dissect'>({
      title: `Butcher the ${def?.name ?? 'corpse'}`,
      entries: [
        ...(['quick', 'full'] as ButcherKind[]).map((k) => ({
          label: `${k === 'quick' ? 'Quick butchery' : 'Full butchery'}  (${def ? fmt(butcherSeconds(def, q, k)) : '?'})`,
          value: k as ButcherKind | 'dissect',
        })),
        // CDDA's butcher menu greys Dissect out with the reason (no CUT_FINE tool, nothing inside).
        {
          label: `Dissect  (${!dissectable ? 'nothing to dissect' : fine <= 0 ? 'needs a fine cutting tool' : fmt(dissectSeconds(def!, fine))})`,
          value: 'dissect' as const,
          disabled: !dissectable || fine <= 0,
        },
      ],
      onSelect: (k) => {
        if (k === 'dissect') startDissect(game, sys, c);
        else startButcher(game, sys, c, k);
      },
    });
  };
  if (list.length === 1) return pickKind(list[0]);
  openMenu<CorpseAt>({
    title: 'Butcher which corpse?',
    entries: list.map((c) => ({ label: `corpse of a ${c.item.vars.corpse_name ?? c.item.vars.corpse}`, value: c })),
    onSelect: (c) => {
      // Let this menu close before opening the next.
      setTimeout(() => pickKind(c), 0);
    },
  });
}

// ------------------------------------------------------------------ debug API

function installDebug(api: DebugApi, game: Game, sys: MonsterSystem, spawner: Spawner, combat: PlayerCombat): void {
  const p = () => game.player;
  api.monsterSystem = sys;
  api.combat = combat;
  /** A* route (door-opening, like a survivor) from the player to (x, y) on their z-level, for playtest scripts. */
  api.findPath = (x: number, y: number, maxNodes = 40000) =>
    findPath(sys.grid, p().tileX, p().tileY, x, y, p().z, { doors: true, maxNodes, margin: 40 });
  /** Spawn a monster at (dx, dy) tiles from the player (x east, y south). Returns its uid. */
  api.spawnMonster = (id: string, dx = 0, dy = -5, opts: { friendly?: boolean } = {}) => {
    const m = sys.spawnById(id, p().x + dx, p().y + dy, p().z, opts);
    return m ? m.uid : null;
  };
  api.monsters = (all = false) =>
    (all ? sys.all : sys.active).map((m) => ({
      uid: m.uid, id: m.type.id, x: +m.x.toFixed(2), y: +m.y.toFixed(2), z: m.z, hp: m.hp,
      dist: +sys.distToPlayer(m).toFixed(2), attitude: m.attitude(), sees: m.seesPlayer, dormant: m.dormant,
    }));
  api.monsterCount = () => ({ all: sys.all.length, active: sys.active.length, spawner: spawner.stats });
  api.killAll = (radius = Infinity) => {
    let n = 0;
    for (const m of [...sys.active]) if (!m.dead && sys.distToPlayer(m) <= radius) (sys.die(m, 'player'), n++);
    return n;
  };
  api.clearMonsters = (radius = Infinity) => {
    let n = 0;
    for (const m of [...sys.all]) if (!m.dead && sys.distToPlayer(m) <= radius) (sys.remove(m), n++);
    return n;
  };
  /** One attack now (ignores the swing cooldown): melee or fire depending on the weapon. */
  api.attack = () => {
    combat.cooldown = 0;
    combat.attack();
    return game.player.inv.wielded?.name() ?? 'unarmed';
  };
  api.fire = () => {
    combat.cooldown = 0;
    return combat.fire();
  };
  api.throwItem = () => combat.throwItem();
  /** Wield a gun with a loaded magazine (scripted gunfire tests). */
  api.giveLoadedGun = (gunId = 'glock_19', magId = 'glockmag', ammo = '9mm') => {
    const gun = createItem(game.data, gunId);
    const well = gun.magazineWell();
    if (well) well.insert(createItem(game.data, magId, { ammo }));
    else loadAmmo(gun, ammo);
    return p().inv.wield(gun).msg;
  };
  /** Face the nearest active monster (for scripted fights). */
  api.faceMonster = (uid?: number) => {
    const list = sys.active.filter((m) => !m.dead && (uid === undefined || m.uid === uid));
    list.sort((a, b) => sys.distToPlayer(a) - sys.distToPlayer(b));
    const m = list[0];
    if (!m) return false;
    p().yaw = Math.atan2(m.x - p().x, -(m.y - p().y));
    return true;
  };
  api.corpses = () => corpsesNear(game).map((c) => ({ id: c.item.vars.corpse, x: c.x, y: c.y }));
  api.allCorpses = () => sys.corpses.map((c) => ({ id: c.monId, x: Math.floor(c.x), y: Math.floor(c.y), valid: sys.corpseValid(c) }));
  /** Far-monster retention: live list size vs monsters/dormant corpses folded into OMT columns. */
  api.monsterStash = () => ({ live: sys.all.length, active: sys.active.length, ...sys.stash.count(), columns: sys.stash.columns.size, ...sys.stash.stats });
  /** Butcher the nearest corpse (no menu); completes after the activity runs (use cdda.step). */
  api.butcher = (kind: ButcherKind = 'quick') => {
    const c = corpsesNear(game)[0];
    if (!c) return 'no corpse';
    return startButcher(game, sys, c, kind);
  };
  api.kills = () => Object.fromEntries(sys.kills);
  /** Dissect the nearest corpse (no menu); completes after the activity runs (use cdda.step). */
  api.dissect = () => {
    const c = corpsesNear(game)[0];
    if (!c) return 'no corpse';
    return startDissect(game, sys, c);
  };
}
