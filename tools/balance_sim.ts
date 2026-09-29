// Headless balance simulation for the difficulty presets (docs/BALANCE.md).
//
//   tsx tools/balance_sim.ts --preset accessible --seeds 20            # all scenarios
//   tsx tools/balance_sim.ts --preset classic --seeds 20 --out runs/classic.jsonl
//   tsx tools/balance_sim.ts --from runs/classic.jsonl                 # re-print tables only
//   tsx tools/balance_sim.ts --scenario needs --preset accessible      # just the needs timeline
//
// Two separable steps (so changing the analysis doesn't mean re-simulating): `run` writes one
// JSON record per simulated seed/scenario (JSON lines), `--from` summarises records. It only
// reads game data; nothing is written except --out.
//
// Scenarios:
//   day1   the real world at the evac shelter (worldgen + spawner + monster AI + weather at
//          real time, 30 ticks/s) with a scripted "reasonable newcomer": walk to the nearest
//          house with loot, loot it, fight single zombies it meets, run from two or more or when
//          hurt, return to the shelter at night and sleep. Measures contact times, zombies near
//          the start, crowding, damage and deaths.
//   needs  hunger/thirst/fatigue milestones over 3 days for a survivor who never eats or
//          drinks (sleeps 23:00–07:00), in game time and in real minutes of play.
//   cold   the first night spent in the shelter with the starting kit (and a blanket from the
//          shelter's lockers when there is one): lowest body temperature and cold wake-ups.

import { parseArgs } from 'node:util';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { loadNodeData } from './lib/node_data';
import { Game, TICK } from '../src/game/game';
import type { Input } from '../src/core/input';
import { WorldGenerator } from '../src/world/worldgen';
import { CHUNK } from '../src/world/coords';
import { installMonsters } from '../src/monsters';
import { installSound } from '../src/game/sound';
import { installWeather } from '../src/game/weather';
import { installFields } from '../src/game/fields';
import { installZLevels } from '../src/game/zlevels';
import { installRest, goToSleep } from '../src/game/rest';
import { openDoor } from '../src/game/interact';
import { findPath } from '../src/game/pathfind';
import { applyDifficultySettings, DIFFICULTY_PRESETS, formatKnob, KNOBS, registerDifficultyTargets, settingsFor, type DifficultySettings, type PresetId } from '../src/game/difficulty';
import { Character, BODYTEMP, SLEEPINESS, THIRST } from '../src/game/character';
import { MAIN_PARTS } from '../src/game/bodyparts';
import { SECONDS_PER_HOUR } from '../src/core/time';
import { applyBuild, defaultBuild } from '../src/ui/chargen';
import type { UiContext } from '../src/ui/context';
import { createItem, type Item } from '../src/game/item';
import type { Monster } from '../src/game/monster';

const HELP = `balance_sim: headless difficulty-preset simulation (see docs/BALANCE.md)

  --preset accessible|classic   preset to simulate (default accessible)
  --seeds N                     world seeds (default 20), starting at --seed0 (default 1)
  --scenario all|day1|duel|needs|cold (default all)
  --hours H                     day1 length in game hours from 08:00 (default 24)
  --set key=value[,key=value]   override preset knobs (e.g. --set spawnScale=0.5,safeRadius=16)
  --out FILE                    append JSON-lines records here
  --from FILE[,FILE]            only summarise existing records (no simulation)
  --presets                     print the preset table (markdown) and exit
  --quiet                       no per-seed progress lines
  --trace                       day1: print the bot's state every real second and the game log
  -h, --help`;

const { values: args } = parseArgs({
  options: {
    preset: { type: 'string', default: 'accessible' },
    seeds: { type: 'string', default: '20' },
    seed0: { type: 'string', default: '1' },
    scenario: { type: 'string', default: 'all' },
    hours: { type: 'string', default: '24' },
    set: { type: 'string' },
    out: { type: 'string' },
    from: { type: 'string' },
    quiet: { type: 'boolean', default: false },
    trace: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    presets: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(HELP);
  process.exit(0);
}

type Rec = Record<string, unknown> & { scenario: string; preset: string; seed: number };

// ------------------------------------------------------------------ setup

const preset = args.preset as PresetId;
if (preset !== 'accessible' && preset !== 'classic') throw new Error(`--preset must be accessible or classic, got ${preset}`);
function presetSettings(): DifficultySettings {
  const s = settingsFor(preset);
  for (const kv of (args.set ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split('=');
    if (!(k in s)) throw new Error(`--set: unknown knob ${k}`);
    const cur = s[k as keyof DifficultySettings];
    (s as unknown as Record<string, unknown>)[k] = typeof cur === 'number' ? Number(v) : typeof cur === 'boolean' ? v === 'true' : v;
  }
  return s;
}
const label = preset + (args.set ? `[${args.set}]` : '');

function fakeInput(): Input {
  return {
    held: new Set<string>(), captured: false, captureTimeFlows: false, mouseButtons: 0, onPress() {}, onPriorityPress() {},
    capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [],
  } as unknown as Input;
}

let DATA: ReturnType<typeof loadNodeData> | null = null;
const data = () => (DATA ??= loadNodeData());
const uiNames = () => JSON.parse(readFileSync('public/data/ui.json', 'utf8')).names;

interface World {
  game: Game;
  gen: WorldGenerator;
  mons: ReturnType<typeof installMonsters>;
  start: { x: number; y: number; z: number };
}

/** A world like main.ts builds it (minus the renderer): shelter start, spawns held until the preset is in force. */
function makeWorld(seed: number): World {
  const { game: gd, wg } = data();
  const game = new Game(gd, seed, fakeInput());
  if (args.trace) game.events.on('message', (m) => console.error(`  | ${m.text}`));
  const mons = installMonsters(game, null, null as never);
  // installMonsters(null renderer) spawns immediately; hold like the browser does behind the title screen.
  mons.spawner.hold();
  const gen = new WorldGenerator(seed, wg, gd);
  gen.stats.quiet = true;
  game.map.generator = gen;
  (mons.spawner as unknown as { overmap: unknown }).overmap = {
    omtType: (x: number, y: number, z: number) => gen.overmap.omtAt(x, y, z).type,
    mondensity: (x: number, y: number) => gen.wg.overmap.terrains[gen.overmap.omtAt(x, y, 0).type]?.mondensity ?? 0,
    citiesNear: (x: number, y: number) => gen.overmap.citiesNear(x, y),
  };
  const st = gen.findStartLocation('shelter', game.map);
  game.player.x = st.x + 0.5;
  game.player.y = st.y + 0.5;
  game.player.z = 0;
  installSound(game);
  installWeather(game, {});
  installFields(game);
  installZLevels(game);
  installRest(game);
  registerDifficultyTargets(game, { spawner: mons.spawner });
  applyDifficultySettings(game, preset, presetSettings());
  const ctx = { game, data: { names: uiNames() } } as unknown as UiContext;
  const b = defaultBuild(ctx);
  b.density = undefined;
  applyBuild(ctx, b);
  if (args.trace) console.error(`kit: wielding ${game.player.inv.wielded?.typeId ?? 'nothing'}; worn ${game.player.inv.worn.map((i) => i.typeId).join(' ')}; carried ${game.player.inv.carried().map((i) => i.typeId).join(' ')}`);
  mons.spawner.release();
  streamChunks(game);
  return { game, gen, mons, start: { x: st.x, y: st.y, z: 0 } };
}

/** What the browser keeps generated around the survivor (renderer radius 4 + prefetch ring). */
function streamChunks(game: Game): void {
  const p = game.player;
  const cx = Math.floor(p.x / CHUNK), cy = Math.floor(p.y / CHUNK);
  for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= 30) game.map.chunk(cx + dx, cy + dy, 0);
  for (const z of [-1, 1]) for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) game.map.chunk(cx + dx, cy + dy, z);
}

const hostile = (m: Monster) => !m.dead && m.attitude() === 'attack' && m.type.aggression > 0;

// ------------------------------------------------------------------ day 1 with a scripted newcomer

interface Day1 {
  zombies40: number;
  dormant40: number;
  hostiles120: number;
  firstSightS: number | null;
  firstContactS: number | null;
  maxNear6: number;
  timeCrowdedS: number;
  died: boolean;
  deathCause: string | null;
  deathHour: number | null;
  kills: number;
  minHpPct: number;
  hpLost: number;
  lootedTiles: number;
  fled: number;
  slept: boolean;
  minBodyTemp: number;
  realMinutes: number;
  weapon?: string | null;
}

function day1(seed: number): Day1 {
  const w = makeWorld(seed);
  const { game, mons } = w;
  const p = game.player;
  const sys = mons.sys;
  const within = (r: number) => sys.all.filter((m) => hostile(m) && m.z === 0 && Math.hypot(m.x - p.x, m.y - p.y) <= r).length;
  const dormantWithin = (r: number) => sys.corpses.filter((c) => c.dormant && c.z === 0 && Math.hypot(c.x - p.x, c.y - p.y) <= r).length;
  const res: Day1 = {
    zombies40: within(40), dormant40: dormantWithin(40), hostiles120: within(120), firstSightS: null, firstContactS: null, maxNear6: 0, timeCrowdedS: 0,
    died: false, deathCause: null, deathHour: null, kills: 0, minHpPct: 1, hpLost: 0, lootedTiles: 0, fled: 0, slept: false, minBodyTemp: BODYTEMP.NORM, realMinutes: 0,
  };
  game.events.on('playerDied', (e) => {
    res.died = true;
    res.deathCause = e.cause;
    res.deathHour = game.clock.seconds / SECONDS_PER_HOUR;
  });
  game.events.on('creatureDied', (e) => void ((e as { killer?: unknown }).killer === p && res.kills++));
  const hpMax = () => MAIN_PARTS.reduce((s, bp) => s + p.hp[bp].max, 0);
  const hpNow = () => MAIN_PARTS.reduce((s, bp) => s + Math.max(0, p.hp[bp].cur), 0);
  let lastHp = hpNow();

  const bot = new Newcomer(w);
  const endAt = 8 * SECONDS_PER_HOUR + Number(args.hours) * SECONDS_PER_HOUR;
  let real = 0, streamT = 0;
  // Hard stop on real time too (a stuck bot must not spin forever): 3 real hours.
  while (game.clock.seconds < endAt && !p.dead && real < 3 * 3600) {
    bot.think(TICK);
    game.tick(TICK);
    real += TICK;
    if ((streamT -= TICK) <= 0) {
      streamT = 1;
      streamChunks(game);
    }
    if (args.trace && Math.round(real * 30) % 30 === 0) {
      const ms = sys.active.filter((m) => hostile(m) && m.z === p.z && sys.distToPlayer(m) <= 15).map((m) => `${m.id.replace('mon_', '')}@${sys.distToPlayer(m).toFixed(1)}`);
      console.error(`t=${real.toFixed(0)}s ${game.clock.format()} ${bot.state()} pos ${p.x.toFixed(1)},${p.y.toFixed(1)} hp t${p.hp.torso.cur}/h${p.hp.head.cur} stam ${Math.round(p.stamina)} run ${p.running ? 1 : 0} v ${p.moveSpeed(100).toFixed(1)} near [${ms.join(' ')}]`);
    }
    const hp = hpNow();
    if (hp < lastHp) res.hpLost += lastHp - hp;
    lastHp = hp;
    res.minHpPct = Math.min(res.minHpPct, Math.min(p.hp.torso.cur / p.hp.torso.max, p.hp.head.cur / p.hp.head.max));
    for (const bp of MAIN_PARTS) res.minBodyTemp = Math.min(res.minBodyTemp, p.bodyTemp[bp]);
    // sighting/contact/crowding checks at 10 Hz are plenty
    if (Math.round(real * 30) % 3 === 0) {
      if (res.firstSightS === null && sys.visibleHostiles(40).length) res.firstSightS = real;
      const n3 = sys.active.filter((m) => hostile(m) && m.z === p.z && sys.distToPlayer(m) <= 3).length;
      if (res.firstContactS === null && n3) res.firstContactS = real;
      const n6 = sys.active.filter((m) => hostile(m) && m.z === p.z && sys.distToPlayer(m) <= 6).length;
      res.maxNear6 = Math.max(res.maxNear6, n6);
      if (n6 >= 3) res.timeCrowdedS += 0.1;
    }
  }
  res.lootedTiles = bot.looted.size;
  res.weapon = bot.weapon;
  res.fled = bot.fledCount;
  res.slept = bot.slept;
  res.realMinutes = real / 60;
  return res;
}

/**
 * The scripted newcomer. Real-time control through the same inputs a player has: held WASD +
 * yaw, LMB swings (combat.beginSwing), Shift to run, `e` on doors, sleeping via rest.ts.
 * Deliberately not optimal: no guard/parry, no side-steps, fights anything alone that comes at it.
 */
class Newcomer {
  looted = new Set<string>();
  weapon: string | null = null;
  fledCount = 0;
  slept = false;
  private mode: 'explore' | 'loot' | 'fight' | 'flee' | 'home' | 'sleep' = 'explore';
  private path: [number, number][] = [];
  private pathGoal: string | null = null;
  private repathT = 0;
  private lootT = 0;
  private target: [number, number] | null = null;
  private cornered = 0;
  private fleeT = 0;
  private fleeGoal: [number, number] | null = null;
  private badTargets = new Set<string>();

  constructor(private w: World) {}

  state(): string {
    return `${this.mode}${this.target ? ` -> ${this.target.join(',')}` : ''}`;
  }

  think(dt: number): void {
    const { game, mons } = this.w;
    const p = game.player;
    const held = game.input.held;
    held.clear();
    if (p.dead) return;
    if (game.activities.current || p.isAsleep()) return;
    const sys = mons.sys;
    const hour = game.clock.hourOfDay;
    const near = sys.active.filter((m) => hostile(m) && m.z === p.z && sys.distToPlayer(m) <= 10);
    const hurt = p.hp.torso.cur / p.hp.torso.max < 0.6 || p.hp.head.cur / p.hp.head.max < 0.6;
    const night = hour >= 21 || hour < 6;
    // --- decide
    // With hysteresis, so it doesn't flip between running and looting at a threshold: run from
    // two or more (or anything while hurt) until nothing is within 14 m; fight a lone one; fight
    // back when cornered or when the thing chasing is faster than a run.
    this.cornered = Math.max(0, this.cornered - dt);
    const close = near.filter((m) => sys.distToPlayer(m) <= 6);
    const mid = sys.active.filter((m) => hostile(m) && m.z === p.z && sys.distToPlayer(m) <= 14);
    const outrun = (m: Monster) => m.moveSpeed(100) < p.moveSpeed(100) * (p.canRun() ? 2 : 1) * 0.9;
    if (this.cornered > 0 && close.length) this.mode = 'fight';
    else if (close.length >= 2 || (hurt && close.length) || (this.mode === 'flee' && mid.length)) {
      if (close.length && close.every((m) => !outrun(m)) && close.length === 1) this.mode = 'fight';
      else {
        if (this.mode !== 'flee') this.fledCount++;
        this.mode = 'flee';
      }
    } else if (close.length === 1) this.mode = 'fight';
    else if (this.mode === 'fight' || this.mode === 'flee') this.mode = night ? 'home' : 'explore';
    // Night, or hurt: go home and rest (sleep heals), like a player with a scare.
    if ((night || hurt) && (this.mode === 'explore' || this.mode === 'loot')) this.mode = 'home';

    this.drinkEat();
    switch (this.mode) {
      case 'flee': {
        // Away from the pack along a real path (not into a wall), leaning toward the shelter.
        // Run while they're close, walk (saving stamina) once there is a gap.
        const pack = mid.length ? mid : near;
        const cx = pack.reduce((s, m) => s + m.x, 0) / pack.length, cy = pack.reduce((s, m) => s + m.y, 0) / pack.length;
        if ((this.fleeT -= dt) <= 0 || !this.fleeGoal) {
          this.fleeT = 2;
          let best: [number, number] | null = null, bs = -Infinity;
          for (let a = 0; a < 16; a++) {
            const ang = (a / 16) * Math.PI * 2;
            const gx = Math.floor(p.x + Math.cos(ang) * 16), gy = Math.floor(p.y + Math.sin(ang) * 16);
            if (!game.map.passable(gx, gy, p.z)) continue;
            const away = Math.hypot(gx - cx, gy - cy) - Math.hypot(p.x - cx, p.y - cy);
            const home = -Math.hypot(gx - this.w.start.x, gy - this.w.start.y) * 0.25;
            if (away + home > bs) (bs = away + home), (best = [gx, gy]);
          }
          this.fleeGoal = best;
        }
        const nearest = Math.min(...pack.map((m) => sys.distToPlayer(m)));
        if (this.fleeGoal) this.walkTo(this.fleeGoal[0], this.fleeGoal[1], dt);
        if (nearest < 8) held.add('ShiftLeft');
        // Cornered (a wall, a grab): turn and fight for a few seconds instead of running in place.
        if (this.stuck(dt, 'flee') && nearest < 3) this.cornered = 3;
        return;
      }
      case 'fight': {
        const m = near.slice().sort((a, b) => sys.distToPlayer(a) - sys.distToPlayer(b))[0];
        this.face(m.x, m.y);
        const d = sys.distToPlayer(m) - m.radius;
        if (d > 0.9) held.add('KeyW');
        else if (d < 0.35) held.add('KeyS');
        if (d <= 1.15 && mons.combat.cooldown <= 0 && !mons.combat.swing) mons.combat.beginSwing();
        return;
      }
      case 'home': {
        const s = this.w.start;
        if (Math.hypot(p.x - s.x - 0.5, p.y - s.y - 0.5) < 1.5 || p.hasEffect('lying_down')) {
          if (hurt || p.sleepiness > SLEEPINESS.TIRED * 0.5 || hour >= 22 || hour < 6) {
            if (goToSleep(game)) this.slept = true;
          }
          return;
        }
        this.walkTo(s.x, s.y, dt);
        return;
      }
      case 'loot': {
        if ((this.lootT -= dt) <= 0) {
          this.takeLoot();
          this.mode = 'explore';
          this.target = null;
        }
        return;
      }
      case 'explore': {
        if (!this.target) this.target = this.pickLootTarget();
        if (!this.target) {
          // Nothing lootable in reach: head for the nearest houses on the map (a new player
          // follows the road into town), else wander back home and wait for the evening.
          const town = this.townGoal();
          if (town && Math.hypot(town[0] - p.x, town[1] - p.y) > 20) this.stepToward(town[0], town[1], dt);
          else this.walkTo(this.w.start.x, this.w.start.y, dt);
          return;
        }
        const [tx, ty] = this.target;
        if (Math.hypot(p.x - tx - 0.5, p.y - ty - 0.5) < 1.3) {
          this.mode = 'loot';
          this.lootT = 5;
          return;
        }
        if (!this.walkTo(tx, ty, dt)) {
          this.badTargets.add(`${tx},${ty}`);
          this.target = null;
        }
        return;
      }
      default:
        return;
    }
  }

  private face(x: number, y: number): void {
    const p = this.w.game.player;
    p.yaw = Math.atan2(x - p.x, -(y - p.y));
  }

  /** Moved less than 0.4 m over the last second (one watch per caller). */
  private watches = new Map<string, { t: number; x: number; y: number }>();
  private stuck(dt: number, who = 'walk'): boolean {
    const p = this.w.game.player;
    let w = this.watches.get(who);
    if (!w) this.watches.set(who, (w = { t: 0, x: p.x, y: p.y }));
    w.t += dt;
    if (w.t < 1) return false;
    const moved = Math.hypot(p.x - w.x, p.y - w.y);
    [w.t, w.x, w.y] = [0, p.x, p.y];
    return moved < 0.4;
  }

  /** Follow a door-aware A* path; opens closed doors on the way. False when unreachable. */
  private walkTo(tx: number, ty: number, dt: number): boolean {
    const { game, mons } = this.w;
    const p = game.player;
    const goal = `${tx},${ty}`;
    if (this.pathGoal !== goal || (this.repathT -= dt) <= 0 || !this.path.length) {
      const r = findPath(mons.sys.grid, p.tileX, p.tileY, tx, ty, p.z, { doors: true, maxNodes: 20000, margin: 20 });
      this.path = r.tiles.slice();
      this.pathGoal = goal;
      this.repathT = 2;
      if (!r.complete && Math.hypot(p.tileX - tx, p.tileY - ty) > 1.5) return false;
    }
    while (this.path.length && Math.hypot(this.path[0][0] + 0.5 - p.x, this.path[0][1] + 0.5 - p.y) < 0.45) this.path.shift();
    const next = this.path[0];
    if (!next) return true;
    const t = game.map.terAt(next[0], next[1], p.z);
    if (game.map.moveCost(next[0], next[1], p.z) <= 0 && t.open) {
      if (openDoor(game, next[0], next[1], p.z)) {
        this.path = [];
        return false;
      }
    }
    this.face(next[0] + 0.5, next[1] + 0.5);
    game.input.held.add('KeyW');
    if (this.stuck(dt)) {
      this.path = [];
      this.badTargets.add(goal);
      return false;
    }
    return true;
  }

  private town: [number, number] | null | undefined;
  /** Centre of the nearest OMT with houses or shops within 12 OMTs (overmap knowledge: the map screen). */
  private townGoal(): [number, number] | null {
    if (this.town !== undefined) return this.town;
    const om = this.w.gen.overmap;
    const sx = Math.floor(this.w.start.x / CHUNK), sy = Math.floor(this.w.start.y / CHUNK);
    let best: [number, number] | null = null, bd = Infinity;
    for (let dy = -12; dy <= 12; dy++)
      for (let dx = -12; dx <= 12; dx++) {
        const t = om.omtAt(sx + dx, sy + dy, 0).type;
        if (!/^(house|bungalow|urban|s_|apartment|cs_|church|school|shelter)/.test(t) || (dx === 0 && dy === 0) || /^shelter/.test(t)) continue;
        const d = Math.hypot(dx, dy);
        if (d < bd) (bd = d), (best = [(sx + dx) * CHUNK + 12, (sy + dy) * CHUNK + 12]);
      }
    return (this.town = best);
  }

  /** Long trips: A* to a passable tile up to 40 tiles along the way (the grid only knows generated chunks). */
  private stepToward(gx: number, gy: number, dt: number): void {
    const { game } = this.w;
    const p = game.player;
    const d = Math.hypot(gx - p.x, gy - p.y);
    const k = Math.min(1, 40 / d);
    let wx = Math.floor(p.x + (gx - p.x) * k), wy = Math.floor(p.y + (gy - p.y) * k);
    for (let r = 0; r < 6 && !game.map.passable(wx, wy, p.z); r++) (wx += r % 2 ? r : -r), (wy += r % 2 ? -r : r);
    if (!this.walkTo(wx, wy, dt)) {
      // Blocked this way: sidestep the obstacle and try again next time.
      this.face(p.x + (gy - p.y), p.y - (gx - p.x));
      game.input.held.add('KeyW');
    }
  }

  private pickLootTarget(): [number, number] | null {
    const { game } = this.w;
    const p = game.player;
    let best: [number, number] | null = null, bd = Infinity;
    for (const c of game.map.loadedChunks()) {
      if (c.z !== 0) continue;
      for (const [k, items] of c.items) {
        if (!items.length) continue;
        const x = c.cx * CHUNK + (k % CHUNK), y = c.cy * CHUNK + Math.floor(k / CHUNK);
        const key = `${x},${y}`;
        if (this.looted.has(key) || this.badTargets.has(key)) continue;
        // Houses, not the shelter's own lockers or loose litter outside.
        const ds = Math.hypot(x - this.w.start.x, y - this.w.start.y);
        if (ds < 14 || Math.hypot(x - p.x, y - p.y) > 60) continue;
        if (!game.map.hasFloor(x, y, 1) && !/floor|carpet|linoleum/.test(game.map.terAt(x, y, 0).id)) continue;
        const d = Math.hypot(x - p.x, y - p.y);
        if (d < bd) (bd = d), (best = [x, y]);
      }
    }
    return best;
  }

  private takeLoot(): void {
    const { game } = this.w;
    const p = game.player;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const x = p.tileX + dx, y = p.tileY + dy;
        this.looted.add(`${x},${y}`);
        for (const it of [...(game.map.itemsAt(x, y, p.z) as unknown as Item[])]) {
          // Something to hit with beats bare hands (a newcomer grabs the pipe, not the best weapon).
          const dmg = it.meleeDamage('bash') + it.meleeDamage('cut') + it.meleeDamage('stab');
          const cur = p.inv.wielded ? p.inv.wielded.meleeDamage('bash') + p.inv.wielded.meleeDamage('cut') + p.inv.wielded.meleeDamage('stab') : 0;
          if (!it.isGun() && dmg >= 8 && dmg > cur + 2 && it.weight() < 4000 && p.inv.canWield(it).ok) {
            game.map.removeItem(x, y, p.z, it as never);
            if (p.inv.wielded) game.map.addItem(x, y, p.z, p.inv.wielded as never);
            p.inv.wielded = it;
            this.weapon = it.typeId;
            continue;
          }
          if (!it.isComestible() && !it.isArmor()) continue;
          if (p.inv.pickUp(it).ok) game.map.removeItem(x, y, p.z, it as never);
        }
      }
  }

  private drinkEat(): void {
    const p = this.w.game.player;
    if (p.thirst < THIRST.THIRSTY && p.hungerState() === 'Sated') return;
    for (const it of p.inv.allItems()) {
      if (!it.isComestible()) continue;
      const r = p.inv.consume(it);
      if (r.ok) return;
    }
  }
}

// ------------------------------------------------------------------ duels on open ground

/**
 * The newcomer's melee against 1 or 2 zombies on flat ground: walk in, swing whenever the
 * weapon is ready, never guard or side-step. Real-time loop (telegraphs, hit-stop, swing
 * phases) exactly as in play.
 */
function duel(seed: number, weapon: string, foes: number): Record<string, number | string | boolean> {
  const { game: gd } = data();
  const game = new Game(gd, seed, fakeInput());
  const floor = 't_dirt';
  game.map.generator = {
    generate(map, c) {
      c.ter.fill(map.terrain.index(c.z === 0 ? floor : c.z > 0 ? 't_open_air' : 't_rock'));
      c.empty = false;
    },
  };
  const mons = installMonsters(game, null, null as never);
  registerDifficultyTargets(game, { spawner: mons.spawner });
  applyDifficultySettings(game, preset, presetSettings());
  const p = game.player;
  p.x = 30.5;
  p.y = 30.5;
  p.z = 0;
  p.onMessage = null;
  const ctx = { game, data: { names: uiNames() } } as unknown as UiContext;
  const b = defaultBuild(ctx);
  b.density = undefined;
  applyBuild(ctx, b);
  if (weapon !== 'fists') p.inv.wielded = createItem(gd, weapon);
  const ms: Monster[] = [];
  for (let i = 0; i < foes; i++) ms.push(mons.sys.spawn(gd.monsters.mon_zombie, 34.5, 29.5 + 2 * i, 0));
  const hp0 = MAIN_PARTS.reduce((a, bp) => a + p.hp[bp].cur, 0);
  let t = 0, swings = 0;
  while (t < 180 && !p.dead && ms.some((m) => !m.dead)) {
    const m = ms.filter((x) => !x.dead).sort((a, c) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(c.x - p.x, c.y - p.y))[0];
    game.input.held.clear();
    p.yaw = Math.atan2(m.x - p.x, -(m.y - p.y));
    const d = Math.hypot(m.x - p.x, m.y - p.y) - m.radius;
    if (d > 0.9) game.input.held.add('KeyW');
    if (d <= 1.15 && mons.combat.cooldown <= 0 && !mons.combat.swing) {
      mons.combat.beginSwing();
      swings++;
    }
    game.tick(TICK);
    t += TICK;
  }
  const hp1 = MAIN_PARTS.reduce((a, bp) => a + Math.max(0, p.hp[bp].cur), 0);
  return { weapon, foes, won: !p.dead && ms.every((m) => m.dead), died: p.dead, seconds: +t.toFixed(1), swings, swingsPerSec: +(swings / t).toFixed(2), hpLost: hp0 - hp1, torsoLeft: p.hp.torso.cur };
}

// ------------------------------------------------------------------ needs over 3 days

interface Milestone { what: string; gameHour: number; realMin: number }

function needs(): { milestones: Milestone[]; atEnd: Record<string, number | string> } {
  const { game: gd } = data();
  const c = new Character(gd, { seed: 1 });
  const s = presetSettings();
  c.balance = { hunger: s.hunger, thirst: s.thirst, fatigue: s.fatigue, healing: s.healing, bleed: s.bleed, cold: s.cold, damage: s.damageTaken };
  c.thirst = 0;
  c.sleepiness = 0;
  const out: Milestone[] = [];
  const seen = new Set<string>();
  let game = 8 * SECONDS_PER_HOUR;
  let real = 0;
  const scale = 24 / s.dayLength;
  const mark = (what: string, cond: boolean) => {
    if (cond && !seen.has(what)) {
      seen.add(what);
      out.push({ what, gameHour: +(game / SECONDS_PER_HOUR).toFixed(1), realMin: +(real / 60).toFixed(1) });
    }
  };
  // 23:00–07:00 asleep (warped: 2 real s per game hour, like rest.ts); otherwise the clock runs at CLOCK_SCALE / dayLength.
  const END = 8 * SECONDS_PER_HOUR + 3 * 86400;
  while (game < END && !c.dead) {
    const h = (game / SECONDS_PER_HOUR) % 24;
    const asleepWindow = h >= 23 || h < 7;
    if (asleepWindow && !c.isAsleep()) c.fallAsleep(8 * 3600);
    const dt = 60;
    c.update(dt);
    game += dt;
    real += asleepWindow ? (dt / SECONDS_PER_HOUR) * 2 : dt / scale;
    mark('Thirsty', c.thirst > THIRST.THIRSTY);
    mark('Very thirsty', c.thirst > THIRST.VERY_THIRSTY);
    mark('Dehydrated', c.thirst > THIRST.DEHYDRATED);
    mark('Parched', c.thirst > THIRST.PARCHED);
    mark('Hungry', c.hungerState() === 'Hungry');
    mark('Very hungry', c.hungerState() === 'Very Hungry');
    mark('Tired', c.sleepiness > SLEEPINESS.TIRED);
    mark('Dead tired', c.sleepiness > SLEEPINESS.DEAD_TIRED);
  }
  return { milestones: out, atEnd: { thirst: c.thirst, kcal: c.storedKcal, sleepiness: c.sleepiness, hunger: c.hungerState(), dead: c.dead ? 1 : 0 } };
}

// ------------------------------------------------------------------ first night in the shelter

function cold(seed: number): Record<string, number | string | boolean> {
  const w = makeWorld(seed);
  const { game } = w;
  const p = game.player;
  // Kill the monster side: this measures warmth only.
  for (const m of w.mons.sys.all) m.hp = 0;
  w.mons.sys.all.length = 0;
  (w.mons.sys as unknown as { active: Monster[] }).active = [];
  // A blanket from the shelter's lockers, when there is one within the shelter (a newcomer would look).
  let blanket = false;
  for (let dy = -10; dy <= 10 && !blanket; dy++)
    for (let dx = -10; dx <= 10 && !blanket; dx++) {
      for (const it of game.map.itemsAt(p.tileX + dx, p.tileY + dy, 0) as unknown as Item[]) {
        if (/blanket|sleeping_bag|quilt|duvet/.test(it.typeId) && p.inv.canWear(it).ok) {
          game.map.removeItem(p.tileX + dx, p.tileY + dy, 0, it as never);
          p.inv.wear(it);
          blanket = true;
          break;
        }
      }
    }
  // Awake until 22:00, then sleep in place until 07:00.
  const tick = (secs: number) => {
    let r = 0;
    while (r < secs && !p.dead) {
      game.tick(TICK);
      r += TICK;
    }
  };
  let minTemp: number = BODYTEMP.NORM, minAir = 99, wakes = 0, feels = 'Comfortable';
  game.events.on('message', (m) => void (/shiver/i.test(m.text) && wakes++));
  const until = (h: number) => {
    while (!p.dead && (game.clock.hourOfDay < h || game.clock.hourOfDay > h + 12) && game.clock.day < 2) {
      tick(1);
      for (const bp of MAIN_PARTS) minTemp = Math.min(minTemp, p.bodyTemp[bp]);
      minAir = Math.min(minAir, p.env.temperature);
      if (p.bodyTempDescription() !== 'Comfortable' && p.bodyTempDescription() !== 'Warm') feels = p.bodyTempDescription();
    }
  };
  until(22);
  goToSleep(game);
  const t0 = game.clock.seconds;
  while (!p.dead && game.clock.seconds - t0 < 9 * SECONDS_PER_HOUR) {
    if (!game.activities.current && !p.isAsleep()) goToSleep(game);
    tick(1);
    for (const bp of MAIN_PARTS) minTemp = Math.min(minTemp, p.bodyTemp[bp]);
    minAir = Math.min(minAir, p.env.temperature);
    const d = p.bodyTempDescription();
    if (d !== 'Comfortable' && d !== 'Warm' && (feels === 'Comfortable' || d === 'Freezing!' || (d === 'Very cold!' && feels === 'Chilly'))) feels = d;
  }
  return { blanket, minAirC: +minAir.toFixed(1), minBodyC: +minTemp.toFixed(2), worstFeel: feels, coldWakes: wakes, died: p.dead, cause: p.dead ? p.causeOfDeath ?? '?' : '', sleptTill: +game.clock.hourOfDay.toFixed(1) };
}

// ------------------------------------------------------------------ run + summarise

function run(): Rec[] {
  const recs: Rec[] = [];
  const n = Number(args.seeds), s0 = Number(args.seed0);
  const want = (s: string) => args.scenario === 'all' || args.scenario === s;
  const emit = (r: Rec) => {
    recs.push(r);
    if (args.out) appendFileSync(args.out, JSON.stringify(r) + '\n');
  };
  if (want('needs')) emit({ scenario: 'needs', preset: label, seed: 0, ...needs() });
  if (want('duel'))
    for (const weapon of ['fists', 'knife_chef', 'pipe', 'crowbar', 'bat'])
      for (const foes of [1, 2])
        for (let seed = s0; seed < s0 + n; seed++) emit({ scenario: 'duel', preset: label, seed, ...duel(seed, weapon, foes) });
  for (let seed = s0; seed < s0 + n; seed++) {
    if (want('day1')) {
      const t = Date.now();
      const r = day1(seed);
      emit({ scenario: 'day1', preset: label, seed, ...r });
      if (!args.quiet)
        console.error(`day1 ${label} seed ${seed}: ${r.died ? `DIED (${r.deathCause}) at ${r.deathHour?.toFixed(1)}h` : 'survived'}, contact ${fmtS(r.firstContactS)}, z40 ${r.zombies40}+${r.dormant40}d z120 ${r.hostiles120}, max near ${r.maxNear6}, kills ${r.kills}, loot ${r.lootedTiles}, weapon ${r.weapon ?? '-'} (${((Date.now() - t) / 1000).toFixed(0)} s)`);
    }
    if (want('cold')) {
      const r = cold(seed);
      emit({ scenario: 'cold', preset: label, seed, ...r });
      if (!args.quiet) console.error(`cold ${label} seed ${seed}: ${JSON.stringify(r)}`);
    }
  }
  return recs;
}

const fmtS = (s: number | null | undefined) => (s === null || s === undefined ? '—' : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(0)} s`);
const median = (xs: number[]) => {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2;
};
const pctl = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
};

function summarise(recs: Rec[]): void {
  const presets = [...new Set(recs.map((r) => r.preset))];
  const day = recs.filter((r) => r.scenario === 'day1') as unknown as (Day1 & Rec)[];
  if (day.length) {
    console.log('\n## Day 1 (scripted newcomer)\n');
    console.log('| preset | runs | died day 1 | first sighting (median) | first contact (median / p25–p75) | never met one | zombies ≤40 m at start (median, max) | dormant ≤40 m | max within 6 m (median / max) | ≥3 within 6 m (s, median) | kills (median) | HP lost (median) | real min |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const pr of presets) {
      const rs = day.filter((r) => r.preset === pr);
      if (!rs.length) continue;
      const contacts = rs.map((r) => r.firstContactS).filter((x): x is number => x !== null);
      const sights = rs.map((r) => r.firstSightS).filter((x): x is number => x !== null);
      const died = rs.filter((r) => r.died);
      console.log(
        `| ${pr} | ${rs.length} | ${died.length} (${Math.round((100 * died.length) / rs.length)}%)${died.length ? ` (${[...new Set(died.map((r) => r.deathCause))].map((c) => `${c} ×${died.filter((r) => r.deathCause === c).length}`).join(', ')}; median ${median(died.map((r) => r.deathHour ?? 0)).toFixed(0)}:00)` : ''} | ${fmtS(median(sights))} | ${fmtS(median(contacts))} / ${fmtS(pctl(contacts, 0.25))}–${fmtS(pctl(contacts, 0.75))} | ${rs.length - contacts.length} | ${median(rs.map((r) => r.zombies40))}, ${Math.max(...rs.map((r) => r.zombies40))} | ${median(rs.map((r) => r.dormant40))} | ${median(rs.map((r) => r.maxNear6))} / ${Math.max(...rs.map((r) => r.maxNear6))} | ${median(rs.map((r) => r.timeCrowdedS)).toFixed(0)} | ${median(rs.map((r) => r.kills))} | ${median(rs.map((r) => r.hpLost))} | ${median(rs.map((r) => r.realMinutes)).toFixed(0)} |`,
      );
    }
  }
  const nd = recs.filter((r) => r.scenario === 'needs') as unknown as ({ milestones: Milestone[] } & Rec)[];
  if (nd.length) {
    console.log('\n## Needs without eating or drinking (sleep 23:00–07:00, start 08:00 day 1)\n');
    const whats = ['Hungry', 'Very hungry', 'Thirsty', 'Very thirsty', 'Dehydrated', 'Parched', 'Tired', 'Dead tired'];
    console.log(`| milestone | ${nd.map((r) => r.preset).join(' | ')} |`);
    console.log(`|---|${nd.map(() => '---').join('|')}|`);
    for (const w of whats) {
      const cells = nd.map((r) => {
        const m = r.milestones.find((x) => x.what === w);
        if (!m) return 'not in 3 days';
        const d = Math.floor(m.gameHour / 24) + 1, h = m.gameHour % 24;
        return `day ${d} ${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')} (${m.realMin.toFixed(0)} real min)`;
      });
      console.log(`| ${w} | ${cells.join(' | ')} |`);
    }
  }
  const du = recs.filter((r) => r.scenario === 'duel') as unknown as (Record<string, number | string | boolean> & Rec)[];
  if (du.length) {
    console.log('\n## Melee duels on open ground (walk in and swing; no guard, no side-step)\n');
    console.log('| preset | weapon | zombies | runs | won | died | fight length (median s) | HP lost (median, all parts) | swings/s |');
    console.log('|---|---|---|---|---|---|---|---|---|');
    const keys = [...new Set(du.map((r) => `${r.preset}|${r.weapon}|${r.foes}`))];
    for (const k of keys) {
      const [pr, w, f] = k.split('|');
      const rs = du.filter((r) => r.preset === pr && r.weapon === w && String(r.foes) === f);
      console.log(`| ${pr} | ${w} | ${f} | ${rs.length} | ${rs.filter((r) => r.won).length} | ${rs.filter((r) => r.died).length} | ${median(rs.map((r) => r.seconds as number)).toFixed(0)} | ${median(rs.map((r) => r.hpLost as number))} | ${median(rs.map((r) => r.swingsPerSec as number)).toFixed(2)} |`);
    }
  }
  const cd = recs.filter((r) => r.scenario === 'cold') as unknown as (Record<string, number | string | boolean> & Rec)[];
  if (cd.length) {
    console.log('\n## First night in the shelter (starting kit + a shelter blanket if found)\n');
    console.log('| preset | runs | blanket found | coldest air °C (median) | lowest body °C (median / min) | worst feeling (count) | cold wake-ups (median) | died |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const pr of presets) {
      const rs = cd.filter((r) => r.preset === pr);
      if (!rs.length) continue;
      const feels = new Map<string, number>();
      for (const r of rs) feels.set(String(r.worstFeel), (feels.get(String(r.worstFeel)) ?? 0) + 1);
      console.log(
        `| ${pr} | ${rs.length} | ${rs.filter((r) => r.blanket).length} | ${median(rs.map((r) => r.minAirC as number)).toFixed(1)} | ${median(rs.map((r) => r.minBodyC as number)).toFixed(1)} / ${Math.min(...rs.map((r) => r.minBodyC as number)).toFixed(1)} | ${[...feels].map(([k, v]) => `${k} ${v}`).join(', ')} | ${median(rs.map((r) => r.coldWakes as number))} | ${rs.filter((r) => r.died).length} |`,
      );
    }
  }
}

if (args.presets) {
  console.log('| Group | Rule | Accessible | Classic |\n|---|---|---|---|');
  for (const k of KNOBS) console.log(`| ${k.group} | ${k.name} | ${formatKnob(k, DIFFICULTY_PRESETS.accessible[k.key])} | ${formatKnob(k, DIFFICULTY_PRESETS.classic[k.key])} |`);
} else if (args.from) {
  const recs = args.from.split(',').flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec));
  summarise(recs);
} else {
  if (args.out) writeFileSync(args.out, '', { flag: 'a' });
  const recs = run();
  summarise(recs);
}
