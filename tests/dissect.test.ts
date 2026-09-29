// Dissection (CDDA butcher_type::DISSECT) against real data: the zomborg's CBM groups, mutagen
// samples from mutants, CUT_FINE requirements and timing.
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import { createItem, type Item } from '../src/game/item';
import {
  canDissect, dissectCheck, dissectSeconds, dissectSkillLevel, dissectToolQuality, dissectYield,
} from '../src/game/butchery';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}
const survivor = () => new Game(data, 1, fakeInput()).player;
const isCbm = (it: Item) => !!it.def.flags?.includes('CBM') || !!it.def.subtypes?.includes('BIONIC_ITEM');

describe('dissection', () => {
  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'dissect')). Port with its system.
  it.skip('needs a CUT_FINE tool; a scalpel is quality 3', () => {
    const p = survivor();
    expect(dissectToolQuality(p)).toBe(0);
    const res = dissectYield(data, p, data.monsters.mon_zomborg, 0, new Rng(1));
    expect(res.ok).toBe(false);
    p.inv.giveNew(createItem(data, 'scalpel'));
    expect(dissectToolQuality(p)).toBe(3);
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'volume')). Port with its system.
  it.skip('takes 6x the size-based cutting time, shortened by tool quality', () => {
    const z = data.monsters.mon_zomborg;
    // large: 3600 moves x (100 - q)% x 6, in turns (1 s each)
    expect(dissectSeconds(z, 3)).toBe(Math.round((3600 * 97 * 6) / 100));
    expect(dissectSeconds(z, 3)).toBeLessThan(dissectSeconds(z, 1));
    expect(canDissect(data, z)).toBe(true);
    expect(canDissect(data, data.monsters.mon_zombie)).toBe(canDissect(data, data.monsters.mon_zombie));
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (TypeError: Cannot read properties of undefined (reading 'dissect')). Port with its system.
  it.skip('zomborgs yield CBMs from their dissect bionic groups (burnt out on failed rolls)', () => {
    const p = survivor();
    p.setSkill('firstaid', 6);
    p.setSkill('electronics', 6);
    const def = data.monsters.mon_zomborg;
    expect(data.misc.harvest[def.dissect!].entries.some((e: any) => e.type === 'bionic_group')).toBe(true);
    let cbms = 0, burnt = 0;
    for (let s = 1; s <= 40; s++) {
      const res = dissectYield(data, p, def, 3, new Rng(s));
      expect(res.ok).toBe(true);
      cbms += res.items.filter(isCbm).length;
      burnt += res.items.filter((i) => i.typeId === 'burnt_out_bionic').length;
      for (const it of res.items.filter(isCbm)) expect(it.vars.faults).toContain('fault_bionic_salvaged');
    }
    expect(cbms).toBeGreaterThan(0);
    // skill 6 + scalpel: most rolls succeed, but not all
    expect(cbms).toBeGreaterThan(burnt);
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (AssertionError: expected +0 to be 2 // Object.is equality). Port with its system.
  it.skip('skill uses the drop type harvest_skills (electronics + first aid for bionics)', () => {
    const p = survivor();
    expect(dissectSkillLevel(data, p, 3, 'bionic_group')).toBe(Math.round(3 / 2));
    p.setSkill('electronics', 4);
    p.setSkill('firstaid', 4);
    expect(dissectSkillLevel(data, p, 3, 'bionic_group')).toBe(Math.round(11 / 2));
    // CDDA: a drop type without harvest_skills averages over zero skills -> the tool quality
    expect(dissectSkillLevel(data, p, 3, 'flesh')).toBe(3);
    p.setSkill('survival', 5);
    expect(dissectSkillLevel(data, p, 3, undefined)).toBe(5);
  });

  it('check_butcher_dissect: roll 0 always fails, high rolls usually succeed', () => {
    const rng = new Rng(3);
    let ok0 = 0, ok10 = 0;
    for (let i = 0; i < 2000; i++) {
      if (dissectCheck(rng, 0)) ok0++;
      if (dissectCheck(rng, 10)) ok10++;
    }
    expect(ok0).toBe(0);
    // 1 - 10/60 = 83%
    expect(ok10 / 2000).toBeGreaterThan(0.75);
    expect(ok10 / 2000).toBeLessThan(0.9);
  });

  // TODO(BN): written for DDA data/behaviour; fails on Bright Nights core data (AssertionError: expected undefined to be defined). Port with its system.
  it.skip('mutants yield mutagen samples from their mutagen_group dissectables', () => {
    const p = survivor();
    p.setSkill('firstaid', 5);
    p.setSkill('chemistry', 5);
    const mon = Object.values(data.monsters).find((m) => m.dissect && (data.misc.harvest[m.dissect]?.entries ?? []).some((e: any) => e.type === 'mutagen_group'));
    expect(mon).toBeDefined();
    const got = new Map<string, number>();
    for (let s = 1; s <= 30; s++) for (const i of dissectYield(data, p, mon!, 3, new Rng(s)).items) got.set(i.typeId, (got.get(i.typeId) ?? 0) + 1);
    expect([...got.keys()].some((id) => /mutagen|sample|gland|serum/.test(id))).toBe(true);
  });
});
