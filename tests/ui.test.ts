import { describe, expect, it } from 'vitest';
import type { MutationDef } from '../src/data/types';
import {
  bar, durationText, hpBar, hungerColor, kg, liters, logLine, MessageLog, moraleFace, painColor, randomName, staminaBar,
  tempColor, thirstColor, fit,
} from '../src/ui/format';
import {
  canAddTrait, finishCheck, multiPool, permittedProfessions, statPointsUsed, statStepCost, traitPointsUsed, traitsConflict,
  type ProfessionDef, type ScenarioDef,
} from '../src/ui/chargen_logic';
import { stampTombstone } from '../src/ui/death';
import { GameStats } from '../src/game/stats';
import { DEFAULT_BINDINGS } from '../src/ui/keys';
import { MENU_ACTIONS } from '../src/ui/keymap';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

describe('CDDA bars (output.cpp get_bar / get_hp_bar)', () => {
  it('full HP is five green pipes', () => {
    expect(hpBar(84, 84)).toEqual({ text: '|||||', color: 'c_green' });
  });
  it('uses a backslash for an extra half pipe and walks the color ramp', () => {
    expect(hpBar(50, 100)).toEqual({ text: '||\\', color: 'c_yellow' });
    expect(hpBar(30, 100).color).toBe('c_light_red');
    expect(hpBar(10, 100)).toEqual({ text: '\\', color: 'c_red' });
  });
  it('nearly empty shows ":" and zero (broken limb) shows dashes', () => {
    expect(bar(1, 100).text).toBe(':');
    expect(hpBar(0, 84)).toEqual({ text: '-----', color: 'c_light_gray' });
  });
  it('stamina uses the cyan ramp', () => {
    expect(staminaBar(8500, 8500)).toEqual({ text: '|||||', color: 'c_cyan' });
    expect(staminaBar(0, 8500).text).toBe('-----');
  });
});

describe('need colors (display.cpp)', () => {
  it('maps hunger/thirst/temperature/pain to BN colors', () => {
    expect(hungerColor('Famished')).toBe('c_light_red');
    expect(hungerColor('Sated')).toBe('c_green');
    expect(hungerColor('Engorged')).toBe('c_pink');
    expect(thirstColor('Very Thirsty')).toBe('c_yellow');
    expect(thirstColor('Parched')).toBe('c_light_red');
    expect(thirstColor('Thirsty')).toBe('c_yellow');
    expect(tempColor('Freezing!')).toBe('c_blue');
    expect(tempColor('Comfortable')).toBe('c_green');
    expect(painColor(0)).toBe('c_white');
    expect(painColor(45)).toBe('c_light_red');
    expect(painColor(60)).toBe('c_red');
  });
  it('picks the first mood face at or below morale', () => {
    expect(moraleFace(0)).toContain(':|');
    expect(moraleFace(55)).toContain(':D');
    expect(moraleFace(-500)).toContain('D8');
  });
});

describe('formatting', () => {
  it('kg / L with two decimals, durations in words, fixed-width columns', () => {
    expect(kg(1450)).toBe('1.45');
    expect(liters(520)).toBe('0.52');
    expect(durationText(59)).toBe('59 seconds');
    expect(durationText(3600 + 120)).toBe('1 hour and 2 minutes');
    expect(durationText(86400 * 2 + 3600)).toBe('2 days and 1 hour');
    expect(fit('abcdef', 4)).toBe('abc…');
    expect(fit('ab', 4)).toBe('ab  ');
  });
});

describe('MessageLog', () => {
  it('collapses identical consecutive messages into "x2"', () => {
    const log = new MessageLog();
    log.add('You feel hungry.', 'c_yellow', 0);
    log.add('You feel hungry.', 'c_yellow', 1);
    log.add('You hear a noise.', undefined, 2);
    log.add('You feel hungry.', 'c_yellow', 3);
    expect(log.entries.map(logLine)).toEqual(['You feel hungry. x2', 'You hear a noise.', 'You feel hungry.']);
    expect(log.recent(1)[0].time).toBe(3);
  });
  it('drops the oldest past capacity', () => {
    const log = new MessageLog(3);
    for (let i = 0; i < 5; i++) log.add(`m${i}`, undefined, i);
    expect(log.entries.map((e) => e.text)).toEqual(['m2', 'm3', 'm4']);
  });
});

describe('randomName', () => {
  const names = { male: ['John'], female: ['Jane'], family: ['Doe'] };
  it('uses a gendered given name and a family name', () => {
    expect(randomName(names, true, () => 0)).toBe('John Doe');
    expect(randomName(names, false, () => 0.99)).toBe('Jane Doe');
  });
  it('fails loudly on empty lists', () => {
    expect(() => randomName({ male: [], female: [], family: [] }, true)).toThrow();
  });
});

const T = (id: string, points: number, extra: Partial<MutationDef> = {}): MutationDef => ({ id, name: id, points, starting_trait: true, ...extra });
const defs: Record<string, MutationDef> = Object.fromEntries(
  [
    T('QUICK', 5), T('FASTHEALER', 2), T('SLOWHEALER', -2, { types: ['HEALING'] }), T('FASTHEALER2', 2, { types: ['HEALING'] }),
    T('TOUGH', 2), T('FLIMSY', -4, { cancels: ['TOUGH'] }), T('BADBACK', -3), T('FLIMSY3', -8), T('GOODHEARING', 1), T('BIG', 6), T('BIGGER', 6),
  ].map((d) => [d.id, d]),
);

describe('character creation point pools (newcharacter.cpp multi_pool)', () => {
  const base = { str: 8, dex: 8, int: 8, per: 8 };
  it('starts with 6 stat points, 0 trait and 2 skill points; lower pools borrow from higher ones', () => {
    const p = multiPool(statPointsUsed(base), 0, 0);
    expect(p).toMatchObject({ pureStat: 6, pureTrait: 0, pureSkill: 2, statLeft: 6, traitLeft: 6, skillLeft: 8 });
  });
  it('stats above 12 cost double', () => {
    expect(statPointsUsed({ ...base, str: 14 })).toBe(32 + 6 + 2);
    expect(statStepCost(11)).toBe(1);
    expect(statStepCost(12)).toBe(2);
  });
  it('traits from the scenario/profession are free', () => {
    expect(traitPointsUsed(['QUICK', 'TOUGH'], new Set(['QUICK']), defs)).toBe(2);
  });
  it('the stat pool cannot borrow: overspent stats stay unfinishable even with negative traits', () => {
    const over = multiPool(statPointsUsed({ str: 12, dex: 12, int: 8, per: 8 }), 0, 0);
    expect(over.statLeft).toBe(-2);
    expect(finishCheck(over).ok).toBe(false);
    const withBad = multiPool(statPointsUsed({ str: 12, dex: 12, int: 8, per: 8 }), traitPointsUsed(['BADBACK'], new Set(), defs), 0);
    expect(finishCheck(withBad).ok).toBe(false);
  });
  it('negative traits fund positive traits and skills', () => {
    const p = multiPool(38, traitPointsUsed(['BADBACK', 'TOUGH'], new Set(), defs), 0);
    expect(p).toMatchObject({ statLeft: 0, traitLeft: 1, skillLeft: 3 });
    expect(finishCheck(p).ok).toBe(true);
  });
  it('profession/scenario points come out of the skill pool', () => {
    const p = multiPool(statPointsUsed(base), 0, 5);
    expect(p.skillLeft).toBe(3);
  });
});

describe('trait selection rules', () => {
  const pools = multiPool(32, 0, 0);
  it('rejects conflicts via cancels and shared types', () => {
    expect(traitsConflict(defs.FLIMSY, defs.TOUGH)).toBe(true);
    expect(traitsConflict(defs.SLOWHEALER, defs.FASTHEALER2)).toBe(true);
    expect(canAddTrait('FLIMSY', new Set(['TOUGH']), new Set(), defs, pools).ok).toBe(false);
    expect(canAddTrait('GOODHEARING', new Set(['TOUGH']), new Set(), defs, pools).ok).toBe(true);
  });
  it('caps positive and negative traits at 12 points each', () => {
    const r = canAddTrait('QUICK', new Set(['BIG', 'BIGGER']), new Set(), defs, multiPool(32, 12, 0));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/12 points of advantages/);
    expect(canAddTrait('BADBACK', new Set(['FLIMSY3', 'FLIMSY']), new Set(), defs, pools).reason).toMatch(/disadvantages/);
  });
  it('needs enough points for positive traits; negative traits are always affordable', () => {
    const broke = multiPool(38, 0, 0); // every stat point spent
    expect(canAddTrait('QUICK', new Set(), new Set(), defs, broke).reason).toBe('Not enough points left.');
    expect(canAddTrait('BADBACK', new Set(), new Set(), defs, broke).ok).toBe(true);
  });
  it('respects scenario-forbidden traits', () => {
    expect(canAddTrait('QUICK', new Set(), new Set(), defs, pools, new Set(['QUICK'])).ok).toBe(false);
  });
});

describe('permittedProfessions', () => {
  const profs: Record<string, ProfessionDef> = {
    unemployed: { id: 'unemployed', name: 'Survivor', points: 0 },
    cop: { id: 'cop', name: 'Police Officer', points: 2 },
    naked: { id: 'naked', name: 'Naked and Afraid', points: -1 },
    lab: { id: 'lab', name: 'Lab Tech', points: 0, flags: ['SCEN_ONLY'] },
    hobby: { id: 'hobby', name: 'Hobby', subtype: 'hobby' },
  };
  it('lists all non-hobby, non-SCEN_ONLY professions with Survivor first when the scenario has no list', () => {
    const ids = permittedProfessions({ id: 'evacuee', name: 'Evacuee' } as ScenarioDef, profs).map((p) => p.id);
    expect(ids[0]).toBe('unemployed');
    expect(ids).toEqual(['unemployed', 'naked', 'cop']);
  });
  it('restricts to the scenario list, or adds to the defaults with add_professions', () => {
    expect(permittedProfessions({ id: 's', name: 's', professions: ['lab', 'naked'] }, profs).map((p) => p.id)).toEqual(['lab', 'naked']);
    const add = permittedProfessions({ id: 's', name: 's', professions: ['lab'], add_professions: true }, profs).map((p) => p.id);
    expect(add.slice(0, 2)).toEqual(['lab', 'unemployed']);
    expect(add).toContain('cop');
  });
});

describe('death screen', () => {
  it("stamps end_screen added_info onto the tombstone at CDDA's [x, y]", () => {
    const pic = ['+--------+', '|        |', '|        |', '<color_green>%%</color>'];
    const out = stampTombstone(pic, [[[1, 1], 'RIP <u_name>'], [[1, 3], 'ignored on tagged rows']], { u_name: 'Bob' });
    expect(out[1]).toBe('|RIP Bob |');
    expect(out[2]).toBe('|        |');
    expect(out[3]).toBe(pic[3]);
  });
  it('slides a long value left so it stays inside the stone, clipping only if it must', () => {
    const pic = ['|              |', '|              |'];
    const out = stampTombstone(pic, [[[6, 0], 'Kills: <k>'], [[6, 1], '<t>']], { k: '12345', t: 'a very long survival time' });
    expect(out[0]).toBe('| Kills: 12345 |');
    expect(out[0].length).toBe(pic[0].length);
    expect(out[0].endsWith('|')).toBe(true);
    expect(out[1].length).toBe(pic[1].length);
    expect(out[1].endsWith('|')).toBe(true);
  });
});

describe('GameStats', () => {
  it('counts kills by monster and round-trips through JSON', () => {
    const s = new GameStats();
    s.addKill('mon_zombie');
    s.addKill('mon_zombie');
    s.addKill('mon_zombie_dog');
    s.distanceWalked = 12.5;
    expect(s.totalKills()).toBe(3);
    const t = new GameStats();
    t.load(s.toJSON());
    expect(t.kills).toEqual({ mon_zombie: 2, mon_zombie_dog: 1 });
    expect(t.distanceWalked).toBe(12.5);
  });
});

describe('key bindings (src/ui/keys.ts is the single source)', () => {
  const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : f.endsWith('.ts') ? [join(d, f)] : []));
  const src = walk(join(__dirname, '..', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
  it('no key is bound twice, and none collides with movement (WASD, Space, Shift)', () => {
    const seen = new Map<string, string>();
    for (const [id, keys] of Object.entries(DEFAULT_BINDINGS)) {
      // Menu-only actions (close_menu = Space) have their own scope: tests/keymap.test.ts.
      if (MENU_ACTIONS.has(id)) continue;
      for (const k of keys) {
        expect(seen.get(k), `${k}: ${id} vs ${seen.get(k)}`).toBeUndefined();
        seen.set(k, id);
        expect(['w', 'a', 's', 'd', ' ', 'Shift'], `${id} uses a movement key`).not.toContain(k);
      }
    }
  });
  it('every binding in the table is registered by some system (so ? help lists exactly the table)', () => {
    for (const id of Object.keys(DEFAULT_BINDINGS)) expect(src.includes(`keys.register('${id}'`) || src.includes(`this.register('${id}'`), id).toBe(true);
  });
});
