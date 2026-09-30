// Pure rules behind the interaction screens (src/screens/logic): typewriter timing, how a
// dialogue response reads, the trade balance meter and reactions, the vehicle diagram and
// gauges, the Autodoc's surgery plan and the mission log / map markers — against real BN data
// where it matters.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { revealDuration, revealSchedule, visibleCount, TEXT_SPEED_CPS } from '../src/screens/logic/typewriter';
import { keyToResponse, oddsTone, opinionWord, responseKey, responseRow, stripTags, trialChip, trialOutcome } from '../src/screens/logic/dialogue';
import { balanceMeter, money, reaction } from '../src/screens/logic/trade';
import { conditionWord, displayedPart, driveReadout, fuelGauges, healthTone, listOrder, partGlyph, vehicleDiagram } from '../src/screens/logic/vehicle';
import { operationTime, surgeryPlan } from '../src/screens/logic/surgery';
import { bearing, missionEntry, missionMarkers, missionTarget } from '../src/screens/logic/missions';
import { mapMarkerProviders, mapMarkers } from '../src/game/mapmarkers';
import type { ResponseView } from '../src/game/talk';
import { Dialogue } from '../src/game/talk';
import { spawnVehicle, has } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { Character } from '../src/game/character';
import { attachBodyMods } from '../src/game/bodymods';
import { createItem } from '../src/game/item';
import { Rng } from '../src/core/rng';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { NpcSystem } from '../src/game/npcai';
import type { NpcData } from '../src/game/npc';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let vdata: VehicleDataFile;
let nd: NpcData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  vdata = load('vehicles.json');
  nd = load('npcs.json');
});

describe('typewriter', () => {
  it('reveals at the set speed, pausing after sentences but not inside "3.5" or "Mr.Smith"', () => {
    const s = revealSchedule('Hi. Go', 10);
    // H i . (pause) space G o: whitespace is free, the period adds a breath
    expect(s[0]).toBe(0);
    expect(s[1]).toBe(100);
    expect(s[2]).toBe(200);
    expect(s[4]).toBeGreaterThan(s[2] + 100 + 150);
    const n = revealSchedule('3.5 m', 10);
    expect(n[2] - n[1]).toBe(100);
    expect(visibleCount(s, -1)).toBe(0);
    expect(visibleCount(s, 0)).toBe(1);
    expect(visibleCount(s, 1e9)).toBe(s.length);
    expect(revealDuration(s)).toBe(s[s.length - 1]);
  });
  it('instant shows everything at once; nonsense speeds throw', () => {
    expect(revealSchedule('abc', TEXT_SPEED_CPS.instant)).toEqual([0, 0, 0]);
    expect(() => revealSchedule('abc', 0)).toThrow();
    expect(() => revealSchedule('abc', NaN)).toThrow();
  });
});

describe('dialogue responses', () => {
  const base: ResponseView = { text: 'x', color: 'c_white', available: true, index: 0 };
  it('numbers 1-9 then 0, and digits only pick existing answers', () => {
    expect(responseKey(0)).toBe('1');
    expect(responseKey(9)).toBe('0');
    expect(responseKey(10)).toBeUndefined();
    expect(keyToResponse('3', 5)).toBe(2);
    expect(keyToResponse('6', 5)).toBe(-1);
    expect(keyToResponse('a', 5)).toBe(-1);
  });
  it('shows trial odds with a tone and what the roll uses', () => {
    expect(oddsTone(80)).toBe('good');
    expect(oddsTone(50)).toBe('warn');
    expect(oddsTone(10)).toBe('bad');
    const c = trialChip({ kind: 'PERSUADE', chance: 45, uses: 'Speech, Intelligence, Perception' })!;
    expect(c.label).toBe('Persuade 45%');
    expect(c.tone).toBe('warn');
    expect(c.detail).toContain('Speech');
    const sk = trialChip({ kind: 'SKILL_CHECK', chance: 0, uses: 'Mechanics 2/4', skill: 'Mechanics', have: 2, need: 4 })!;
    expect(sk.label).toBe('Mechanics 2/4');
    expect(sk.tone).toBe('bad');
    expect(trialChip(undefined)).toBeNull();
    expect(trialOutcome('LIE', 30, false)).toEqual({ text: 'Lie failed (30% chance)', tone: 'bad' });
  });
  it('explains unavailable answers instead of prefixing them', () => {
    const r = responseRow({ ...base, text: '*Too tired: Help me', plain: 'Help me', available: false, reason: 'Too tired' }, 0);
    expect(r.text).toBe('Help me');
    expect(r.unavailable).toBe('Too tired');
    const hidden = responseRow({ ...base, available: false, hidden: true }, 1);
    expect(hidden.hidden).toBe(true);
    expect(hidden.unavailable).toBeTruthy();
    expect(stripTags('<color_red>no</color> way')).toBe('no way');
  });
  it('says how the NPC feels in a word', () => {
    const op = { trust: 0, fear: 0, value: 0, anger: 0, owed: 0 };
    expect(opinionWord(op, false, false).word).toBe('Neutral');
    expect(opinionWord({ ...op, trust: 6 }, false, false).word).toBe('Friendly');
    expect(opinionWord({ ...op, anger: 9 }, false, false).tone).toBe('bad');
    expect(opinionWord(op, true, false).word).toBe('Hostile');
    expect(opinionWord(op, false, true).tone).toBe('good');
  });
  it('real BN trials come through the dialogue as structured odds', () => {
    const { npcs } = world();
    const n = npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
    const d = new Dialogue(npcs, n);
    d.start();
    // Find a topic with a PERSUADE trial and visit it.
    const topic = Object.entries(nd.topics).find(([, t]) => (t.responses ?? []).some((r: any) => r.trial?.type === 'PERSUADE' && r.condition === undefined))![0];
    d.topics.push(topic);
    const v = d.refresh();
    const tr = v.responses.find((r) => r.trial?.kind === 'PERSUADE')!;
    expect(tr).toBeTruthy();
    expect(tr.trial!.chance).toBeGreaterThanOrEqual(0);
    expect(tr.text).toMatch(/^\[PERSUADE \d+%\] /);
    expect(tr.plain).not.toMatch(/PERSUADE/);
    expect(responseRow(tr, 0).chip!.label).toMatch(/^Persuade \d+%$/);
  });
});

describe('trade meter', () => {
  it('reads the balance against the credit the NPC extends', () => {
    expect(money(1250)).toBe('$12.50');
    expect(money(-5)).toBe('-$0.05');
    const even = balanceMeter(0, 1000, 5000, 'Bob');
    expect(even.acceptable).toBe(true);
    expect(even.needle).toBe(0);
    const credit = balanceMeter(-500, 1000, 5000, 'Bob');
    expect(credit.acceptable).toBe(true);
    expect(credit.tone).toBe('warn');
    expect(credit.creditEdge).toBeLessThan(0);
    const short = balanceMeter(-3000, 1000, 5000, 'Bob');
    expect(short.acceptable).toBe(false);
    expect(short.text).toContain('$20.00 short');
    expect(balanceMeter(-3000, Infinity, 5000, 'Bob').acceptable).toBe(true);
    // The needle never leaves the bar.
    expect(Math.abs(balanceMeter(1e9, 0, 10, 'Bob').needle)).toBeLessThanOrEqual(1);
  });
  it('reacts to the offer', () => {
    expect(reaction(true, 0, 0, 'Bob').mood).toBe('waiting');
    expect(reaction(false, -100, 0, 'Bob').mood).toBe('refuses');
    expect(reaction(false, -100, 500, 'Bob').mood).toBe('reluctant');
    expect(reaction(false, 0, 0, 'Bob').mood).toBe('fair');
    expect(reaction(false, 100, 0, 'Bob').mood).toBe('pleased');
  });
});

describe('vehicle diagram', () => {
  const car = () => {
    const v = spawnVehicle(vdata, data, 'car', { x: 0, y: 0, z: 0, facing: 0, fuel: 50, status: 0, rng: new Rng(3) } as never);
    for (const p of v.parts) p.hp = p.def.durability;
    return v;
  };
  it('one cell per mount, front up, BN z-order on top', () => {
    const v = car();
    const d = vehicleDiagram(v);
    const [x0, y0, x1, y1] = v.bounds();
    expect(d.rows).toBe(x1 - x0 + 1);
    expect(d.cols).toBe(y1 - y0 + 1);
    const mounts = new Set(v.parts.map((p) => `${p.mx},${p.my}`));
    expect(d.cells.length).toBe(mounts.size);
    // The frontmost mount is row 0.
    expect(d.cells.filter((c) => c.row === 0).every((c) => c.mx === x1)).toBe(true);
    // A square with a seat shows the seat over the frame (center 7 > structure 5).
    const seat = v.parts.find((p) => has(p, 'SEAT') && p.def.location === 'center')!;
    expect(displayedPart(v.partsAt(seat.mx, seat.my))).toBe(seat);
    expect(listOrder(v.partsAt(seat.mx, seat.my))[0].def.location).toBe('structure');
    expect(d.cells.every((c) => c.tone === 'good')).toBe(true);
  });
  it('colours by health and marks broken parts', () => {
    const v = car();
    const door = v.parts.find((p) => has(p, 'OPENABLE'))!;
    door.hp = 0;
    const cell = vehicleDiagram(v).cells.find((c) => c.mx === door.mx && c.my === door.my)!;
    expect(cell.flags.broken).toBeGreaterThan(0);
    expect(cell.worst).toBe(0);
    expect(healthTone(0.9)).toBe('good');
    expect(healthTone(0.6)).toBe('warn');
    expect(healthTone(0.2)).toBe('bad');
    expect(healthTone(0)).toBe('dim');
    door.hp = door.def.durability;
    door.open = false;
    expect(partGlyph(door)).toBe('+');
    door.open = true;
    expect(partGlyph(door)).toBe("'");
    expect(conditionWord(v).word).toBe('Undamaged');
  });
  it('gauges fuel and battery; the readout knows safe and top speed', () => {
    const v = car();
    const g = fuelGauges(v);
    expect(g.length).toBeGreaterThan(0);
    expect(g[g.length - 1].id === 'battery' || !g.some((x) => x.id === 'battery')).toBe(true);
    for (const x of g) expect(x.frac).toBeGreaterThanOrEqual(0);
    v.engineOn = true;
    const r = driveReadout(v, true);
    expect(r.topMph).toBeGreaterThanOrEqual(r.safeMph);
    expect(r.strain).toBe(0);
    v.velocity = v.maxVelocity();
    expect(driveReadout(v, false).strain).toBeGreaterThan(0.5);
    expect(driveReadout(v, false).cruiseMph).toBeNull();
  });
});

describe('surgery plan', () => {
  it('states odds, time, anesthetic and what blocks it', () => {
    const c = new Character(data, { seed: 1 });
    c.inv.wear(createItem(data, 'backpack'), null);
    const { bio } = attachBodyMods(c);
    const cbm = createItem(data, 'bio_flashlight');
    const plan = surgeryPlan(bio, cbm, (id) => id);
    expect(plan.name).toMatch(/Flashlight/i);
    expect(plan.chance).toBe(bio.successChance('bio_flashlight', true));
    expect(plan.seconds).toBe(Math.max(1, bio.idx.difficulty('bio_flashlight')) * 1200);
    expect(plan.anesthesia.required).toBe(true);
    expect(plan.anesthesia.needed).toBe(bio.anesthesiaNeeded('bio_flashlight'));
    // No anesthetic at hand: that is what stops it.
    expect(plan.blocker).toMatch(/anesthetic/i);
    expect(plan.risks.length).toBe(3);
    bio.add('bio_painkiller');
    expect(surgeryPlan(bio, cbm, (id) => id).blocker).toBeNull();
    bio.add('bio_flashlight');
    expect(surgeryPlan(bio, cbm, (id) => id).blocker).toBe('CBM is already installed.');
    expect(operationTime(1200)).toBe('20 min');
    expect(operationTime(6000)).toBe('1 h 40 min');
  });
});

// ------------------------------------------------------------------ missions

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}
function world() {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, 5, input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
  const npcs = new NpcSystem(game, nd, null);
  return { game, npcs };
}

describe('missions', () => {
  it('bearing: OMTs and compass direction (y grows south)', () => {
    expect(bearing(12, 12, 0, 0).text).toBe('You are there');
    expect(bearing(12, 12, 0, -5).text).toBe('about 120 m north');
    expect(bearing(12, 12, 3, 0).dir).toBe('east');
    expect(bearing(12, 12, 0, -5)).toMatchObject({ omts: 5, dir: 'north', arrow: '↑' });
    expect(bearing(12, 12, -2, 2).dir).toBe('south-west');
  });
  it('entries and map markers for active missions with a target', () => {
    const { game, npcs } = world();
    const ms = npcs.missions;
    const id = Object.keys(nd.missions).find((k) => nd.missions[k].goal === 'MGOAL_FIND_ITEM' && nd.missions[k].item)!;
    const m = ms.create(id, null)!;
    ms.assign(m, null);
    m.target = { x: 4, y: -2, z: 0 };
    const e = missionEntry(ms, m, game.player, game.clock.seconds, () => null);
    expect(e.name).toBe(nd.missions[id].name);
    expect(e.goal).toMatch(/^Find/);
    expect(e.target?.omts).toBe(4);
    expect(missionTarget(m)).toEqual({ omx: 4, omy: -2, z: 0 });
    const marks = missionMarkers(ms, m.uid);
    expect(marks).toEqual([expect.objectContaining({ id: `mission:${m.uid}`, kind: 'mission', omx: 4, omy: -2, tracked: true })]);
    mapMarkerProviders.push(() => missionMarkers(ms, null));
    expect(mapMarkers().some((k) => k.id === `mission:${m.uid}` && !k.tracked)).toBe(true);
    mapMarkerProviders.pop();
    ms.succeed(m, null);
    expect(missionMarkers(ms, null)).toEqual([]);
  });
});
