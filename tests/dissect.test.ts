// Dissection (BN butcher_type::DISSECT) against real Bright Nights data: implants hidden in
// corpses by their harvest's bionic / bionic_group entries, CUT_FINE requirements and timing.
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import { createItem, type Item } from '../src/game/item';
import {
  butcherYield, canDissect, corpseDissectables, dissectCheck, dissectSeconds, dissectSkillLevel, dissectToolQuality, dissectYield,
} from '../src/game/butchery';
import { loadNodeData } from '../tools/lib/node_data';

const { game: data } = loadNodeData();

function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}
const survivor = () => new Game(data, 1, fakeInput()).player;
const isCbm = (it: Item) => !!it.def.subtypes?.includes('BIONIC_ITEM');

describe('dissection (BN butcher_type::DISSECT)', () => {
  it('needs a CUT_FINE tool; a scalpel is quality 3', () => {
    const p = survivor();
    expect(dissectToolQuality(p)).toBe(0);
    const res = dissectYield(data, p, data.monsters.mon_zombie_bio_op, 0, new Rng(1));
    expect(res.ok).toBe(false);
    p.inv.giveNew(createItem(data, 'scalpel'));
    expect(dissectToolQuality(p)).toBe(3);
  });

  it('takes 4x the size cutting time, scaled by the CUT_FINE tool factor', () => {
    const z = data.monsters.mon_zombie_bio_op;
    // medium: 45000 moves x 4 = 1800 s; scalpel (3) factor 1; a knife (1): 2q^3-10q^2+32q-60 = -36 -> 0.64
    expect(dissectSeconds(z, 3)).toBe(1800);
    expect(dissectSeconds(z, 1)).toBe(Math.round(1800 / 0.64));
    expect(dissectSeconds(z, 5)).toBe(900);
    // BN dissects any corpse with a harvest; exempt ones (boomers) have nothing.
    expect(canDissect(data, z)).toBe(true);
    expect(canDissect(data, data.monsters.mon_zombie)).toBe(true);
    expect(canDissect(data, data.monsters.mon_boomer)).toBe(false);
  });

  it('implants are rolled into the corpse at death and recovered with x_in_y(roll, 10)', () => {
    const p = survivor();
    p.setSkill('firstaid', 6);
    p.setSkill('electronics', 6);
    const def = data.monsters.mon_zombie_scientist;
    expect((data.misc.harvest[def.harvest!].entries as { type: string }[]).some((e) => e.type === 'bionic_group')).toBe(true);
    let cbms = 0, burnt = 0;
    for (let s = 1; s <= 40; s++) {
      const hidden = corpseDissectables(data, def, new Rng(s));
      const res = dissectYield(data, p, def, 3, new Rng(s), 0, hidden);
      expect(res.ok).toBe(true);
      cbms += res.items.filter((i) => isCbm(i) && i.typeId !== 'burnt_out_bionic').length;
      burnt += res.items.filter((i) => i.typeId === 'burnt_out_bionic').length;
      // Recovered CBMs keep the harvest entry's non-sterile fault.
      for (const it of res.items.filter((i) => isCbm(i) && i.typeId !== 'burnt_out_bionic')) expect(String(it.vars.faults)).toContain('fault_bionic_nonsterile');
    }
    expect(cbms).toBeGreaterThan(0);
    // skill 3 + 3 + scalpel 3 = 9: most rolls succeed, but not all
    expect(cbms).toBeGreaterThan(burnt);
  });

  it('skill is first aid / 2 + electronics / 2 + CUT_FINE', () => {
    const p = survivor();
    expect(dissectSkillLevel(p, 3)).toBe(3);
    p.setSkill('electronics', 5);
    p.setSkill('firstaid', 4);
    expect(dissectSkillLevel(p, 3)).toBe(2 + 2 + 3);
  });

  it('check_butcher_cbm: 10% per point of roll', () => {
    const rng = new Rng(3);
    let ok1 = 0, ok8 = 0, ok10 = 0;
    for (let i = 0; i < 4000; i++) {
      if (dissectCheck(rng, 1)) ok1++;
      if (dissectCheck(rng, 8)) ok8++;
      if (dissectCheck(rng, 10)) ok10++;
    }
    expect(ok1 / 4000).toBeCloseTo(0.1, 1);
    expect(ok8 / 4000).toBeCloseTo(0.8, 1);
    expect(ok10).toBe(4000);
  });

  it('butchering an implanted corpse only finds traces; zombie pheromones need dissection', () => {
    const p = survivor();
    const def = data.monsters.mon_zombie;
    const butchered = butcherYield(data, p, def, 3, 'full', new Rng(4));
    expect(butchered.items.some((i) => i.typeId === 'pheromone')).toBe(false);
    p.setSkill('firstaid', 8);
    p.setSkill('electronics', 8);
    let found = 0;
    for (let s = 1; s <= 20; s++) {
      const res = dissectYield(data, p, def, 3, new Rng(s), 0, corpseDissectables(data, def, new Rng(s)));
      found += res.items.filter((i) => i.typeId === 'pheromone').length;
    }
    expect(found).toBeGreaterThan(10);
  });
});
