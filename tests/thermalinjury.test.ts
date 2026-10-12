import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Character } from '../src/game/character';
import { attachBodyMods } from '../src/game/bodymods';
import { createItem } from '../src/game/item';
import { frostbiteRate, updateThermalInjuries, thermalFireArmor } from '../src/game/thermalinjury';
const dir = path.join(__dirname, '../public/data');
const load = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const data: GameData = { terrain: {}, furniture: {}, items: load('items.json'), itemGroups: {}, monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json') };
const survivor = () => new Character(data, { seed: 3 });

describe('BN thermal injuries', () => {
  it('matches frostbite risk zones and caps low-risk exposure at frostnip', () => {
    expect(frostbiteRate(20, 0, true)).toBe(3);
    expect(frostbiteRate(0, 0, true)).toBe(8);
    expect(frostbiteRate(-20, 20, true)).toBe(72);
    expect(frostbiteRate(-40, 20, false)).toBe(-3);
    const c = survivor();
    c.env.temperature = -7;
    c.bodyTemp.arm_l = 30;
    updateThermalInjuries(c, 3600);
    expect(c.frostbiteTimers.hand_l).toBe(2000);
    expect(c.effects.get('frostbite', 'hand_l')?.intensity).toBe(1);
    updateThermalInjuries(c, 3600);
    expect(c.frostbiteTimers.hand_l).toBe(2000);
  });
  it('severe frostbite persists, recovers through defrosting, and survives save/load', () => {
    const c = survivor();
    c.env = { temperature: -29, wind: 40, precipitation: false };
    c.bodyTemp.arm_l = 25;
    updateThermalInjuries(c, 60);
    expect(c.frostbiteTimers.hand_l).toBe(4200);
    expect(c.effects.get('frostbite', 'hand_l')?.intensity).toBe(2);
    const again = survivor();
    again.load(JSON.parse(JSON.stringify(c.toJSON())));
    expect(again.frostbiteTimers).toEqual(c.frostbiteTimers);
    expect(again.effects.get('frostbite', 'hand_l')?.intensity).toBe(2);
    again.env.temperature = 20;
    again.bodyTemp.arm_l = 37;
    updateThermalInjuries(again, 300);
    expect(again.effects.get('frostbite', 'hand_l')?.intensity).toBe(1);
    expect(again.effects.has('frostbite_recovery', 'hand_l')).toBe(true);
    updateThermalInjuries(again, 1200);
    expect(again.effects.has('frostbite', 'hand_l')).toBe(false);
    expect(again.effects.has('frostbite_recovery', 'hand_l')).toBe(false);
  });
  it('dry winter gloves prevent frostnip at a low-risk temperature', () => {
    const bare = survivor(), clothed = survivor();
    expect(clothed.inv.wear(createItem(data, 'gloves_winter'), null).ok).toBe(true);
    for (const c of [bare, clothed]) { c.env.temperature = -7; c.bodyTemp.arm_l = 30; updateThermalInjuries(c, 700); }
    expect(bare.effects.has('frostbite', 'hand_l')).toBe(true);
    expect(clothed.effects.has('frostbite', 'hand_l')).toBe(false);
    clothed.wetness.arm_l = 1;
    updateThermalInjuries(clothed, 700);
    expect(clothed.effects.has('frostbite', 'hand_l')).toBe(true);
  });
  it('permanent frostbite preserves severity and messages across effect ticks and warm recovery', () => {
    const c = survivor(), split = survivor();
    const messages: string[] = [];
    c.onMessage = (msg) => messages.push(msg);
    for (const actor of [c, split]) {
      actor.env = { temperature: -29, wind: 40, precipitation: false };
      actor.bodyTemp.arm_l = 25;
    }
    updateThermalInjuries(c, 60);
    for (let i = 0; i < 60; i++) updateThermalInjuries(split, 1);
    expect(split.frostbiteTimers).toEqual(c.frostbiteTimers);
    expect(c.effects.get('frostbite', 'hand_l')?.permanent).toBe(true);
    for (let i = 0; i < 30; i++) c.update(1);
    expect(c.effects.get('frostbite', 'hand_l')?.intensity).toBe(2);
    expect(messages.filter((m) => /is frostbitten/.test(m))).toHaveLength(1);
    c.env.temperature = 20;
    c.bodyTemp.arm_l = 37;
    c.update(300);
    expect(c.effects.get('frostbite', 'hand_l')?.intensity).toBe(1);
    expect(c.effects.get('frostbite_recovery', 'hand_l')?.permanent).toBe(true);
  });
  it('sustained radiant heat deals identical injuries in split and bulk character turns', () => {
    const bulk = survivor(), split = survivor();
    const messages: string[] = [];
    bulk.onMessage = (msg) => messages.push(msg);
    for (const c of [bulk, split]) { c.env.temperature = 20; c.env.heatRadiationF = 120; }
    bulk.update(60);
    for (let i = 0; i < 60; i++) split.update(1);
    expect(bulk.hp).toEqual(split.hp);
    expect(bulk.pain).toBe(split.pain);
    expect(bulk.hp.torso.cur).toBeLessThan(bulk.hp.torso.max);
    expect(bulk.effects.get('blisters', 'torso')?.duration).toBe(split.effects.get('blisters', 'torso')?.duration);
    expect(messages.filter((m) => /blistering/.test(m))).toHaveLength(6);
  });
  it('nearby fire accelerates thawing without changing the frostbite cold threshold', () => {
    const c = survivor();
    c.frostbiteTimers.hand_l = 4000;
    c.bodyTemp.arm_l = 34;
    c.env.temperature = 20;
    c.env.heatRadiationF = 10;
    updateThermalInjuries(c, 100);
    expect(c.frostbiteTimers.hand_l).toBe(3200); // 3 natural + 5 radiant timer points/s.
  });
  it('sealed Nomex/Kevlar equipment and an active thermal dissipation CBM protect from blisters', () => {
    const c = survivor();
    expect(c.inv.wear(createItem(data, 'gloves_fsurvivor'), null).ok).toBe(true);
    expect(thermalFireArmor(c, 'hand_l')).toBe(12);
    const { bio } = attachBodyMods(c);
    bio.add('bio_heatsink');
    expect(bio.activate('bio_heatsink', true)).toBe(true);
    c.env.heatRadiationF = 120;
    updateThermalInjuries(c, 1);
    expect(c.effects.has('blisters', 'torso')).toBe(false);
    bio.deactivate('bio_heatsink', true);
    updateThermalInjuries(c, 1);
    expect(c.effects.has('blisters', 'torso')).toBe(true);
  });
  it('radiant fire heat causes blisters, ambient hot air alone does not, protection prevents them', () => {
    const c = survivor();
    c.env.temperature = 50;
    updateThermalInjuries(c, 1);
    expect(c.effects.has('blisters', 'torso')).toBe(false);
    c.env.heatRadiationF = 120;
    updateThermalInjuries(c, 1);
    expect(c.effects.has('blisters', 'torso')).toBe(true);
    const protectedSurvivor = survivor();
    protectedSurvivor.inv.naturalArmor.push(() => 10);
    expect(thermalFireArmor(protectedSurvivor, 'torso')).toBe(10);
    protectedSurvivor.env.heatRadiationF = 120;
    updateThermalInjuries(protectedSurvivor, 1);
    expect(protectedSurvivor.effects.has('blisters', 'torso')).toBe(false);
  });
});
