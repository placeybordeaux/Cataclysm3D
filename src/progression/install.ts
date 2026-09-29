// Progression wiring (docs/DESIGN_V2.md decision 6): feeds the profile's lifetime stats from
// the running game, earns unlocks (toast + log + death screen + title banner), runs the
// discovery nudges (discovery.ts rules) and the "you could craft" watcher, keeps the run's
// journal state in the save, and registers the Journal key (J) and cdda.progression.
//
// main.ts: installProgression() after installAchievements, begin(loaded) when play starts.
//
// Other systems can report progress without knowing about this module's internals:
//   progressionOf(game)?.bump('corpses_butchered')        // a counter stat (profile.ts)
//   progressionOf(game)?.note('labs', 'lab@12,-4')        // a unique-set stat
//   progressionOf(game)?.discover('first_locked')         // a first-encounter tip (discovery.ts)
// Most of these are detected here already (events, activities, polling); the hooks exist for
// systems that know better (e.g. the interact code when a locked door refuses to open).

import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import type { UiContext } from '../ui/context';
import type { WorldGenerator } from '../world/worldgen';
import type { AchievementsHandle } from '../achievements';
import type { RecipeDef } from '../data/types';
import type { Item } from '../game/item';
import { DATA_BASE } from '../core/assets';
import { globalAchievements } from '../game/achievements';
import { availableRecipes, canCraft, craftedHooks, craftingInventory, recipeName } from '../game/crafting';
import { MAIN_PARTS } from '../game/bodyparts';
import { CHUNK } from '../world/coords';
import { LAB_BASEMENT_TYPES } from '../world/overmap/overmap';
import { registerSaveable } from '../save/registry';
import { registerOption } from '../ui/options';
import { profile as browserProfile, type CounterStat, type Profile, type SetId } from './profile';
import { available, newlyEarned, validateCatalogue, type Catalogue, type UnlockDef, type UnlockEnv } from './unlocks';
import { NUDGES, NudgeQueue, craftableDiff, reachSignature, recipeNudgeText } from './discovery';
import { SCENARIO_PLACEMENT } from './placement';
import { applyDifficulty, DEFAULT_DIFFICULTY, type Difficulty } from './difficulty';
import { CraftBadge, nudgeToast, unlockToast, withKeys } from './ui';
import { openJournal } from './journal';
import { setProgression } from './registry';

/** Per-character journal state (in the save). */
export interface RunState {
  v: 1;
  /** Unlock id of the start card ('' = custom creator / old save). */
  startId: string;
  difficulty: Difficulty;
  /** Cosmetic title ("the Unlucky"), '' = none. */
  title: string;
  /** Places visited this life, in order: towns and notable locations. */
  places: { name: string; at: number }[];
  /** Recipes announced this life (names), newest last. */
  recipes: string[];
  /** Unlocks earned during this life. */
  unlocked: string[];
}

export const emptyRun = (): RunState => ({ v: 1, startId: '', difficulty: DEFAULT_DIFFICULTY, title: '', places: [], recipes: [], unlocked: [] });

export interface ProgressionHandle {
  profile: Profile;
  catalogue: Catalogue;
  env: UnlockEnv;
  run: RunState;
  queue: NudgeQueue;
  badge: CraftBadge;
  /** Report a counter stat. */
  bump(stat: CounterStat, n?: number): void;
  /** Report a unique-set stat (towns, books, labs, vehicles). */
  note(set: SetId, value: string): void;
  /** A first-encounter tip id (discovery.ts NUDGES) happened. */
  discover(id: string): void;
  /** New game chosen (before begin): the start card, difficulty and title. */
  newRun(o: { startId: string; difficulty: Difficulty; title: string }): void;
  /** Play starts: a fresh character or a loaded save. */
  begin(loaded: boolean): void;
  /** Re-check unlocks now; returns the newly earned ones. */
  evaluate(): UnlockDef[];
  /** Available right now (earned, free or Classic mode). */
  isAvailable(u: UnlockDef): boolean;
  achName(id: string): string;
  /** Unlocks earned but not yet announced on the title screen (clears them). */
  takeTitleBanner(): UnlockDef[];
}

export { progressionOf } from './registry';

export async function loadCatalogue(base = DATA_BASE): Promise<unknown> {
  const res = await fetch(base + 'unlocks.json');
  if (!res.ok) throw new Error(`Failed to load ${base}unlocks.json: HTTP ${res.status}`);
  return res.json();
}

const HUNGRY = new Set(['Hungry', 'Very hungry', 'Famished', 'Near starving', 'Starving!']);
const THIRSTY = new Set(['Thirsty', 'Very thirsty', 'Dehydrated', 'Parched']);
const COLD = new Set(['Chilly', 'Very cold!', 'Freezing!']);

export async function installProgression(
  game: Game,
  ctx: UiContext,
  worldgen: WorldGenerator | null,
  achievements: AchievementsHandle | null,
  api?: DebugApi,
  opts: { profile?: Profile; catalogue?: unknown } = {},
): Promise<ProgressionHandle> {
  const prof = opts.profile ?? browserProfile();
  const misc = game.data.misc ?? {};
  const catalogue = validateCatalogue(opts.catalogue ?? (await loadCatalogue()), {
    professions: new Set(Object.keys(misc.profession ?? {})),
    scenarios: new Set(Object.keys(misc.scenario ?? {})),
    achievements: new Set(Object.keys(achievements?.data.achievements ?? {})),
    placeableScenarios: new Set(Object.keys(SCENARIO_PLACEMENT)),
  });
  const global = globalAchievements();
  const env: UnlockEnv = { achievements: global, stat: (id) => prof.stat(id) };
  const achName = (id: string) => achievements?.data.achievements[id]?.name?.replace(/^\[[^\]]+\]\s*/, '') ?? id;
  let run = emptyRun();
  let active = false;
  /** newRun() was called for the coming game. */
  let chosen = false;
  const now = () => performance.now();

  // ------------------------------------------------------------------ unlocks
  let dirty = true;
  let achCount = -1;
  prof.onChange = () => void (dirty = true);
  const evaluate = (): UnlockDef[] => {
    dirty = false;
    achCount = global.ids().length;
    const got = newlyEarned(catalogue, env, (id) => prof.isUnlocked(id));
    for (const u of got) {
      prof.unlock(u.id, game.player.name || '');
      if (!active) continue;
      run.unlocked.push(u.id);
      unlockToast(game, u.name, u.kind, u.icon);
      game.message(`Unlocked: ${u.name}.  ${u.kind === 'cosmetic' ? 'Pick it' : 'Choose it'} in New Game.`, 'c_light_green');
    }
    if (got.length) prof.flush();
    return got;
  };

  // ------------------------------------------------------------------ nudges
  const queue = new NudgeQueue((id) => prof.has('hintsShown', id));
  const badge = new CraftBadge(game);
  let pendingRecipes: RecipeDef[] = [];
  const discover = (id: string) => {
    const d = NUDGES[id];
    if (!d) throw new Error(`progression: unknown discovery ${id}`);
    prof.mark('discovered', id);
    if (active && prof.data.options.hints) queue.offer(id, d.priority, now());
  };
  let lastDanger = -1e9;
  for (const ev of ['playerHurt', 'playerAttack', 'monsterAttack'] as const) game.events.on(ev, () => void (lastDanger = now()));
  const monsters = () => (game as unknown as { monsters?: { visibleHostile(r: number): unknown; visibleHostiles(r: number): { type: { species?: string[] } }[] } }).monsters;
  /** Fighting or busy: nudges wait (never during combat, never over a window). */
  const blocked = () => {
    const p = game.player;
    return !active || p.dead || game.paused || game.input.captured || now() - lastDanger < 8000 || !!monsters()?.visibleHostile(8);
  };
  const showNext = () => {
    const n = queue.next(now(), blocked());
    if (!n) return;
    if (n.id === 'craft') {
      const names = pendingRecipes.map((r) => recipeName(game.data, r));
      if (!names.length) return;
      const t = recipeNudgeText(names);
      nudgeToast(game, { title: t.title, body: t.body, key: `craft:${now()}`, icon: pendingRecipes[0].result });
      for (const r of pendingRecipes) prof.mark('recipesNotified', r.id);
      run.recipes.push(...names);
      badge.add(names.length);
      pendingRecipes = [];
      // Telling about crafting *is* the crafting tip (marked shown first so it isn't queued).
      prof.mark('hintsShown', 'first_craft');
      discover('first_craft');
      return;
    }
    const d = NUDGES[n.id];
    prof.mark('hintsShown', n.id);
    nudgeToast(game, { title: d.title, body: d.body, key: `nudge:${d.id}`, category: d.category });
  };

  // First-encounter probes. Each reads game state defensively: a system another agent is
  // rewriting must not take the whole watcher down (warn once, drop that probe).
  const p = game.player;
  const within = (x: number, y: number, z: number, r: number) => z === p.z && Math.hypot(x - p.x, y - p.y) <= r;
  const scan = (r: number, test: (x: number, y: number) => boolean) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (test(p.tileX + dx, p.tileY + dy)) return true;
    return false;
  };
  const flagged = (x: number, y: number, flag: string) =>
    !!game.map.terAt(x, y, p.z).flags?.includes(flag) || !!game.map.furnAt(x, y, p.z).flags?.includes(flag);
  let startZ = p.z;
  const probes: Record<string, () => boolean> = {
    first_zombie: () => !!monsters()?.visibleHostiles(40).some((m) => m.type.species?.includes('ZOMBIE')),
    first_hunger: () => HUNGRY.has(p.hungerState()),
    first_thirst: () => THIRSTY.has(p.thirstDescription()),
    first_fatigue: () => p.sleepinessDescription() !== '',
    first_night: () => p.z >= 0 && (game.clock.hourOfDay >= 20.5 || game.clock.hourOfDay < 5),
    first_bleed: () => p.hasEffect('bleed'),
    first_locked: () => scan(2, (x, y) => /locked/.test(game.map.terAt(x, y, p.z).id) && /door|gate/.test(game.map.terAt(x, y, p.z).id)),
    first_overweight: () => p.inv.weightCarried() > p.inv.weightCapacity(),
    first_stairs: () => p.z !== startZ || scan(2, (x, y) => flagged(x, y, 'GOES_DOWN') || flagged(x, y, 'GOES_UP')),
    first_vehicle: () => !!game.vehicles?.list.some((v) => within(v.x, v.y, v.z, 16)),
    first_npc: () => !!(game as unknown as { npcs?: { npcs: { x: number; y: number; z: number; dead?: boolean }[] } }).npcs?.npcs.some((n) => !n.dead && within(n.x, n.y, n.z, 14)),
    first_corpse: () => scan(1, (x, y) => (game.map.itemsAt(x, y, p.z) as Item[]).some((it) => it.typeId === 'corpse')),
    first_cold: () => COLD.has(p.bodyTempDescription()),
    first_book: () => p.inv.allItems().some((it) => it.isBook() && !p.identifiedBooks.has(it.typeId)),
    first_rain: () => p.z >= 0 && !!game.weather?.rains,
  };
  const broken = new Set<string>();
  const runProbes = () => {
    const hints = prof.data.options.hints;
    for (const [id, test] of Object.entries(probes)) {
      if (broken.has(id) || (hints ? prof.has('hintsShown', id) : prof.has('discovered', id)) || queue.queue.some((q) => q.id === id)) continue;
      let hit = false;
      try {
        hit = test();
      } catch (e) {
        broken.add(id);
        console.warn(`progression: discovery probe ${id} failed, disabled for this session`, e);
      }
      if (hit) discover(id);
    }
  };

  // "You could craft…": recompute only when what's in reach, known recipes or skills change.
  let craftPrev: Set<string> | null = null;
  let craftSig = '';
  let craftStartAt = 0;
  const checkCraftable = () => {
    if (now() < craftStartAt) return;
    const inv = craftingInventory(game);
    const sig = reachSignature([
      ...inv.sources.map((s) => s.item.typeId),
      `#known${p.learnedRecipes.size}`,
      ...Object.entries(p.skills).map(([k, v]) => `#${k}${v.level}`),
      ...[...p.identifiedBooks].map((b) => `#b${b}`),
    ]);
    if (sig === craftSig) return;
    craftSig = sig;
    const nowSet = new Set<string>();
    const byId = new Map<string, RecipeDef>();
    for (const k of availableRecipes(p, inv)) {
      // Light is ignored: nightfall shouldn't make a recipe "new" again at dawn.
      if (canCraft(game, k.recipe, 1, inv, true).ok) {
        nowSet.add(k.recipe.id);
        byId.set(k.recipe.id, k.recipe);
      }
    }
    const fresh = craftableDiff(craftPrev ?? new Set(), nowSet, (id) => prof.has('recipesCrafted', id), (id) => prof.has('recipesNotified', id) || pendingRecipes.some((r) => r.id === id));
    craftPrev = nowSet;
    if (!fresh.length) return;
    pendingRecipes.push(...fresh.map((id) => byId.get(id)!));
    if (prof.data.options.hints) queue.offer('craft', 3, now(), true);
    else {
      for (const r of pendingRecipes) prof.mark('recipesNotified', r.id);
      run.recipes.push(...pendingRecipes.map((r) => recipeName(game.data, r)));
      pendingRecipes = [];
    }
  };
  craftedHooks.push((r, batch) => {
    game.stats.itemsCrafted += batch;
    if (!active) return;
    prof.add('items_crafted', batch);
    prof.mark('recipesCrafted', r.id);
    pendingRecipes = pendingRecipes.filter((x) => x.id !== r.id);
  });
  // Opening crafting clears the badge (the new recipes are in there).
  const craftKey = game.keys.handler('craft');
  if (craftKey)
    game.keys.register('craft', 'Craft items', () => {
      badge.clear();
      craftKey();
    });

  // ------------------------------------------------------------------ stats
  game.events.on('creatureDied', (e) => {
    if (!active || e.killer !== game.player) return;
    const cr = e.creature as { type?: { id?: string; species?: string[] } } | null;
    if (!cr?.type) return;
    prof.add('kills');
    const species = cr.type.species ?? game.data.monsters[cr.type.id ?? '']?.species ?? [];
    if (species.includes('ZOMBIE')) prof.add('zombie_kills');
  });
  game.events.on('playerDied', () => {
    if (!active) return;
    prof.add('deaths');
    evaluate();
    active = false;
    prof.flush();
  });
  p.inv.onConsume.push(() => void (active && prof.add('foods_eaten')));
  // Activities finishing (butchering…): wrap start() so owners need no changes.
  const start = game.activities.start.bind(game.activities);
  game.activities.start = (spec) => {
    if (/^butchering /.test(spec.name)) {
      const done = spec.onComplete;
      spec = { ...spec, onComplete: () => (done(), active && prof.add('corpses_butchered')) };
    }
    return start(spec);
  };

  let lastDist = 0;
  let lastHp = new Map<string, number>();
  const hpSnap = () => new Map(MAIN_PARTS.map((bp) => [bp, p.hp[bp]?.cur ?? 0]));
  let driving: { key: string; x: number; y: number; dist: number } | null = null;
  let lastOmt = '';
  const addPlace = (name: string) => {
    if (run.places.some((pl) => pl.name === name)) return;
    run.places.push({ name, at: game.clock.seconds });
  };
  const humanize = (s: string) => s.replace(/_/g, ' ').replace(/\b(\d+)\b/g, '').replace(/\s+/g, ' ').trim();
  const pollStats = () => {
    // Distance (the UI's walk tracker), healing, days, books.
    const d = game.stats.distanceWalked - lastDist;
    lastDist = game.stats.distanceWalked;
    if (d > 0 && d < 500) prof.add('distance_m', d);
    const hp = hpSnap();
    let healed = 0;
    for (const [bp, cur] of hp) healed += Math.max(0, cur - (lastHp.get(bp) ?? cur));
    lastHp = hp;
    if (healed > 0) prof.add('hp_healed', healed);
    prof.max('best_days', Math.floor((game.clock.seconds - game.stats.startSeconds) / 86400));
    for (const b of p.identifiedBooks) prof.note('books', b);
    // Vehicles: at the controls and actually moved 30 m.
    const v = game.vehicles?.driving;
    if (v) {
      if (!driving || !driving.key.endsWith(`#${v.uid}`)) driving = { key: `${game.seed}:${v.name}@${Math.floor(v.x / CHUNK)},${Math.floor(v.y / CHUNK)}#${v.uid}`, x: v.x, y: v.y, dist: 0 };
      driving.dist += Math.hypot(v.x - driving.x, v.y - driving.y);
      driving.x = v.x;
      driving.y = v.y;
      if (driving.dist >= 30) prof.note('vehicles', driving.key.replace(/#\d+$/, ''));
    } else driving = null;
    // Where you are: towns (city radius), notable locations, labs.
    const omx = Math.floor(p.x / CHUNK), omy = Math.floor(p.y / CHUNK);
    const key = `${omx},${omy},${p.z}`;
    if (key === lastOmt || !worldgen) return;
    lastOmt = key;
    const ov = worldgen.overmap;
    const city = ov.closestCity(omx, omy, 1);
    if (city && Math.hypot(city.x - omx, city.y - omy) <= city.size) {
      prof.note('towns', `${game.seed}:${city.name}`);
      addPlace(city.name);
    }
    const o = ov.omtAt(omx, omy, p.z);
    const sp = o.special;
    if (sp) addPlace(humanize(sp.def));
    if (p.z < 0 && ((LAB_BASEMENT_TYPES as readonly string[]).includes(o.type) || /lab/i.test(sp?.def ?? ''))) {
      prof.note('labs', `${game.seed}:${sp?.uid ?? key}`);
      addPlace('an underground lab');
    }
  };

  // A fresh start never opens with a monster in your face (BN picks start spots away from
  // monsters; our mapgen/spawner can place one in the start house). For the first seconds of
  // a new game — spawns are released just before begin() — hostiles right next to the
  // start are removed.
  let clearUntil = 0;
  const CLEAR_RADIUS = 10;
  const clearStart = () => {
    const sys = (game as unknown as { monsters?: { all: { x: number; y: number; z: number; dead: boolean; attitude(): string }[]; remove(m: unknown): void } }).monsters;
    if (!sys) return;
    for (const m of sys.all) if (!m.dead && m.attitude() === 'attack' && within(m.x, m.y, m.z, CLEAR_RADIUS)) sys.remove(m);
  };

  // ------------------------------------------------------------------ tick
  let pollT = 0, craftT = 0, flushT = 0;
  game.systems.push({
    name: 'progression',
    update(_g, realDt) {
      if (!active) return;
      if (clearUntil && now() < clearUntil) clearStart();
      if ((pollT -= realDt) <= 0) {
        pollT = 0.5;
        pollStats();
        runProbes();
      }
      if ((craftT -= realDt) <= 0) {
        craftT = 2.5;
        if (!blocked()) checkCraftable();
      }
      if (dirty || global.ids().length !== achCount) evaluate();
      showNext();
      if ((flushT -= realDt) <= 0) {
        flushT = 5;
        prof.flush();
      }
    },
  });
  // Frequent stats are batched; don't lose the last few seconds on a reload.
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => prof.flush());

  registerSaveable<RunState>(game, 'progression', {
    order: 65,
    save: () => run,
    load: (j) => {
      run = { ...emptyRun(), ...j, v: 1 };
      applyDifficulty(game, run.difficulty);
    },
    missing: () => void (run = emptyRun()),
  });

  // ------------------------------------------------------------------ options + keys
  game.keys.register('journal', 'Survival journal', () => void openJournal(game, handle, active));
  registerOption({
    name: 'Discovery hints',
    value: () => (prof.data.options.hints ? 'on' : 'off'),
    change: () => {
      prof.setOption('hints', !prof.data.options.hints);
      if (!prof.data.options.hints) queue.clear();
    },
    desc: 'Short tips the first time you meet something new (zombies, hunger, night…), and "you could craft" when you have what a recipe needs.  Each shows once; they stay in the Survival Journal.',
  });
  registerOption({
    name: 'Classic mode (unlock everything)',
    value: () => (prof.data.options.classic ? 'on' : 'off'),
    change: () => prof.setOption('classic', !prof.data.options.classic),
    desc: 'For Cataclysm veterans: every start, scenario and the full character creator are available in New Game.  Turning it off restores your own unlock progress.',
  });

  const handle: ProgressionHandle = {
    profile: prof,
    catalogue,
    env,
    get run() {
      return run;
    },
    queue,
    badge,
    bump: (stat, n = 1) => void (active && prof.add(stat, n)),
    note: (set, value) => void (active && prof.note(set, value)),
    discover,
    newRun(o) {
      chosen = true;
      run = { ...emptyRun(), startId: o.startId, difficulty: o.difficulty, title: o.title };
      applyDifficulty(game, o.difficulty);
    },
    begin(loaded) {
      active = true;
      startZ = p.z;
      lastDist = game.stats.distanceWalked;
      lastHp = hpSnap();
      lastOmt = '';
      craftPrev = null;
      craftSig = '';
      // Let the first minute be about looking around: recipes wait 30 s.
      craftStartAt = now() + 30_000;
      if (!loaded) {
        prof.add('runs');
        // Automation's quick start (cdda.ui.quickStart) skips newRun: still apply the preset.
        if (!chosen) applyDifficulty(game, run.difficulty);
        setTimeout(() => discover('welcome'), 3000);
        clearUntil = now() + 3000;
      }
      evaluate();
    },
    evaluate,
    isAvailable: (u) => available(u, (id) => prof.isUnlocked(id), prof.data.options.classic),
    achName,
    takeTitleBanner: () => prof.takeUnseen().map((id) => catalogue.unlocks.find((u) => u.id === id)).filter((u): u is UnlockDef => !!u),
  };
  setProgression(game, handle);
  // Earned before this page loaded (e.g. an achievement from a previous life): record now so
  // the title can announce it.
  evaluate();

  if (api) {
    api.progression = {
      handle,
      profile: () => prof.data,
      stat: (id: Parameters<Profile['stat']>[0]) => prof.stat(id),
      bump: (stat: CounterStat, n = 1) => (prof.add(stat, n), evaluate().map((u) => u.id)),
      unlock: (id: string) => {
        if (!catalogue.unlocks.some((u) => u.id === id)) throw new Error(`unknown unlock ${id}`);
        prof.unlock(id, 'debug');
        prof.flush();
      },
      classic: (on: boolean) => prof.setOption('classic', on),
      hints: (on: boolean) => prof.setOption('hints', on),
      discover,
      queue: () => ({ queue: queue.queue.map((q) => q.id), cooldownMs: queue.cooldown(now()), blocked: blocked(), pendingRecipes: pendingRecipes.map((r) => r.id), badge: badge.count }),
      checkCraftable: () => ((craftStartAt = 0), (craftSig = ''), checkCraftable(), pendingRecipes.map((r) => r.id)),
      run: () => run,
      export: () => prof.export(),
      import: (json: string) => prof.import(json),
      reset: () => prof.import(JSON.stringify({ v: 1 })),
      text: (s: string) => withKeys(game, s),
    };
  }
  void ctx;
  return handle;
}
