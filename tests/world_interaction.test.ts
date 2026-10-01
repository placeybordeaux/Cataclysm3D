// World interaction (sound, vision, bash, examine, z-levels, fields, weather, rest, traps,
// light items) against the real extracted CDDA data and the deterministic TestGenerator map:
//   chunk (0,0): one-room house x 4..14, y 4..12, closed door (9,12), windows (7,4) (14,8),
//                curtained window (4,9); bed (10,10); roof at z1
//   chunk (1,0): two-storey house, stairs up at (30,5) z0, stairs down at (30,5) z1
//   chunk (-1,0): forest with underbrush
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { createItem } from '../src/game/item';
import { emitSound, hearingLine, heardVolume, installSound, noisePhrase, NOISE_REPEAT_QUIET, recentHeard, recentSounds, soundDistance, soundsHeardAt, directionName, footstepVolume } from '../src/game/sound';
import { bresenham, creatureCanSee, lightAt, lineOfSight, monsterSightRange, naturalLight, playerCanSee, sunLight } from '../src/game/vision';
import { bash, getMapDamage, smashAbility } from '../src/game/bash';
import { closeDoor, interactionsAt, openDoor, interactionPrompt } from '../src/game/interact';
import { fallIfUnsupported, goStairs, stairDestination } from '../src/game/zlevels';
import { addField, fieldDamageAt, ignite, installFields, processFields } from '../src/game/fields';
import { BN_START_CLIMATE_OFFSET_DAYS, climateSeconds, evalWeatherCondition, forceWeather, installWeather, meetsBnRequirements, weatherConditions, weatherPoint } from '../src/game/weather';
import { comfortAt, goToSleep, installRest, waitFor } from '../src/game/rest';
import { BODYTEMP } from '../src/game/character';
import { installTraps, setTrap, triggerTrap } from '../src/game/traps';
import { canPowerOn, playerLightState, toggleLight } from '../src/game/lightitems';
import { targetTile } from '../src/game/targeting';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
  };
});

function stubInput(): any {
  return { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
}

function makeGame(seed = 7): { game: Game; log: string[] } {
  const game = new Game(data, seed, stubInput());
  game.map.generator = new TestGenerator();
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  return { game, log };
}

const place = (game: Game, x: number, y: number, z = 0) => {
  game.player.x = x + 0.5;
  game.player.y = y + 0.5;
  game.player.z = z;
};

describe('sound', () => {
  it('sound_distance is Chebyshev plus 5x vertical, much more underground', () => {
    expect(soundDistance({ x: 0, y: 0, z: 0 }, { x: 3, y: -7, z: 0 })).toBe(7);
    expect(soundDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })).toBe(5);
    expect(soundDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 })).toBe(25);
    expect(soundDistance({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -2 })).toBe(130);
  });

  it('footsteps: 6 walking, 9 running, 3 crouching', () => {
    expect(footstepVolume(false, false)).toBe(6);
    expect(footstepVolume(true, false)).toBe(9);
    expect(footstepVolume(false, true)).toBe(3);
  });

  it('is remembered for monsters and muffled by walls', () => {
    const { game } = makeGame();
    installSound(game);
    place(game, 9, 16);
    const s = emitSound(game, { x: 9, y: 8, z: 0 }, 40, 'a loud crash!');
    expect(recentSounds(game)).toContain(s);
    // Outside the house, straight through the south wall (9,12 is the door: use x=6).
    const open = heardVolume(game, { x: 6, y: 16, z: 0, volume: 40 }, { x: 6, y: 20, z: 0 });
    const walled = heardVolume(game, { x: 6, y: 8, z: 0, volume: 40 }, { x: 6, y: 16, z: 0 });
    expect(open).toBe(36);
    expect(walled).toBe(40 - 8 - 3);
    const heard = soundsHeardAt(game, 9, 30, 0);
    expect(heard[0].sound).toBe(s);
    game.tick(1.1); // older than SOUND_MEMORY after a real second
    for (let i = 0; i < 40; i++) game.tick(1 / 30);
    expect(recentSounds(game)).not.toContain(s);
  });

  it('the player hears unseen noises with a direction, and wakes up', () => {
    const { game, log } = makeGame();
    installSound(game);
    place(game, 9, 16);
    game.player.yaw = 0;
    emitSound(game, { x: 30, y: 16, z: 0 }, 60, 'a loud crash!');
    expect(log.some((l) => /You hear a loud crash to the east, 21 m away/.test(l))).toBe(true);
    // Inside the closed house, the noise comes from the other house to the east.
    place(game, 6, 11);
    log.length = 0;
    emitSound(game, { x: 30, y: 11, z: 0 }, 60, 'a scream');
    expect(log).toContain('You hear a scream to the east, 24 m away.');
    expect(directionName(1, -1)).toBe('northeast');
    game.player.fallAsleep();
    expect(game.player.isAsleep()).toBe(true);
    emitSound(game, { x: 8, y: 8, z: 0 }, 80, 'BOOM!');
    expect(game.player.isAsleep()).toBe(false);
    expect(log).toContain('Something is making noise.');
  });

  it('noise lines say what, which way and how far; repeats from one direction are told once (QA: "You hear thump! x21")', () => {
    expect(noisePhrase('thump!')).toBe('a thump');
    expect(noisePhrase('BOOM!')).toBe('a boom');
    expect(noisePhrase('a loud crash!')).toBe('a loud crash');
    expect(noisePhrase('WHOOP WHOOP')).toBe('WHOOP WHOOP');
    expect(hearingLine('thump!', 0, -12, 0)).toBe('You hear a thump to the north, 12 m away.');
    expect(hearingLine('Smack!', 1, 1, 0)).toBe('You hear a smack to the southeast, right next to you.');
    expect(hearingLine('thump!', 0, 0, 1)).toBe('You hear a thump above you.');
    expect(hearingLine('thump!', 5, 0, -1)).toBe('You hear a thump to the east, 5 m away, one floor down.');

    const { game, log } = makeGame();
    installSound(game);
    place(game, 9, 16);
    log.length = 0;
    // A zombie bashing a door to the east, once a second for 20 s.
    for (let i = 0; i < 20; i++) {
      emitSound(game, { x: 30, y: 16, z: 0 }, 60, 'thump!');
      for (let k = 0; k < 10; k++) game.tick(0.1);
    }
    const thumps = log.filter((l) => /thump/.test(l));
    expect(thumps[0]).toBe('You hear a thump to the east, 21 m away.');
    expect(thumps.length).toBeLessThanOrEqual(Math.ceil(20 / NOISE_REPEAT_QUIET));
    // The HUD's compass marks: heard noises are remembered briefly with where they came from.
    expect(recentHeard(game).at(-1)).toMatchObject({ x: 30, y: 16, description: 'thump!' });
  });
});

describe('vision & light', () => {
  it('Bresenham lines and line of sight through the house walls', () => {
    expect(bresenham(0, 0, 3, 1)).toEqual([[0, 0], [1, 0], [2, 1], [3, 1]]);
    const { game } = makeGame();
    expect(lineOfSight(game.map, 6, 8, 12, 8, 0)).toBe(true); // inside the room
    expect(lineOfSight(game.map, 6, 8, 6, 16, 0)).toBe(false); // through the south wall
    expect(lineOfSight(game.map, 6, 16, 6, 3, 0)).toBe(false);
  });

  it('CDDA sun light curve and day/night ambient', () => {
    expect(sunLight(-20)).toBe(0);
    expect(sunLight(70)).toBe(125);
    expect(sunLight(-1)).toBeCloseTo(60, 0);
    const { game } = makeGame();
    game.clock.seconds = 12 * 3600;
    expect(naturalLight(game)).toBeGreaterThan(90);
    game.clock.seconds = 24 * 3600;
    expect(naturalLight(game)).toBeLessThan(8);
  });

  it('indoors is dimmer, windows let daylight in, fire lights the night', () => {
    const { game } = makeGame();
    game.clock.seconds = 12 * 3600;
    const out = lightAt(game, 9, 16, 0);
    const byWindow = lightAt(game, 13, 8, 0); // next to the (14,8) window
    expect(out).toBeGreaterThan(byWindow);
    expect(byWindow).toBeGreaterThan(10);
    game.clock.seconds = 24 * 3600 + 3600; // 01:00
    const dark = lightAt(game, 3, 6 + 24, 0);
    const nearFire = lightAt(game, 6, 6 + 24, 0); // testgen campfire at (5,30) intensity 2
    expect(nearFire).toBeGreaterThan(dark + 10);
    place(game, 9, 16);
    expect(playerCanSee(game, 9, 17, 0)).toBe(true); // adjacent always
  });

  it('monster sight range follows CDDA and a flashlight gives you away', () => {
    expect(monsterSightRange(40, 3, 0)).toBe(3);
    expect(monsterSightRange(40, 3, 100)).toBe(40);
    expect(monsterSightRange(40, 3, 50)).toBe(21);
    const { game } = makeGame();
    game.clock.seconds = 24 * 3600 + 3600;
    place(game, 9, 22);
    const zed = { x: 9, y: 12 + 10, z: 0 };
    expect(creatureCanSee(game, { x: 20, y: 22, z: 0 }, game.player, 50, 3)).toBe(false);
    game.player.inv.wield(createItem(data, 'flashlight', { ammo: 'default' }), null);
    toggleLight(game);
    expect(playerLightState(game).on).toBe(true);
    expect(creatureCanSee(game, { x: 20, y: 22, z: 0 }, game.player, 50, 3)).toBe(true);
    expect(zed).toBeDefined();
  });
});

describe('bash', () => {
  it('a window breaks into a frame and glass shards; weak hits on a door do nothing', () => {
    const { game } = makeGame();
    const r = bash(game, 7, 4, 0, 10);
    expect(r.success).toBe(true);
    expect(r.sound).toBe('glass breaking!');
    expect(game.map.terAt(7, 4, 0).id).toBe('t_window_frame');
    expect(game.map.itemsAt(7, 4, 0).some((i) => i.typeId === 'glass_shard')).toBe(true);
    const weak = bash(game, 9, 12, 0, 8);
    expect(weak.didBash).toBe(true);
    expect(weak.success).toBe(false);
    expect(weak.canBash).toBe(false);
    expect(weak.sound).toBe('whump!');
  });

  it('map damage accumulates until the door gives way (CDDA damage_to / hp)', () => {
    const { game } = makeGame();
    let hits = 0;
    while (game.map.terAt(9, 12, 0).id === 't_door_c' && hits < 100) {
      const r = bash(game, 9, 12, 0, 30);
      hits++;
      if (!r.success) expect(getMapDamage(game, 9, 12, 0)).toBe(Math.floor(30 * 0.95 - 8) * hits);
    }
    // 20 damage per hit vs 80 hp → the 4th hit breaks it.
    expect(hits).toBe(4);
    expect(game.map.terAt(9, 12, 0).id).toBe('t_door_b');
  });

  it('smash ability: weapon bash + str, unarmed half str', () => {
    const { game } = makeGame();
    expect(smashAbility(game.player)).toEqual({ bash: 4 });
    game.player.inv.wield(createItem(data, 'crowbar'), null);
    expect(smashAbility(game.player).bash).toBe((data.items.crowbar.melee_damage?.bash ?? 0) + 8);
  });
});

describe('examine / doors', () => {
  it('opens and closes the house door; prompt names it', () => {
    const { game } = makeGame();
    place(game, 9, 11); // inside, south wall door at (9,12)
    game.player.yaw = Math.PI; // facing south
    game.player.pitch = 0;
    const t = targetTile(game);
    expect(t).toMatchObject({ x: 9, y: 12 });
    expect(interactionPrompt(game)).toBe('[e] Open closed wood door');
    expect(openDoor(game, 9, 12, 0)).toBeNull();
    expect(game.map.terAt(9, 12, 0).id).toBe('t_door_o');
    expect(interactionsAt(game, 9, 12, 0)[0].id).toBe('close');
    expect(closeDoor(game, 9, 12, 0)).toBeNull();
    expect(game.map.terAt(9, 12, 0).id).toBe('t_door_c');
  });

  it('curtains can only be worked from inside', () => {
    const { game } = makeGame();
    place(game, 3, 9); // outside the curtained window (4,9)
    expect(interactionsAt(game, 4, 9, 0).map((i) => i.id)).not.toContain('open');
    expect(openDoor(game, 4, 9, 0)).toMatch(/from outside/);
    place(game, 5, 9);
    const ids = interactionsAt(game, 4, 9, 0).map((i) => i.id);
    // (tests/curtains.test.ts covers curtains vs window in detail)
    expect(ids).toContain('window_open');
    expect(ids).toContain('curtains_close');
    expect(ids).toContain('tear_curtains');
  });

  it('a bed offers sleep', () => {
    const { game } = makeGame();
    place(game, 10, 9);
    expect(interactionsAt(game, 10, 10, 0).map((i) => i.id)).toContain('sleep');
    expect(comfortAt(game, 10, 10, 0).comfort).toBe(5);
  });

  it('an empty potted plant offers nothing to look in; an empty locker still does', () => {
    const { game } = makeGame();
    place(game, 10, 9);
    game.map.setFurn(11, 9, 0, 'f_indoor_plant');
    game.map.setFurn(12, 9, 0, 'f_locker');
    expect(interactionsAt(game, 11, 9, 0).map((i) => i.id)).not.toContain('pickup');
    expect(interactionsAt(game, 12, 9, 0).map((i) => i.label)).toContain('Look in the locker');
    game.map.addItem(11, 9, 0, createItem(game.data, 'rock'));
    expect(interactionsAt(game, 11, 9, 0).find((i) => i.id === 'pickup')?.label).toMatch(/^Look in the .*\(1 item\)$/);
  });
});

describe('z-levels', () => {
  it('stairs up and back down', () => {
    const { game } = makeGame();
    place(game, 30, 5);
    expect(stairDestination(game, 30, 5, 0, 'up')).toEqual({ x: 30, y: 5, z: 1 });
    expect(goStairs(game, 'up')).toBe(true);
    expect(game.player.z).toBe(1);
    expect(goStairs(game, 'up')).toBe(false);
    expect(goStairs(game, 'down')).toBe(true);
    expect(game.player.z).toBe(0);
  });

  it('walking off a roof: fall a level and get hurt', () => {
    const { game, log } = makeGame();
    place(game, 2, 2, 1); // open air above the yard
    const hp = game.player.hpPercent();
    expect(fallIfUnsupported(game)).toBe(1);
    expect(game.player.z).toBe(0);
    expect(log[0]).toBe('You fall down a level!');
    expect(game.player.hpPercent()).toBeLessThan(hp);
    place(game, 8, 8, 1); // on the flat roof
    expect(fallIfUnsupported(game)).toBe(0);
  });
});

describe('fields', () => {
  it('fire spreads through underbrush and burns out; blood decays', () => {
    const { game } = makeGame(3);
    installFields(game);
    place(game, -12, 8);
    game.map.chunk(-1, 0, 0);
    // find an underbrush tile
    // The underbrush tile with the most flammable (FLAMMABLE_ASH: trees, brush) neighbours.
    const fl = (x: number, y: number) => game.map.terAt(x, y, 0).flags.includes('FLAMMABLE_ASH');
    let sx = 0, sy = 0, best = -1;
    for (let y = 1; y < 16; y++)
      for (let x = -23; x < -1; x++) {
        if (game.map.terAt(x, y, 0).id !== 't_underbrush') continue;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (fl(x + dx, y + dy)) n++;
        if (n > best) (best = n), (sx = x), (sy = y);
      }
    expect(best).toBeGreaterThan(3);
    ignite(game, sx, sy, 0, 3);
    let maxFires = 0;
    const count = () => {
      let n = 0;
      for (const c of game.map.loadedChunks()) for (const l of c.fields.values()) if (l.some((f) => f.type === 'fd_fire')) n++;
      return n;
    };
    for (let i = 0; i < 60; i++) {
      processFields(game, 60);
      maxFires = Math.max(maxFires, count());
    }
    expect(maxFires).toBeGreaterThan(3);
    addField(game, 9, 16, 0, 'fd_blood', 3);
    processFields(game, 0, 2 * 172800 * 3);
    expect(game.map.fieldsAt(9, 16, 0).some((f) => f.type === 'fd_blood' && f.intensity === 3)).toBe(false);
  });

  it('raging fire hurts monsters (fieldDamageAt) and the player', () => {
    const { game, log } = makeGame();
    ignite(game, 9, 16, 0, 3);
    const d = fieldDamageAt(game, 9, 16, 0, { materials: ['flesh'] });
    expect(d && d.amount).toBeGreaterThanOrEqual(3 + 3);
    expect(fieldDamageAt(game, 9, 16, 0, { flags: ['FIREPROOF'] })).toBeNull();
    place(game, 9, 16);
    processFields(game, 1);
    expect(log.some((l) => /set ablaze|standing in a fire|surrounded/.test(l))).toBe(true);
  });
});

describe('weather', () => {
  it('evaluates BN weather requirements in region-list order', () => {
    // BN weather_type "requirements": strict thresholds, humidity OR pressure, °F temperatures.
    const w = { temperature: 10, humidity: 75, pressure: 1008, windpower: 3, winddirection: 0 };
    expect(weatherConditions(data, w, true)).toBe('cloudy');
    expect(weatherConditions(data, { ...w, humidity: 91, pressure: 1005 }, true)).toBe('rain');
    expect(weatherConditions(data, { ...w, temperature: -5, humidity: 91, pressure: 1005 }, true)).toBe('snowing');
    expect(weatherConditions(data, { ...w, humidity: 100, pressure: 985 }, true)).toBe('lightning');
    expect(weatherConditions(data, { ...w, humidity: 50, pressure: 1026 }, true)).toBe('sunny');
    expect(weatherConditions(data, { ...w, humidity: 50, pressure: 1026 }, false)).toBe('clear');
    expect(meetsBnRequirements({ acidic: true }, w, 'drizzle', true)).toBe(false);
    expect(evalWeatherCondition({ math: ["weather('temperature') < from_fahrenheit( 33 )"] }, { ...w, temperature: 0 }, true)).toBe(true);
  });

  it('is seasonal: winter colder than summer, and it rains sometimes', () => {
    let summer = 0, winter = 0, wet = 0, n = 0;
    for (let d = 0; d < 364; d += 1) {
      const p = weatherPoint(42, d * 86400 + 14 * 3600);
      if (d >= 91 && d < 182) summer += p.temperature;
      if (d >= 273) winter += p.temperature;
      const id = weatherConditions(data, p, true);
      if (/rain|drizzle|thunder|lightning|snow|flurries/.test(id)) wet++;
      n++;
    }
    expect(summer / 91).toBeGreaterThan(winter / 91 + 12);
    expect(wet).toBeGreaterThan(10);
    expect(wet).toBeLessThan(n * 0.8);
  });

  it('a new world starts in spring weather (BN mid-spring climate), and winter still snows', () => {
    // Playtest: "Snowstorm, -7 °C" on a green spring morning. The climate runs BN's INITIAL_DAY
    // ahead of the clock (see climateSeconds), so the first week has no snow on any seed.
    let snowFirstWeek = 0, snowWinter = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (let d = 0; d < 7; d++) {
        const id = weatherConditions(data, weatherPoint(seed, climateSeconds(d * 86400 + 8 * 3600)), true);
        if (/snow|flurries/.test(id)) snowFirstWeek++;
      }
      for (let d = 273; d < 300; d++) {
        const id = weatherConditions(data, weatherPoint(seed, climateSeconds(d * 86400 + 8 * 3600)), true);
        if (/snow|flurries/.test(id)) snowWinter++;
      }
    }
    expect(snowFirstWeek).toBe(0);
    expect(snowWinter).toBeGreaterThan(60);
    expect(climateSeconds(0)).toBe(BN_START_CLIMATE_OFFSET_DAYS * 86400);
  });

  it('rain soaks the player outdoors but not under a roof', () => {
    const { game } = makeGame();
    installWeather(game);
    forceWeather(game, 'rain');
    expect(game.weather!.rains).toBe(true);
    place(game, 9, 16);
    game.tick(1 / 30);
    expect(game.player.env.precipitation).toBe(true);
    place(game, 8, 8);
    game.tick(1 / 30);
    expect(game.player.env.precipitation).toBe(false);
    forceWeather(game, 'snow');
    expect(game.weather!.id).toBe('snowing');
  });
});

describe('wait & sleep', () => {
  it('waiting advances the clock', () => {
    const { game } = makeGame();
    place(game, 8, 8);
    const t0 = game.clock.seconds;
    expect(waitFor(game, 1800)).toBe(true);
    for (let i = 0; i < 30 * 20 && game.activities.current; i++) game.tick(1 / 30);
    expect(game.activities.current).toBeNull();
    expect(game.clock.seconds - t0).toBeGreaterThanOrEqual(1800);
  });

  it('waiting stops when you start freezing, but can be started while already freezing', () => {
    const { game, log } = makeGame();
    installRest(game);
    place(game, 8, 8);
    // Force the body-temperature target far below freezing (a bitter night, no clothes).
    const target = () => (game.player.env = { ...game.player.env, temperature: -40, wind: 0, precipitation: false });
    game.systems.push({ name: 'test-cold', update: target });
    expect(waitFor(game, 6 * 3600)).toBe(true);
    for (let i = 0; i < 30 * 120 && game.activities.current; i++) game.tick(1 / 30);
    expect(game.activities.current).toBeNull();
    expect(log).toContain('You are freezing!');
    expect(game.player.dead).toBe(false);
    // Already freezing: the wait starts (CDDA lets you ignore it) and isn't cancelled for it again.
    expect(waitFor(game, 600)).toBe(true);
    game.tick(1 / 30);
    expect(game.activities.current).not.toBeNull();
  });

  it('first cold nights: lying down on the hard ground while chilly gives bed and warmth hints, a few times only', () => {
    const { game, log } = makeGame();
    installRest(game);
    place(game, 8, 8);
    expect(comfortAt(game, 8, 8, 0).comfort).toBeLessThan(3);
    for (const bp of Object.keys(game.player.bodyTemp) as (keyof typeof game.player.bodyTemp)[]) game.player.bodyTemp[bp] = BODYTEMP.COLD - 100;
    const bed = "You'd sleep better in a bed, or with a blanket or sleeping bag.";
    const cold = "It's cold.  Find warmer clothes, or build a fire.";
    for (let i = 0; i < 5; i++) {
      game.activities.cancel('test');
      game.player.removeEffect('lying_down');
      goToSleep(game);
    }
    expect(log.filter((l) => l === bed).length).toBe(3);
    expect(log.filter((l) => l === cold).length).toBe(3);
  });

  it('being woken by shivering points at warmth', () => {
    const { game, log } = makeGame();
    installRest(game);
    place(game, 10, 10);
    game.player.sleepiness = 300;
    game.player.fallAsleep();
    // A bitter night with no clothes: the torso gets very cold and shivering wakes them.
    game.systems.push({ name: 'test-cold', update: () => (game.player.env = { ...game.player.env, temperature: -30, wind: 0, precipitation: false }) });
    for (let i = 0; i < 30 * 60 && !log.includes('Your shivering prevents you from sleeping.'); i++) game.tick(1 / 30);
    game.tick(1 / 30);
    expect(log, JSON.stringify(log)).toContain('Your shivering prevents you from sleeping.');
    expect(log.indexOf("It's cold.  Find warmer clothes, or build a fire.")).toBeGreaterThan(log.indexOf('Your shivering prevents you from sleeping.'));
  });

  it('a tired survivor falls asleep in bed and wakes rested', () => {
    const { game, log } = makeGame();
    installRest(game);
    place(game, 10, 10);
    // Tired but not so tired that BN's 10-hour night ends before fatigue reaches 25.
    game.player.sleepiness = 250;
    expect(goToSleep(game)).toBe(true);
    expect(log).toContain('This is a comfortable place to sleep.');
    let slept = false;
    for (let i = 0; i < 30 * 60 && (game.activities.current || game.player.isAsleep()); i++) {
      game.tick(1 / 30);
      slept ||= game.player.isAsleep();
    }
    expect(slept).toBe(true);
    expect(game.player.isAsleep()).toBe(false);
    expect(game.player.sleepiness).toBeLessThan(25);
    expect(log).toContain('You feel well rested.');
  });
});

describe('traps & light items', () => {
  it('bear trap snaps shut on the player', () => {
    const { game, log } = makeGame();
    installTraps(game);
    setTrap(game, 9, 16, 0, 'tr_beartrap');
    place(game, 9, 16);
    expect(triggerTrap(game, 9, 16, 0)).toBe(true);
    expect(game.player.hasEffect('beartrap')).toBe(true);
    expect(log.some((l) => /bear trap closes/.test(l))).toBe(true);
  });

  it('flashlight: F turns it on (transform), it lights the tile and drains', () => {
    const { game } = makeGame();
    game.player.inv.wield(createItem(data, 'flashlight', { ammo: 'default' }), null);
    game.clock.seconds = 24 * 3600 + 3600;
    place(game, 9, 16);
    const before = lightAt(game, 9, 16, 0);
    expect(toggleLight(game)).toBe(true);
    expect(game.player.inv.wielded!.typeId).toBe('flashlight_on');
    expect(playerLightState(game).directional).toBe(true);
    expect(lightAt(game, 9, 16, 0)).toBeGreaterThan(before + 100);
    expect(toggleLight(game)).toBe(true);
    expect(game.player.inv.wielded!.typeId).toBe('flashlight');
  });

  it('flashlight: with a dead one and a working one, F switches on the working one', () => {
    const { game } = makeGame();
    game.player.inv.wear(createItem(data, 'backpack'), null);
    const dead = createItem(data, 'flashlight'); // battery out
    game.player.inv.wield(dead, null);
    const good = createItem(data, 'flashlight', { ammo: 'default' });
    expect(game.player.inv.giveNew(good)).not.toBeNull();
    expect(canPowerOn(dead)).toBe(false);
    expect(canPowerOn(good)).toBe(true);
    expect(toggleLight(game)).toBe(true);
    expect(playerLightState(game).on).toBe(true);
    expect(good.typeId).toBe('flashlight_on');
    expect(dead.typeId).toBe('flashlight');
  });

  it("lightAt prefers the renderer's exact light map, adding only the survivor's beam", () => {
    const { game } = makeGame();
    game.clock.seconds = 24 * 3600 + 3600;
    place(game, 9, 16);
    // exact inside a small window around the player, like the renderer's light map
    game.lightProvider = (x, y) => (Math.abs(x - 9) <= 5 && Math.abs(y - 16) <= 5 ? 42 : null);
    expect(lightAt(game, 10, 16, 0)).toBe(42);
    expect(lightAt(game, 30, 16, 0)).toBeLessThan(42); // estimate outside the window
    // monster vision uses it too: at 01:00 a 40/1 vision zombie 4 tiles away only sees a lit target
    expect(lineOfSight(game.map, 9, 20, 9, 16, 0)).toBe(true);
    expect(creatureCanSee(game, { x: 9, y: 20, z: 0 }, { x: 9, y: 16, z: 0 }, 40, 1)).toBe(true);
    game.lightProvider = () => 0;
    expect(creatureCanSee(game, { x: 9, y: 20, z: 0 }, { x: 9, y: 16, z: 0 }, 40, 1)).toBe(false);
    game.lightProvider = (x, y) => (Math.abs(x - 9) <= 5 && Math.abs(y - 16) <= 5 ? 42 : null);
    game.player.inv.wield(createItem(data, 'flashlight', { ammo: 'default' }), null);
    toggleLight(game);
    expect(lightAt(game, 10, 16, 0)).toBeGreaterThan(42);
    game.lightProvider = null;
  });
});
