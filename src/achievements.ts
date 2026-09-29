import type { Game } from './game/game';
import type { DebugApi } from './debug';
import type { WorldGenerator } from './world/worldgen';
import type { Item } from './game/item';
import { CHUNK } from './world/coords';
import { MAIN_PARTS } from './game/bodyparts';
import { bodyMods } from './game/bodymods';
import { swimState } from './game/water';
import { registerSaveable } from './save/registry';
import {
  AchievementTracker, globalAchievements, runAchievementNames, type AchievementDef, type AchievementsData, type EventData, type GlobalAchievements,
  type TrackerJSON, type WorldQueries,
} from './game/achievements';
import { installAchievementsUi } from './ui/achievements_ui';
import { DATA_BASE } from './core/assets';

// Wiring for scores & achievements (src/game/achievements.ts): loads public/data/
// achievements.json, feeds CDDA events from the running game, persists per-character
// statistics in the save and completed achievements globally (localStorage), and installs
// the `)` screen + unlock toasts. main.ts calls installAchievements() once, then begin()
// when gameplay starts.
//
// Event sources (CDDA event names/fields):
//   game_start / game_avatar_death           begin() / playerDied
//   character_kills_monster / _character     creatureDied with killer === player
//   character_takes_damage                   playerHurt
//   avatar_moves / avatar_enters_omt         per tile / per OMT the survivor steps into
//   character_melee/ranged_attacks_monster   wrapped PlayerCombat.melee / fire
//   character_consumes_item / _eats_item     Inventory.onConsume hook
//   everything else (wake up, skills, mutations, thresholds, CBMs, broken bones, healing,
//   books, wield/wear) is detected by polling the survivor twice a second, so the owning
//   systems need no changes.

export interface AchievementsHandle {
  data: AchievementsData;
  tracker: AchievementTracker;
  global: GlobalAchievements;
  /** Start tracking: a fresh character (emits BN game_start) or a loaded one. */
  begin(loaded: boolean): void;
  /** Achievements completed by this character, in order. */
  completedThisRun(): AchievementDef[];
}

const handles = new WeakMap<Game, AchievementsHandle>();
/** The achievements system of a game, if installed (death screen, memorial). */
export function achievementsOf(game: Game): AchievementsHandle | undefined {
  return handles.get(game);
}

export async function loadAchievementsData(base = DATA_BASE): Promise<AchievementsData> {
  const res = await fetch(base + 'achievements.json');
  if (!res.ok) throw new Error(`Failed to load ${base}achievements.json: HTTP ${res.status} (run \`npm run extract:achievements\`)`);
  return (await res.json()) as AchievementsData;
}

/** CDDA event_field_transformations backed by our data and world generator. */
export function worldQueries(game: Game, worldgen: WorldGenerator | null): WorldQueries {
  const ter = (id: string) => game.data.terrain[id];
  return {
    speciesOf: (id) => game.data.monsters[id]?.species ?? [],
    terrainFlags: (id) => ter(id)?.flags ?? [],
    isSwimmingTerrain: (id) => !!ter(id)?.flags?.includes('DEEP_WATER') && !!ter(id)?.flags?.includes('SWIMMABLE'),
    itemFlags: (id) => game.data.items[id]?.flags ?? [],
    oterTypeOf: (oid) => {
      if (!worldgen) return oid;
      // oter ids carry rotation/line suffixes; the event stores the type directly when known.
      return oid.replace(/_(north|east|south|west)$/, '');
    },
    specialAt: (pos) => {
      if (!worldgen) return '';
      const [x, y, z] = pos.split(',').map(Number);
      return worldgen.overmap.omtAt(x, y, z).special?.def ?? '';
    },
    skillLevel: (s) => game.player.getSkill(s),
    kills: () => game.stats.kills,
  };
}

export async function installAchievements(game: Game, worldgen: WorldGenerator | null, api?: DebugApi, data?: AchievementsData): Promise<AchievementsHandle> {
  const d = data ?? (await loadAchievementsData());
  const tracker = new AchievementTracker(d, worldQueries(game, worldgen));
  tracker.now = () => game.clock.seconds;
  const global = globalAchievements();
  const AV = 'avatar';
  let active = false;
  const emit = (type: string, fields: EventData) => {
    if (active) tracker.emit(type, fields);
  };

  // ------------------------------------------------------------------ pushed events
  game.events.on('creatureDied', (e) => {
    if (e.killer !== game.player) return;
    const cr = e.creature as { type?: { id?: string }; name?: string } | null;
    if (cr?.type?.id) emit('character_kills_monster', { killer: AV, victim_type: cr.type.id });
    else emit('character_kills_character', { killer: AV, victim: 'npc', victim_name: cr?.name ?? '' });
  });
  game.events.on('playerHurt', (e) => {
    if (e.amount > 0) emit('character_takes_damage', { character: AV, damage: Math.round(e.amount) });
  });
  game.events.on('playerDied', (e) => {
    emit('game_avatar_death', { avatar_id: AV, avatar_name: game.player.name, avatar_is_male: game.player.male, is_suicide: false, last_words: '', cause: e.cause });
    tracker.flush();
    active = false;
  });
  game.player.inv.onConsume.push((portion: Item) => {
    emit('character_consumes_item', { character: AV, itype: portion.typeId });
    if (portion.def?.comestible_type === 'FOOD') emit('character_eats_item', { character: AV, itype: portion.typeId });
  });
  // PlayerCombat lives in installMonsters; wrap its entry points rather than editing it.
  const combat = api?.combat as { melee?: (t?: unknown, ...rest: unknown[]) => boolean; fire?: () => boolean; meleeTarget?: () => { type: { id: string } } | null } | undefined;
  if (combat?.melee && combat.meleeTarget) {
    const melee = combat.melee.bind(combat), target = combat.meleeTarget.bind(combat);
    // Pass every argument through: the phased swing (combatfeel) calls melee(target, { phased }).
    combat.melee = (t?: unknown, ...rest: unknown[]) => {
      const m = (t as { type?: { id: string } } | null | undefined) ?? target();
      const r = melee(t, ...rest);
      if (r && m?.type?.id) emit('character_melee_attacks_monster', { attacker: AV, weapon: game.player.inv.wielded?.typeId ?? 'null', victim_type: m.type.id });
      return r;
    };
  }
  if (combat?.fire) {
    const fire = combat.fire.bind(combat);
    combat.fire = () => {
      const r = fire();
      if (r) emit('character_ranged_attacks_monster', { attacker: AV, weapon: game.player.inv.wielded?.typeId ?? 'null', victim_type: '' });
      return r;
    };
  }

  // ------------------------------------------------------------------ polled events
  interface Snapshot {
    tx: number; ty: number; z: number; omt: string;
    asleep: boolean;
    skills: Map<string, number>;
    traits: Set<string>;
    bionics: string[];
    books: Set<string>;
    wielded: string;
    worn: string[];
    hp: Map<string, number>;
  }
  let snap: Snapshot | null = null;
  const take = (): Snapshot => {
    const p = game.player;
    return {
      tx: p.tileX, ty: p.tileY, z: p.z, omt: `${Math.floor(p.tileX / CHUNK)},${Math.floor(p.tileY / CHUNK)},${p.z}`,
      asleep: p.isAsleep(),
      skills: new Map(Object.entries(p.skills).map(([k, v]) => [k, v.level])),
      traits: new Set(p.traits),
      bionics: (bodyMods(p)?.bio.bionics ?? []).map((b) => b.id),
      books: new Set(p.identifiedBooks),
      wielded: p.inv.wielded?.typeId ?? '',
      worn: p.inv.worn.map((w) => w.typeId),
      hp: new Map(MAIN_PARTS.map((bp) => [bp, p.hp[bp]?.cur ?? 0])),
    };
  };
  const enterOmt = (key: string) => {
    const [x, y, z] = key.split(',').map(Number);
    const o = worldgen?.overmap.omtAt(x, y, z);
    // oter_type_of_oter wants the type; we know it exactly, so store the id and let the
    // transformation map it (see worldQueries.oterTypeOf for the suffix rule).
    emit('avatar_enters_omt', { pos: key, oter_id: o ? o.type : 'field' });
  };

  const step = () => {
    const p = game.player;
    if (!snap || p.dead) return;
    const s = snap;
    // Movement: one avatar_moves per tile entered (CDDA emits per step, including stairs).
    if (p.tileX !== s.tx || p.tileY !== s.ty || p.z !== s.z) {
      const n = Math.max(Math.abs(p.tileX - s.tx), Math.abs(p.tileY - s.ty));
      // Teleports (debug, loading) aren't moves; stairs are (they may land a few tiles off).
      if (p.z !== s.z || n <= 2) {
        const sw = swimState(game);
        const mode = p.running && p.canRun() ? 'run' : p.crouching ? 'crouch' : 'walk';
        const terrain = game.map.terAt(p.tileX, p.tileY, p.z).id;
        const count = p.z !== s.z ? 1 : Math.max(1, n);
        tracker.emit('avatar_moves', { mount: '', terrain, movement_mode: mode, underwater: !!sw.underwater, z: p.z }, count);
      }
      s.tx = p.tileX;
      s.ty = p.tileY;
      s.z = p.z;
      const key = `${Math.floor(p.tileX / CHUNK)},${Math.floor(p.tileY / CHUNK)},${p.z}`;
      if (key !== s.omt) {
        s.omt = key;
        enterOmt(key);
      }
    }
  };

  let pollT = 0;
  const poll = () => {
    const p = game.player;
    if (!snap || p.dead) return;
    const s = snap;
    const asleep = p.isAsleep();
    if (s.asleep && !asleep) emit('character_wakes_up', { character: AV });
    s.asleep = asleep;
    for (const [k, v] of Object.entries(p.skills)) {
      const old = s.skills.get(k) ?? 0;
      for (let l = old + 1; l <= v.level; l++) emit('gains_skill_level', { character: AV, skill: k, new_level: l });
      s.skills.set(k, v.level);
    }
    const misc = game.data.misc ?? {};
    for (const t of p.traits) {
      if (s.traits.has(t)) continue;
      emit('gains_mutation', { character: AV, trait: t });
      if ((misc.mutation?.[t] as { threshold?: boolean } | undefined)?.threshold) {
        // BN threshold_muts (tiers) or the single threshold_mut. Mycus is its own event.
        if (t === 'THRESH_MYCUS') emit('crosses_mycus_threshold', { character: AV });
        for (const c of Object.values((misc.mutation_category ?? {}) as Record<string, { id: string; threshold_mut?: string; threshold_muts?: string[] }>))
          if (c.threshold_mut === t || c.threshold_muts?.includes(t)) emit('crosses_mutation_threshold', { character: AV, category: c.id });
      }
    }
    s.traits = new Set(p.traits);
    const bio = bodyMods(p)?.bio;
    if (bio) {
      const now = bio.bionics.map((b) => b.id);
      const left = [...s.bionics];
      for (const id of now) {
        const i = left.indexOf(id);
        if (i >= 0) {
          left.splice(i, 1);
          continue;
        }
        const faulty = bio.idx.faulty.includes(id);
        emit(faulty ? 'installs_faulty_cbm' : 'installs_cbm', { character: AV, bionic: id });
      }
      s.bionics = now;
    }
    for (const b of p.identifiedBooks) if (!s.books.has(b)) emit('reads_book', { character: AV, itype: b });
    s.books = new Set(p.identifiedBooks);
    const w = p.inv.wielded?.typeId ?? '';
    if (w && w !== s.wielded) emit('character_wields_item', { character: AV, itype: w });
    s.wielded = w;
    const worn = p.inv.worn.map((it) => it.typeId);
    const was = [...s.worn];
    for (const id of worn) {
      const i = was.indexOf(id);
      if (i >= 0) was.splice(i, 1);
      else emit('character_wears_item', { character: AV, itype: id });
    }
    s.worn = worn;
    let healed = 0;
    for (const bp of MAIN_PARTS) {
      const cur = p.hp[bp]?.cur ?? 0, old = s.hp.get(bp) ?? cur;
      if (cur > old) healed += cur - old;
      // CDDA broken_bone: a limb's HP reaching zero breaks it.
      if (cur <= 0 && old > 0 && bp !== 'head' && bp !== 'torso') emit('broken_bone', { character: AV, part: bp });
      s.hp.set(bp, cur);
    }
    if (healed > 0) emit('character_heals_damage', { character: AV, damage: healed });
  };

  game.systems.push({
    name: 'achievements',
    update(_g, realDt) {
      if (!active) return;
      step();
      if ((pollT -= realDt) <= 0) {
        pollT = 0.5;
        poll();
      }
      tracker.flush();
    },
  });

  // ------------------------------------------------------------------ completion hooks
  const ui = installAchievementsUi(game, () => handle);
  tracker.onCompleted = (a) => {
    global.add(a.id, game.player.name || 'Unnamed');
    game.message(`You completed the achievement "${a.name}".`, 'c_light_green');
    ui.toast(a);
  };
  tracker.onFailed = (a) => {
    if (a.conduct) game.message(`You lost the conduct "${a.name}".`, 'c_light_red');
  };

  registerSaveable<TrackerJSON>(game, 'achievements', {
    order: 60,
    save: () => tracker.toJSON(),
    load: (j, ctx) => tracker.load(j, (m) => ctx.warn(m)),
    missing: () => tracker.reset(),
  });

  const handle: AchievementsHandle = {
    data: d,
    tracker,
    global,
    begin(loaded) {
      if (!loaded) {
        tracker.reset();
        tracker.gameStart = game.clock.seconds;
      }
      active = true;
      snap = take();
      // Old saves (and fresh characters) need the avatar id every "avatar_*" statistic keys on.
      if (tracker.value('avatar_id') === '') {
        tracker.emit('game_start', { avatar_id: AV });
        enterOmt(snap.omt);
      }
      tracker.flush();
    },
    completedThisRun() {
      return [...tracker.status].filter(([, s]) => s.completion === 'completed').sort((a, b) => a[1].time - b[1].time).map(([id]) => d.achievements[id]);
    },
  };
  handles.set(game, handle);
  runAchievementNames.set(game, () => handle.completedThisRun().map((a) => a.name));
  // A save loaded into the running game: positions/skills jumped, that isn't progress.
  game.events.on('gameLoaded', () => {
    if (active) snap = take();
  });

  if (api) {
    /** Every achievement with status, visibility and requirement progress. */
    api.achievements = (filter?: string) =>
      Object.values(d.achievements)
        .filter((a) => !filter || a.id.includes(filter) || a.name.toLowerCase().includes(filter.toLowerCase()))
        .map((a) => ({
          id: a.id,
          name: a.name,
          status: tracker.completion(a.id),
          hidden: tracker.isHidden(a),
          supported: tracker.achievementSupported(a),
          everCompleted: global.has(a.id),
          progress: tracker.requirementLines(a).map((l) => (l ? `${l.done ? '[x]' : '[ ]'} ${l.text}` : '(hidden)')),
        }));
    /** Complete an achievement now (CDDA debug menu / manually_given). */
    api.unlockAchievement = (id: string) => {
      if (!d.achievements[id]) throw new Error(`unknown achievement ${id}`);
      return tracker.giveManually(id);
    };
    api.achievementStat = (id: string) => tracker.value(id);
    api.achievementEvent = (type: string, fields: EventData) => {
      tracker.emit(type, fields);
      tracker.flush();
    };
    api.openAchievements = () => ui.open();
  }
  return handle;
}
