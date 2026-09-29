import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Soundset } from '../src/audio/soundset';
import type { SoundEffectDef, SoundsetFile } from '../src/audio/soundsetTypes';
import { cddaHeardVolume, countOccluders, distanceGain, lineTiles, listenerSpace, muffle } from '../src/audio/spatial';
import { footstepVariant } from '../src/audio/footsteps';
import { ambientLayers, isNight, WEATHER_TYPES } from '../src/audio/ambience';
import { soundForEvent } from '../src/audio/soundEvents';
import { registerSynth, renderSynth, SYNTH_EFFECTS } from '../src/audio/procedural';
import { meleeSkillVariant } from '../src/audio/sfx';
import { engineRate, engineVariant, gearFor, hornVariant } from '../src/audio/vehicleAudio';
import { decide, isRedistributable, parseCreditsMd, parseCreditsTxt } from '../tools/audio/credits';
import { LEVEL_HEIGHT } from '../src/world/coords';

const E = (id: string, variants: string[], files: string[], extra: Partial<SoundEffectDef> = {}): SoundEffectDef => ({
  id, variants, files, volume: 100, ...extra,
});

describe('Soundset lookup (CDDA find_closest_sfx)', () => {
  const s = new Soundset([
    E('open_door', ['t_door_c'], ['door.ogg']),
    E('open_door', ['default'], ['generic.ogg']),
    E('env', ['WEATHER_CLEAR'], ['clear_spring_day.ogg'], { season: 'spring', indoors: false, night: false }),
    E('env', ['WEATHER_CLEAR'], ['clear_night.ogg'], { season: 'spring', indoors: false, night: true }),
    E('env', ['indoors'], ['indoors.ogg'], { indoors: true }),
    E('seasonal', ['x'], ['x_summer.ogg'], { season: 'summer' }),
    E('seasonal', ['default'], ['d.ogg']),
  ]);

  it('uses the exact variant, else "default"', () => {
    expect(s.find('open_door', 't_door_c')!.map((f) => f.file)).toEqual(['door.ogg']);
    expect(s.find('open_door', 't_door_glass_c')!.map((f) => f.file)).toEqual(['generic.ogg']);
    expect(s.resolve('open_door', 'nope', {}, () => 0)).toMatchObject({ file: 'generic.ogg', variant: 'default' });
  });
  it('findExact has no variant fallback', () => {
    expect(s.findExact('open_door', 't_door_glass_c')).toBeNull();
    expect(s.findExact('open_door', 't_door_c')).not.toBeNull();
  });
  it('unknown id resolves to null', () => {
    expect(s.resolve('nothing', 'default')).toBeNull();
  });
  it('matches season / indoors / night, with unset keys as wildcard fallback', () => {
    expect(s.find('env', 'WEATHER_CLEAR', { season: 'spring', indoors: false, night: true })![0].file).toBe('clear_night.ogg');
    expect(s.find('env', 'WEATHER_CLEAR', { season: 'spring', indoors: false, night: false })![0].file).toBe('clear_spring_day.ogg');
    // outdoor-only bed does not play indoors (no EITHER entry to fall back to)
    expect(s.find('env', 'WEATHER_CLEAR', { season: 'spring', indoors: true, night: false })).toBeNull();
    // entry without night key matches both
    expect(s.find('env', 'indoors', { indoors: true, night: true })![0].file).toBe('indoors.ogg');
    expect(s.find('env', 'indoors', { indoors: true, night: false })![0].file).toBe('indoors.ogg');
  });
  it('does not backtrack to the default variant when a deeper level misses (CDDA quirk)', () => {
    expect(s.find('seasonal', 'x', { season: 'summer' })![0].file).toBe('x_summer.ogg');
    expect(s.find('seasonal', 'x', { season: 'winter' })).toBeNull();
  });
  it('accumulates files from several entries with the same key', () => {
    const t = new Soundset([E('a', ['v'], ['1.ogg']), E('a', ['v'], ['2.ogg'], { volume: 50 })]);
    expect(t.find('a', 'v')!.map((f) => [f.file, f.volume])).toEqual([['1.ogg', 100], ['2.ogg', 50]]);
    expect(t.resolve('a', 'v', {}, () => 0.99)!.file).toBe('2.ogg');
  });
});

describe('spatial math', () => {
  it('maps world offsets into listener space (yaw 0 = facing north/-y)', () => {
    const l = { x: 10, y: 10, z: 0, yaw: 0 };
    // straight ahead (north): WebAudio -Z
    expect(listenerSpace(l, { x: 10, y: 5, z: 0 })).toMatchObject({ x: 0, z: -5, dist: 5 });
    // east = right
    const r = listenerSpace(l, { x: 13, y: 10, z: 0 });
    expect(r.x).toBeCloseTo(3);
    expect(r.z).toBeCloseTo(0);
    // turn to face east (yaw +90°): the east sound is now ahead
    const t = listenerSpace({ ...l, yaw: Math.PI / 2 }, { x: 13, y: 10, z: 0 });
    expect(t.x).toBeCloseTo(0);
    expect(t.z).toBeCloseTo(-3);
    // one level up is LEVEL_HEIGHT metres above
    expect(listenerSpace(l, { x: 10, y: 10, z: 1 })).toMatchObject({ y: LEVEL_HEIGHT, dist: LEVEL_HEIGHT });
  });
  it('CDDA heard volume: 99 next to you, 0 at 24 tiles', () => {
    expect(cddaHeardVolume(0)).toBe(99);
    expect(cddaHeardVolume(12)).toBe(49);
    expect(cddaHeardVolume(24)).toBe(0);
    expect(cddaHeardVolume(50)).toBe(0);
  });
  it('distance gain falls monotonically to silence at range, respecting a floor', () => {
    expect(distanceGain(0)).toBe(1);
    expect(distanceGain(1)).toBe(1);
    const g = [2, 5, 10, 20].map((d) => distanceGain(d));
    for (let i = 1; i < g.length; i++) expect(g[i]).toBeLessThan(g[i - 1]);
    expect(distanceGain(25, 24)).toBe(0);
    expect(distanceGain(100, 24, 0.3)).toBe(0.3);
    expect(distanceGain(30, 80)).toBeGreaterThan(distanceGain(30, 24));
  });
  it('lineTiles excludes the endpoints', () => {
    expect(lineTiles(0, 0, 3, 0)).toEqual([[1, 0], [2, 0]]);
    expect(lineTiles(0, 0, 0, 0)).toEqual([]);
    expect(lineTiles(0, 0, 1, 1)).toEqual([]);
    expect(lineTiles(0, 0, 3, 3)).toEqual([[1, 1], [2, 2]]);
  });
  it('counts walls on the line and floors between levels', () => {
    const wall = (x: number) => x === 5;
    expect(countOccluders({ x: 0.5, y: 0.5, z: 0 }, { x: 9.5, y: 0.5, z: 0 }, (x) => wall(x))).toBe(1);
    expect(countOccluders({ x: 0.5, y: 0.5, z: 0 }, { x: 4.5, y: 0.5, z: 0 }, (x) => wall(x))).toBe(0);
    expect(countOccluders({ x: 0.5, y: 0.5, z: 0 }, { x: 0.5, y: 0.5, z: 1 }, () => false)).toBe(2);
  });
  it('muffling: clear line keeps highs; each wall lowers cutoff and gain', () => {
    const open = muffle(0, 2), one = muffle(1, 2), two = muffle(2, 2);
    expect(open.gain).toBe(1);
    expect(open.cutoff).toBeGreaterThan(10000);
    expect(one.cutoff).toBeLessThan(3000);
    expect(two.cutoff).toBeLessThan(one.cutoff);
    expect(two.gain).toBeLessThan(one.gain);
    expect(muffle(0, 100).cutoff).toBeLessThan(open.cutoff); // air absorption
  });
});

describe('footsteps (CDDA do_footstep)', () => {
  const has = (set: string[]) => (v: string) => set.includes(v);
  it('prefers water, then exact terrain variants, then groups', () => {
    expect(footstepVariant({ terrainId: 't_water_sh', terrainFlags: ['SHALLOW_WATER'], hasVariant: has(['t_water_sh']) })).toBe('walk_water');
    expect(footstepVariant({ terrainId: 't_floor', terrainFlags: [], hasVariant: has(['t_floor']) })).toBe('t_floor');
    expect(footstepVariant({ terrainId: 't_grass', terrainFlags: [], hasVariant: has([]) })).toBe('walk_grass');
    expect(footstepVariant({ terrainId: 't_dirt', terrainFlags: [], hasVariant: has([]) })).toBe('walk_dirt');
    expect(footstepVariant({ terrainId: 't_metal_floor', terrainFlags: [], hasVariant: has([]) })).toBe('walk_metal');
    expect(footstepVariant({ terrainId: 't_pavement', terrainFlags: [], hasVariant: has([]) })).toBe('walk_tarmac');
    expect(footstepVariant({ terrainId: 't_pavement', terrainFlags: [], barefoot: true, hasVariant: has([]) })).toBe('walk_barefoot');
  });
});

describe('ambience (CDDA do_ambient)', () => {
  const base = { underground: false, sheltered: false, night: false, season: 'spring' as const, weather: WEATHER_TYPES.sunny };
  const variants = (s: Parameters<typeof ambientLayers>[0]) => ambientLayers(s).map((l) => `${l.channel}:${l.variant}`);
  it('outdoors: time of day + weather bed', () => {
    expect(variants(base)).toEqual(['time_of_day:daytime', 'weather:WEATHER_SUNNY']);
    expect(variants({ ...base, night: true, weather: WEATHER_TYPES.rain })).toEqual(['time_of_day:nighttime', 'weather:WEATHER_RAINY']);
    expect(variants({ ...base, weather: WEATHER_TYPES.fog })).toEqual(['time_of_day:daytime']);
  });
  it('indoors: indoor bed, rain on the roof unless it only drizzles lightly', () => {
    expect(variants({ ...base, sheltered: true })).toEqual(['shelter:indoors']);
    expect(variants({ ...base, sheltered: true, weather: WEATHER_TYPES.rain })).toEqual(['shelter:indoors', 'indoor_rain:indoors_rain']);
    expect(variants({ ...base, sheltered: true, weather: WEATHER_TYPES.light_drizzle })).toEqual(['shelter:indoors']);
  });
  it('underground overrides everything', () => {
    expect(variants({ ...base, underground: true, sheltered: true, weather: WEATHER_TYPES.thunder })).toEqual(['shelter:underground']);
  });
  it('isNight follows the season', () => {
    expect(isNight(12, 'winter')).toBe(false);
    expect(isNight(17, 'winter')).toBe(true);
    expect(isNight(17, 'summer')).toBe(false);
    expect(isNight(3, 'summer')).toBe(true);
  });
});

describe('world sound events -> sfx', () => {
  it('uses explicit sfx ids verbatim and honours the "already played" marker', () => {
    expect(soundForEvent({ volume: 10, description: 'whatever', sfxId: 'open_door', sfxVariant: 't_door_c' })).toEqual({ id: 'open_door', variant: 't_door_c' });
    expect(soundForEvent({ volume: 10, description: 'Smash!', sfxId: '' })).toBeNull();
  });
  it('maps CDDA onomatopoeia by keyword', () => {
    expect(soundForEvent({ volume: 20, description: 'Smash!' })).toEqual({ id: 'smash_success', variant: 'default' });
    expect(soundForEvent({ volume: 8, description: 'whump!' })).toEqual({ id: 'smash_fail', variant: 'default' });
    expect(soundForEvent({ volume: 12, description: 'glass breaking!' })).toEqual({ id: 'smash', variant: 'glass' });
    expect(soundForEvent({ volume: 100, description: 'a huge explosion!' })).toEqual({ id: 'explosion', variant: 'huge' });
    expect(soundForEvent({ volume: 5, description: 'a groan.' })).toEqual({ id: 'speech', variant: 'mon_zombie' });
    expect(soundForEvent({ volume: 60, description: 'a loud BANG!' })).toEqual({ id: 'fire_gun', variant: 'default' });
    expect(soundForEvent({ volume: 5, description: 'bang' })).toBeNull(); // too quiet for a gun
    expect(soundForEvent({ volume: 10, description: 'a sound of something indescribable' })).toBeNull();
  });
});

describe('vehicle engine sound (CDDA do_vehicle_engine_sfx)', () => {
  it('gears follow CDDA speed thresholds and the loop revs up within a gear', () => {
    const safe = 30;
    expect(gearFor(0, safe)).toBe(0);
    expect(gearFor(-3, safe)).toBe(-1);
    expect(gearFor(2, safe)).toBe(1); // <= safe/12
    expect(gearFor(5, safe)).toBe(2); // <= safe/5
    expect(gearFor(14, safe)).toBe(5); // <= safe/2
    expect(gearFor(29, safe)).toBe(6);
    expect(engineRate(0, safe)).toBeCloseTo(0.85);
    expect(engineRate(4.9, safe)).toBeGreaterThan(engineRate(2.6, safe)); // same gear, faster
    expect(engineRate(2.49, safe)).toBeGreaterThan(engineRate(2.51, safe)); // shifting up drops the revs
  });
  it('picks CDDA fallback variants (none loaded = last of the chain)', () => {
    const v = { uid: 1, x: 0, y: 0, z: 0, velocity: 0, engineOn: true, engines: [{ enabled: true, hp: 10, def: { id: 'engine_v8', fuel_type: 'gasoline' } }], maxVelocity: () => 30 };
    expect(engineVariant('engine_start', v)).toBe('combustion');
    expect(engineVariant('engine_start', { ...v, engines: [{ enabled: true, hp: 10, def: { id: 'motor', fuel_type: 'battery' } }] })).toBe('electric');
    expect(hornVariant(120)).toBe('horn_medium');
  });
});

describe('melee variant (CDDA sound_thread)', () => {
  it('buckets by skill and weapon volume', () => {
    expect(meleeSkillVariant({ skill: 'bashing', volumeMl: 1000 })).toBe('small_bash');
    expect(meleeSkillVariant({ skill: 'bashing', volumeMl: 2500 })).toBe('big_bash');
    expect(meleeSkillVariant({ skill: 'cutting', volumeMl: 1750 })).toBe('big_cutting');
    expect(meleeSkillVariant({ skill: 'stabbing', volumeMl: 500 })).toBe('small_stabbing');
    expect(meleeSkillVariant({})).toBe('unarmed');
  });
});

describe('procedural sounds', () => {
  it('render deterministic, finite, non-silent samples for every synth entry', () => {
    for (const e of SYNTH_EFFECTS)
      for (const f of e.files) {
        const a = renderSynth(f, 8000), b = renderSynth(f, 8000);
        expect(a.length).toBeGreaterThan(100);
        expect(a).toEqual(b);
        let peak = 0;
        for (const v of a) {
          expect(Number.isFinite(v)).toBe(true);
          peak = Math.max(peak, Math.abs(v));
        }
        expect(peak, f).toBeGreaterThan(0.05);
        expect(peak, f).toBeLessThanOrEqual(1);
      }
  });
  it('only fills variants the pack lacks', () => {
    const s = new Soundset([E('bullet_hit', ['hit_wall'], ['real.ogg'])]);
    registerSynth((e) => s.add(e), (id, v) => s.findExact(id, v) !== null);
    expect(s.find('bullet_hit', 'hit_wall')!.map((f) => f.file)).toEqual(['real.ogg']);
    expect(s.find('bullet_hit', 'hit_metal')![0].file).toMatch(/^synth:hit_metal\//);
  });
});

describe('credits / licence gate', () => {
  it('parses credits.md tables', () => {
    const c = parseCreditsMd(
      '| File Name | Author | License | Link |\n|---|---|---|---|\n| walk_dirt_1.ogg | nuFF3 | **CC-BY** | https://x/1 |\n|  |  | ** ** |  |\n',
      'plmove/credits.md',
    );
    expect(c).toEqual([{ name: 'walk_dirt_1', author: 'nuFF3', license: 'CC-BY', link: 'https://x/1', source: 'plmove/credits.md' }]);
  });
  it('parses credits.txt sentences', () => {
    const c = parseCreditsTxt('"close_curtain" and "open_curtain" by Tats14 (https://f/408784/) licensed under CC-BY-NC', 'x/credits.txt');
    expect(c.map((x) => [x.name, x.license])).toEqual([['close_curtain', 'CC-BY-NC'], ['open_curtain', 'CC-BY-NC']]);
  });
  it('accepts CC0/CC-BY spellings, rejects NC/ND/Sampling+', () => {
    for (const l of ['CC0', 'CC0 1.0', 'CC 0', 'CC-BY', 'CC BY 3.0', 'CC BY 4.0', 'CC-BY-4.0', 'CC-BY/CC0', 'CC-BY-SA 4.0']) expect(isRedistributable(l), l).toBe(true);
    for (const l of ['CC-BY-NC', 'CC BY-NC 3.0', 'CC-BY-ND', 'Sampling Plus 1.0', '', 'All rights reserved']) expect(isRedistributable(l), l).toBe(false);
  });
  it('drops a file if any statement is non-free or none exists', () => {
    const ok = { name: 'a', author: 'x', license: 'CC-BY', link: '', source: 'a' };
    expect(decide([ok]).ok).toBe(true);
    expect(decide([]).ok).toBe(false);
    expect(decide([ok, { ...ok, license: 'CC-BY-NC' }]).ok).toBe(false);
  });
});

describe('committed public/audio', () => {
  const root = join(__dirname, '..', 'public', 'audio');
  const set = JSON.parse(readFileSync(join(root, 'soundset.json'), 'utf8')) as SoundsetFile;
  it('every referenced file exists with recorded size, and nothing is orphaned', () => {
    const referenced = new Set([...set.effects.flatMap((e) => e.files), ...set.playlists.flatMap((p) => p.files.map((f) => f.file))]);
    for (const f of referenced) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(set.files[f]?.bytes, f).toBe(statSync(join(root, f)).size);
      expect(set.files[f].duration, f).toBeGreaterThan(0);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(root).map((p) => relative(root, p)).filter((p) => p.endsWith('.ogg'))) expect(referenced.has(f), f).toBe(true);
  });
  it('stays within the 25 MB budget', () => {
    const total = Object.values(set.files).reduce((a, f) => a + f.bytes, 0);
    expect(total).toBeLessThan(25e6);
  });
  it('covers the sounds the game relies on', () => {
    const s = Soundset.fromFile(set);
    registerSynth((e) => s.add(e), (id, v) => s.findExact(id, v) !== null);
    const need: [string, string][] = [
      ['plmove', 'walk_grass'], ['plmove', 'walk_dirt'], ['plmove', 't_floor'], ['plmove', 'walk_tarmac'],
      ['melee_hit_flesh', 'small_bash'], ['melee_swing', 'big_cutting'], ['fire_gun', 'default'], ['fire_gun', 'glock_19'],
      ['open_door', 't_door_c'], ['close_door', 't_door_o'], ['smash', 'glass'], ['smash_success', 'default'],
      ['mon_death', 'zombie_death'], ['speech', 'mon_zombie'], ['menu_move', 'default'], ['menu_error', 'default'],
      ['bullet_hit', 'hit_flesh'], ['explosion', 'default'],
      // vehicles (src/audio/vehicleAudio.ts)
      ['engine_start', 'combustion'], ['engine_stop', 'combustion'], ['engine_working_internal', 'combustion'],
      ['engine_working_external', 'combustion'], ['vehicle', 'horn_medium'], ['vehicle', 'gear_shift'], ['vehicle', 'car_alarm'],
      ['vehicle_open', 'door'], ['vehicle_close', 'door'], ['smash_success', 'hit_vehicle'],
    ];
    for (const [id, v] of need) expect(s.resolve(id, v), `${id}/${v}`).not.toBeNull();
    for (const season of ['spring', 'summer', 'autumn', 'winter'] as const)
      for (const night of [false, true]) expect(s.find('environment', 'WEATHER_SUNNY', { season, indoors: false, night }), `${season} ${night}`).not.toBeNull();
    expect(s.find('environment', 'indoors', { indoors: true })).not.toBeNull();
    expect(s.find('environment', 'nighttime', { indoors: false, night: true })).not.toBeNull();
  });
});
