// Bash/smash audio (src/audio/bashSounds.ts, sfx.smash, src/game/bash.ts): every bash in BN's
// data plays a real sample (the pack's exact variant, or its material's), every bash description
// string is mapped to a material (or listed as deliberately generic), and the game asks for the
// sound at the bashed tile for the player and for monsters, on success and on failure.
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Soundset } from '../src/audio/soundset';
import { registerSynth } from '../src/audio/procedural';
import { bashMaterial, bashSound, DELIBERATELY_GENERIC, MATERIAL_SOUNDS, materialFromSound } from '../src/audio/bashSounds';
import { recordSfx, setSfxCatalog, sfxRequests } from '../src/audio/sfx';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { bash, playerSmash } from '../src/game/bash';
import { createItem } from '../src/game/item';

const dir = path.join(__dirname, '../public');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let ss: Soundset;
const exact = (id: string, v: string) => ss.findExact(id, v) !== null;
type Bashable = { id: string; flags?: string[]; bash?: { sound?: unknown; sound_fail?: unknown } };
let bashables: Bashable[];

beforeAll(() => {
  data = {
    terrain: load('data/terrain.json'), furniture: load('data/furniture.json'), items: load('data/items.json'),
    itemGroups: load('data/item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('data/misc.json'),
  };
  ss = Soundset.fromFile(load('audio/soundset.json'));
  registerSynth((e) => ss.add(e), exact);
  bashables = [...Object.values(data.terrain), ...Object.values(data.furniture)].filter((d) => d.bash) as Bashable[];
});
afterEach(() => {
  recordSfx(false);
  setSfxCatalog(null);
});

describe('bash sound mapping', () => {
  it('every material names a sample that exists exactly (pack or synth)', () => {
    for (const [m, s] of Object.entries(MATERIAL_SOUNDS)) {
      expect(exact(...s.success), `${m} success ${s.success}`).toBe(true);
      expect(exact(...s.fail), `${m} fail ${s.fail}`).toBe(true);
    }
  });

  it('every bash description in BN data maps to a material or is deliberately generic', () => {
    const strings = new Set<string>();
    for (const d of bashables) for (const s of [d.bash!.sound, d.bash!.sound_fail]) if (typeof s === 'string') strings.add(s);
    expect(strings.size).toBeGreaterThan(80);
    const unmapped = [...strings].filter((s) => !materialFromSound(s) && !DELIBERATELY_GENERIC.includes(s));
    expect(unmapped).toEqual([]);
  });

  it('every bashable terrain/furniture resolves to a real sound for a break and a blow', () => {
    const generic: string[] = [];
    for (const d of bashables) {
      const m = bashMaterial(d);
      if (m === 'other') {
        generic.push(d.id);
        expect(DELIBERATELY_GENERIC, d.id).toContain(String(d.bash!.sound ?? d.bash!.sound_fail));
      }
      for (const success of [true, false]) {
        const [id, v] = bashSound(exact, d.id, m, success);
        expect(exact(id, v), `${d.id} ${success} -> ${id}/${v}`).toBe(true);
      }
    }
    expect(generic.length).toBeLessThan(5);
  });

  it('doors, windows, walls, fences, furniture: the sounds you would expect', () => {
    const t = data.terrain as Record<string, Bashable>, f = data.furniture as Record<string, Bashable>;
    const snd = (d: Bashable, ok: boolean) => bashSound(exact, d.id, bashMaterial(d), ok).join('/');
    // the pack's own recordings where it has them
    expect(snd(t.t_door_c, false)).toBe('smash_fail/t_door_c');
    expect(snd(t.t_door_c, true)).toBe('smash_success/t_door_c');
    expect(snd(t.t_window_domestic, true)).toBe('smash_success/t_window_domestic');
    // doors the pack doesn't name sound like doors, not a synthesized thud
    expect(snd(t.t_door_o, false)).toBe('smash_fail/t_door_c');
    expect(snd(t.t_door_white_o, true)).toBe('smash_success/t_door_c');
    expect(snd(t.t_door_metal_c, false)).toBe('smash_fail/f_locker');
    // glass
    expect(bashMaterial(t.t_door_glass_c)).toBe('glass');
    expect(bashMaterial(t.t_tempered_glass_with_curtain)).toBe('window');
    // walls, fences
    expect(bashMaterial(t.t_brick_wall)).toBe('brick');
    expect(bashMaterial(t.t_concrete_wall)).toBe('concrete');
    expect(bashMaterial(t.t_wall)).toBe('wall');
    expect(bashMaterial(t.t_chainfence)).toBe('chain_link');
    expect(bashMaterial(t.t_fence)).toBe('wood');
    // furniture and soft things
    expect(bashMaterial(f.f_dresser)).toBe('wood');
    expect(bashMaterial(f.f_toilet)).toBe('ceramic');
    expect(bashMaterial(f.f_fridge)).toBe('metal');
    expect(bashMaterial(f.f_canvas_wall)).toBe('soft');
    expect(bashMaterial(t.t_door_curtain_c)).toBe('soft');
  });
});

describe('bash plays its sound at the tile', () => {
  const makeGame = () => {
    const input = { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
    const game = new Game(data, 7, input as never);
    game.map.generator = new TestGenerator();
    setSfxCatalog(exact);
    recordSfx(true);
    return game;
  };

  it('a failed blow on a door (the "whump!") and the blow that breaks it both sound', () => {
    const game = makeGame();
    const weak = bash(game, 9, 12, 0, 8);
    expect(weak.sound).toBe('whump!');
    expect(sfxRequests.at(-1)).toMatchObject({ id: 'smash_fail', variant: 't_door_c', pos: { x: 9.5, y: 12.5, z: 0 } });
    const hard = bash(game, 9, 12, 0, 1000);
    expect(hard.success).toBe(true);
    expect(sfxRequests.at(-1)).toMatchObject({ id: 'smash_success', variant: 't_door_c', pos: { x: 9.5, y: 12.5, z: 0 } });
  });

  it('the player smashing (X / a melee swing) with a bat: every "whump!" message has a sound', () => {
    const game = makeGame();
    const log: string[] = [];
    game.events.on('message', (m) => log.push(m.text));
    game.player.x = 9.5;
    game.player.y = 11.5;
    game.player.inv.wield(createItem(game.data, 'bat'), null);
    const r = playerSmash(game, { x: 9, y: 12, z: 0, dist: 1 });
    expect(r?.didBash).toBe(true);
    expect(log.at(-1)).toMatch(/whump!|smash the/);
    expect(sfxRequests.filter((s) => s.id.startsWith('smash')).length).toBe(1);
  });

  it('breaking a window plays glass, a monster bashing plays at the target too', () => {
    const game = makeGame();
    const win = bash(game, 4, 9, 0, 1000);
    expect(win.success).toBe(true);
    expect(sfxRequests.at(-1)).toMatchObject({ id: 'smash_success', variant: 't_window_domestic', pos: { x: 4.5, y: 9.5 } });
    bash(game, 7, 4, 0, 1, { source: { name: 'zombie' } });
    expect(sfxRequests.at(-1)?.pos).toMatchObject({ x: 7.5, y: 4.5 });
    expect(sfxRequests.at(-1)?.id).toBe('smash_fail');
  });

  it('silent bashes (explosions carry their own sound) stay silent', () => {
    const game = makeGame();
    bash(game, 9, 12, 0, 8, { silent: true });
    expect(sfxRequests.length).toBe(0);
  });
});
