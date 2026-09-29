// Mutations and bionics against the real extracted CDDA data.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Character } from '../src/game/character';
import { attachBodyMods } from '../src/game/bodymods';
import { bionicManipCos, bionicsAdjustedSkill, bionicsPlSkill, bionicSuccessChance } from '../src/game/bionics';
import { createItem, type Item } from '../src/game/item';
import { CraftingInventory } from '../src/game/crafting_inv';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { playerLight, visionThreshold, LIGHT_AMBIENT_LOW } from '../src/game/vision';
import { playerLightState } from '../src/game/lightitems';
import { installMutBio } from '../src/mutbio';
import { rollMeleeDamage } from '../src/game/combat';
import { Rng } from '../src/core/rng';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: load('recipes.json'), misc: load('misc.json'),
  };
});

function survivor(seed = 1) {
  const c = new Character(data, { seed });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  // A backpack to carry things in.
  c.inv.wear(createItem(data, 'backpack'));
  c.inv.wear(createItem(data, 'jeans'));
  const mods = attachBodyMods(c);
  return { c, log, ...mods };
}

/** A flask of mutagen, as it spawns (the liquid inside its container). */
function dose(id: string): Item {
  const it = createItem(data, id);
  return it;
}

function pass(c: Character, update: (dt: number) => void, seconds: number, step = 60): void {
  for (let t = 0; t < seconds; t += step) {
    c.update(step);
    update(step);
  }
}

const mutDef = (id: string) => (data.misc.mutation as Record<string, any>)[id];

/** Every present non-base trait's prerequisites hold and no present trait cancels another. */
function checkConsistency(traits: Set<string>, base: Set<string>): string[] {
  const problems: string[] = [];
  for (const id of traits) {
    const d = mutDef(id);
    if (!d || base.has(id)) continue;
    for (const key of ['prereqs', 'prereqs2'] as const) {
      const pre: string[] = d[key] ?? [];
      if (!pre.length) continue;
      // A prerequisite that changes_to this trait was consumed by it (SPARSE_SCALES → SCALES).
      const ok = pre.some((p) => traits.has(p) || (mutDef(p)?.changes_to ?? []).includes(id));
      if (!ok) problems.push(`${id} lacks ${key} ${pre.join('|')}`);
    }
    for (const other of d.cancels ?? []) if (traits.has(other) && !base.has(other)) problems.push(`${id} coexists with canceled ${other}`);
  }
  return problems;
}

describe('mutagen and vitamins', () => {
  it('drinking lizard mutagen adds its primer and catalyst vitamins (consume_drug vitamins)', () => {
    const { c, mut, log } = survivor();
    const r = c.inv.consume(dose('mutagen_lizard'));
    expect(r.ok).toBe(true);
    expect(mut.vitamin('mutagen_lizard')).toBe(225);
    expect(mut.vitamin('mutagen')).toBe(125);
    expect(log.join(' ')).toContain('You drink the');
    // Catalyst over 100 → mutagen sickness (vitamin excess effect).
    expect(c.hasEffect('mutagen')).toBe(true);
  });

  it('injected catalyst needs a syringe', () => {
    const { c, mut } = survivor();
    const r = c.inv.consume(dose('iv_mutagen'));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/syringe/);
    c.inv.pickUp(createItem(data, 'syringe'));
    expect(c.inv.consume(dose('iv_mutagen')).ok).toBe(true);
    expect(mut.vitamin('mutagen')).toBeGreaterThanOrEqual(750);
  });

  it('mutagenic slurry decays into catalyst, every primer and toxin (decays_into)', () => {
    const { c, mut } = survivor();
    mut.vitaminMod('mutagenic_slurry', 25);
    pass(c, (dt) => mut.update(dt), 60, 1);
    expect(mut.vitamin('mutagenic_slurry')).toBe(0);
    expect(mut.vitamin('mutagen')).toBe(25 * 8 - 0);
    expect(mut.vitamin('mutagen_lizard')).toBe(25);
    expect(mut.vitamin('mutant_toxin')).toBe(50);
  });

  it('several doses of lizard mutagen produce valid LIZARD mutations respecting prereqs and cancels', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const { c, mut, log } = survivor(seed);
      for (let i = 0; i < 4; i++) expect(c.inv.consume(dose('mutagen_lizard')).ok).toBe(true);
      pass(c, (dt) => mut.update(dt), 4 * 86400, 60);
      const gained = [...c.traits].filter((t) => !mut.isBase(t) && t !== 'CHANGING');
      expect(gained.length, `seed ${seed}: ${log.join(' | ')}`).toBeGreaterThan(0);
      for (const t of gained) {
        const cats: string[] = mutDef(t)?.category ?? [];
        expect(cats, `${t} should be a lizard mutation`).toContain('LIZARD');
        expect(mutDef(t).valid).not.toBe(false);
      }
      expect(checkConsistency(c.traits, mut.base), `seed ${seed}`).toEqual([]);
      expect(log.some((l) => /You gain a mutation called|mutation turns into/.test(l))).toBe(true);
      // The primer paid for it.
      expect(mut.vitamin('mutagen_lizard')).toBeLessThan(900);
    }
  });

  it('without catalyst there is no CHANGING, primer alone does nothing', () => {
    const { c, mut } = survivor();
    mut.vitaminMod('mutagen_lizard', 1000);
    pass(c, (dt) => mut.update(dt), 2 * 86400, 60);
    expect(c.hasTrait('CHANGING')).toBe(false);
    expect([...c.traits].filter((t) => !mut.isBase(t))).toEqual([]);
  });

  it('mutate towards a deep trait walks its prerequisite chain (SCALES via SKIN_PEELING/SPARSE_SCALES)', () => {
    const { c, mut } = survivor();
    let n = 0;
    while (!c.hasTrait('SCALES') && n++ < 10) mut.mutateTowards('SCALES', 'LIZARD', false);
    expect(c.hasTrait('SCALES')).toBe(true);
    // SPARSE_SCALES changes_to SCALES: replaced, not kept.
    expect(c.hasTrait('SPARSE_SCALES')).toBe(false);
    expect(checkConsistency(c.traits, mut.base)).toEqual([]);
    // Integrated armor is worn and protects.
    expect(c.inv.worn.some((w) => w.typeId === 'integrated_scales')).toBe(true);
  });

  it('crosses the threshold once the category level and primer are high enough', () => {
    const { c, mut, log } = survivor(9);
    const lizard = (data.misc.mutation_category as any).LIZARD;
    // Grow a lot of lizard mutations without vitamins.
    for (let i = 0; i < 80; i++) mut.mutateCategory('LIZARD', false, true);
    expect(mut.categoryLevels().get('LIZARD') ?? 0).toBeGreaterThanOrEqual(30);
    mut.vitaminMod(lizard.vitamin, 2500);
    let crossed = false;
    for (let i = 0; i < 50 && !crossed; i++) crossed = mut.tryCrossingThreshold('LIZARD');
    expect(crossed).toBe(true);
    expect(c.hasTrait('THRESH_LIZARD')).toBe(true);
    expect(mut.thresholdCategory()).toBe('LIZARD');
    expect(log.join(' ')).toContain('FREE!');
    // Only once.
    expect(mut.tryCrossingThreshold('LIZARD')).toBe(false);
  });

  it('purifier (HUMAN dummies) removes mutations step by step', () => {
    const { c, mut, log } = survivor();
    let n = 0;
    while (!c.hasTrait('FUR') && n++ < 10) mut.mutateTowards('FUR', 'URSINE', false);
    expect(c.hasTrait('FUR')).toBe(true);
    expect(c.inv.worn.some((w) => w.typeId === 'integrated_fur')).toBe(true);
    mut.vitaminMod('mutagen_human', 2000);
    for (let i = 0; i < 30 && [...c.traits].some((t) => /FUR|HIRSUTE/.test(t)); i++) mut.mutate(0, true);
    expect([...c.traits].filter((t) => /FUR/.test(t))).toEqual([]);
    expect(c.inv.worn.some((w) => w.typeId === 'integrated_fur')).toBe(false);
    expect(log.some((l) => /Your Furry mutation turns into|You lose your/.test(l))).toBe(true);
  });

  it('restricts_gear: hooves destroy boots and then block wearing them; a muzzle pushes off a mask', () => {
    const { c, mut, log } = survivor();
    const dropped: Item[] = [];
    mut.onDropItem = (it) => dropped.push(it);
    const boots = createItem(data, 'boots');
    expect(c.inv.wear(boots).ok).toBe(true);
    mut.setMutation('HOOVES');
    expect(c.inv.worn.includes(boots)).toBe(false);
    expect(log.join(' ')).toContain('is destroyed!');
    const r = c.inv.wear(createItem(data, 'boots'));
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/Hooves mutation prevents you from wearing/);
    const mask = createItem(data, 'mask_dust');
    expect(c.inv.wear(mask).ok).toBe(true);
    mut.setMutation('MUZZLE');
    expect(c.inv.worn.includes(mask)).toBe(false);
    expect(dropped).toContain(mask);
    expect(log.join(' ')).toContain('is pushed off!');
  });

  it('claws make unarmed attacks cut; night vision lowers the vision threshold', () => {
    const { c, mut } = survivor();
    const rng = new Rng(3);
    const cutBefore = rollMeleeDamage(c, null, false, rng, true).find((d) => d.type === 'cut')?.amount ?? 0;
    let n = 0;
    while (!c.hasTrait('CLAWS') && n++ < 10) mut.mutateTowards('CLAWS', 'BEAST', false);
    const cutAfter = rollMeleeDamage(c, null, false, rng, true).find((d) => d.type === 'cut')?.amount ?? 0;
    expect(cutBefore).toBe(0);
    expect(cutAfter).toBeGreaterThan(0);
    mut.setMutation('NIGHTVISION');
    expect(mut.nightVisionRange()).toBe(2);
  });

  it('saves and restores vitamins and powered mutations', () => {
    const a = survivor();
    a.mut.vitaminMod('mutagen', 300);
    a.mut.setMutation('NIGHTVISION');
    const j = JSON.parse(JSON.stringify(a.mut.toJSON()));
    const b = survivor();
    b.c.traits.add('NIGHTVISION');
    b.mut.load(j);
    expect(b.mut.vitamin('mutagen')).toBe(300);
    expect(b.mut.isPowered('NIGHTVISION')).toBe(true);
  });
});

describe('bionics', () => {
  it('success chance follows bionic_manip_cos (int 8, no skills, difficulty 1 → 41%)', () => {
    const { c } = survivor();
    expect(bionicsPlSkill(c, false)).toBe(32);
    expect(bionicsAdjustedSkill(32)).toBeCloseTo(3.2, 5);
    expect(bionicManipCos(3.2, 1)).toBe(41);
    expect(bionicSuccessChance(c, false, 1)).toBe(41);
    // skill == 4 × difficulty → 50%
    expect(bionicManipCos(8, 2)).toBe(50);
    c.setSkill('electronics', 8);
    c.setSkill('firstaid', 8);
    c.setSkill('mechanics', 8);
    expect(bionicSuccessChance(c, false, 1)).toBeGreaterThan(80);
  });

  it('installation outcomes match the success chance; failures have CDDA consequences', () => {
    const N = 1500;
    let ok = 0;
    const fails: Record<number, number> = {};
    let chance = 0;
    for (let i = 0; i < N; i++) {
      const { bio, c } = survivor(1000 + i);
      const r = bio.install('bio_power_storage');
      chance = r.chance;
      if (r.ok) {
        ok++;
        expect(bio.has('bio_power_storage')).toBe(true);
      } else {
        fails[r.failType!] = (fails[r.failType!] ?? 0) + 1;
        if (r.failType! >= 2 && r.failType! <= 3) expect(r.faulty && bio.has(r.faulty)).toBeTruthy();
        if (r.failType === 1) expect(c.pain).toBeGreaterThan(0);
      }
    }
    expect(chance).toBe(41);
    expect(ok / N).toBeGreaterThan(0.41 - 0.04);
    expect(ok / N).toBeLessThan(0.41 + 0.04);
    expect(Object.keys(fails).length).toBeGreaterThan(1);
  });

  it('installation checks slots, duplicates and requirements', () => {
    const { bio } = survivor();
    bio.add('bio_flashlight');
    expect(bio.installBlocker('bio_flashlight')).toBe('CBM is already installed.');
    expect(bio.installBlocker('bio_power_storage')).toBeNull();
    // Power storage allows dupes; the torso has 84 slots at 2 each.
    for (let i = 0; i < 42; i++) bio.add('bio_power_storage');
    expect(bio.maxPower()).toBe(4200);
    expect(bio.installBlocker('bio_power_storage')).toMatch(/Not enough space/);
  });

  it('power drains while a toggled bionic is on, and it powers down when empty', () => {
    const { bio, c, log } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_flashlight');
    bio.modPower(10);
    expect(bio.activate('bio_flashlight')).toBe(true);
    expect(bio.isActive('bio_flashlight')).toBe(true);
    pass(c, (dt) => bio.update(dt), 3600, 60);
    // act 0.5 J + 0.5 J/s for an hour = 1.8005 kJ
    expect(bio.power).toBeCloseTo(10 - 0.0005 - 1.8, 3);
    bio.power = 0.001;
    pass(c, (dt) => bio.update(dt), 60, 60);
    expect(bio.isActive('bio_flashlight')).toBe(false);
    expect(log.join(' ')).toContain('powers down');
  });

  it('power sources: metabolic interchange burns calories, the torsion ratchet charges from walking', () => {
    const { bio, c } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_metabolics');
    bio.activate('bio_metabolics');
    const kcal = c.storedKcal;
    pass(c, (dt) => bio.update(dt), 60, 1);
    expect(bio.power).toBeGreaterThan(10);
    expect(c.storedKcal).toBeLessThan(kcal);
    const r = survivor();
    r.bio.add('bio_power_storage');
    r.bio.add('bio_torsionratchet');
    r.bio.onMoved(100);
    expect(r.bio.power).toBeCloseTo(100 * 0.00625, 5);
  });

  it('enchantments: Muscle Augmentation gives +2 Str powered, -3 unpowered', () => {
    const { bio, c } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_str_enhancer');
    c.resetStats();
    expect(c.str).toBe(c.str_base - 3);
    bio.modPower(50);
    bio.activate('bio_str_enhancer');
    c.resetStats();
    expect(c.str).toBe(c.str_base + 2);
  });

  it('bionic claws are wielded while active and cannot be dropped', () => {
    const { bio, c } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_claws');
    bio.modPower(10);
    c.inv.wield(createItem(data, 'knife_combat'));
    expect(bio.activate('bio_claws')).toBe(true);
    expect(c.inv.wielded?.typeId).toBe('bio_claws_weapon');
    expect(c.inv.carried().some((it) => it.typeId === 'knife_combat')).toBe(true);
    expect(c.inv.drop(c.inv.wielded!).ok).toBe(false);
    bio.deactivate('bio_claws');
    expect(c.inv.wielded).toBeNull();
  });

  it('subdermal armor reduces damage under the clothes', () => {
    const { bio, c } = survivor();
    bio.add('bio_armor_torso');
    const out = c.inv.absorbHit('torso', [{ type: 'cut', amount: 10 }], new Rng(1));
    expect(out[0].amount).toBeLessThanOrEqual(7);
  });

  it('bio_tools satisfies crafting tool qualities', () => {
    const { bio, c } = survivor();
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('SCREW', 1)).toBe(false);
    bio.add('bio_tools');
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('SCREW', 1)).toBe(true);
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('WRENCH', 1)).toBe(true);
    expect(c.inv.hasQuality('PRY', 1)).toBe(true);
  });
});

describe('bionics in a game', () => {
  function stubInput(): any {
    return { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  }
  it('bio_flashlight toggles the player light (directional beam, LUMINATION 60)', () => {
    const game = new Game(data, 3, stubInput());
    game.map.generator = new TestGenerator();
    const mods = installMutBio(game, null);
    mods.bio.add('bio_power_storage');
    mods.bio.add('bio_flashlight');
    mods.bio.modPower(20);
    expect(playerLight(game)).toBe(0);
    mods.bio.toggle('bio_flashlight');
    expect(playerLight(game)).toBe(60);
    const s = playerLightState(game);
    expect(s.on && s.directional).toBe(true);
    mods.bio.toggle('bio_flashlight');
    expect(playerLight(game)).toBe(0);
  });

  it('bionic night vision lowers the vision threshold', () => {
    const game = new Game(data, 3, stubInput());
    game.map.generator = new TestGenerator();
    const mods = installMutBio(game, null);
    expect(visionThreshold(game, 1)).toBe(LIGHT_AMBIENT_LOW);
    mods.bio.add('bio_power_storage');
    mods.bio.add('bio_night_vision');
    mods.bio.modPower(20);
    mods.bio.toggle('bio_night_vision');
    expect(visionThreshold(game, 1)).toBeLessThan(2.5);
  });
});
