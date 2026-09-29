// Mutations and bionics against the real extracted Bright Nights data.
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
  c.inv.wear(createItem(data, 'backpack'), null);
  c.inv.wear(createItem(data, 'jeans'), null);
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

const catOf = (id: string): string[] => mutDef(id)?.category ?? [];
/** Traits in `cat` plus everything a trait of `cat` needs on its way (BN mutate_towards walks prerequisites of any category). */
function inCategoryTree(cat: string): Set<string> {
  const out = new Set<string>();
  const walk = (id: string) => {
    if (out.has(id)) return;
    out.add(id);
    const d = mutDef(id);
    for (const p of [...(d?.prereqs ?? []), ...(d?.prereqs2 ?? [])]) walk(p);
  };
  for (const [id, d] of Object.entries(data.misc.mutation as Record<string, any>)) if ((d.category ?? []).includes(cat)) walk(id);
  return out;
}

describe('mutagen (BN mutagen_actor / mutagen_iv_actor)', () => {
  it('drinking lizard mutagen mutates towards LIZARD, says the category message and costs nutrition', () => {
    let gainedAny = 0;
    const tree = inCategoryTree('LIZARD');
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const { c, mut, log } = survivor(seed);
      const kcal = c.storedKcal, thirst = c.thirst, tired = c.sleepiness;
      // The use action alone (drinking also quenches: that part is the item model's).
      mut.useMutagen(dose('mutagen_lizard'), { type: 'mutagen', mutation_category: 'LIZARD' });
      // mutation_category LIZARD mutagen_message.
      expect(log.join(' ')).toContain('For a heartbeat, your blood cools down.');
      // mutagen_hunger/thirst/fatigue defaults 10/10/5 per mutation (one: not is_strong);
      // mod_stored_nutr(10) = round(10 × 2500 / 288) = 87 kcal.
      expect(kcal - c.storedKcal).toBe(87);
      expect(c.thirst - thirst).toBe(10);
      expect(c.sleepiness - tired).toBe(5);
      const gained = [...c.traits].filter((t) => !mut.isBase(t));
      for (const t of gained) expect(tree.has(t), `${t} is on a LIZARD path`).toBe(true);
      if (gained.length) gainedAny++;
    }
    expect(gainedAny).toBeGreaterThan(3);
    // Drinking runs the use action (BN Character::eat invokes it).
    const { c, log } = survivor(1);
    expect(c.inv.consume(dose('mutagen_lizard'), null).ok).toBe(true);
    expect(log.join(' ')).toContain('For a heartbeat, your blood cools down.');
  });

  it('serums need a syringe (comestible tool) and give several mutations', () => {
    const { c, mut, log } = survivor(4);
    const r = c.inv.consume(dose('iv_mutagen_lizard'), null);
    expect(r.ok).toBe(false);
    expect(r.msg).toBe('You need a syringe to consume that!');
    c.inv.giveNew(createItem(data, 'syringe'));
    const kcal = c.storedKcal;
    expect(c.inv.consume(dose('iv_mutagen_lizard'), null).ok).toBe(true);
    expect(log.join(' ')).toContain('Your blood cools down.  The feeling is… different.');
    // iv_min_mutations 1 + up to 2 more (each unless one_in(3)); iv_hunger 10 → 100 kcal each.
    const spent = kcal - c.storedKcal;
    expect([100, 200, 300]).toContain(spent);
    expect([...c.traits].filter((t) => !mut.isBase(t)).length).toBeGreaterThan(0);
  });

  it('several doses produce valid LIZARD mutations respecting prereqs and cancels', () => {
    const tree = inCategoryTree('LIZARD');
    for (const seed of [1, 2, 3, 4, 5]) {
      const { c, mut, log } = survivor(seed);
      for (let i = 0; i < 6; i++) expect(c.inv.consume(dose('mutagen_lizard'), null).ok).toBe(true);
      const gained = [...c.traits].filter((t) => !mut.isBase(t));
      expect(gained.length, `seed ${seed}: ${log.join(' | ')}`).toBeGreaterThan(0);
      expect(gained.some((t) => catOf(t).includes('LIZARD'))).toBe(true);
      for (const t of gained) {
        expect(tree.has(t), `${t} should be on a LIZARD path`).toBe(true);
        expect(mutDef(t).valid).not.toBe(false);
      }
      expect(checkConsistency(c.traits, mut.base), `seed ${seed}`).toEqual([]);
      expect(log.some((l) => /You gain a mutation called|mutation turns into/.test(l))).toBe(true);
    }
  });

  it('category-less mutagen spends accumulated mutagen (BALANCED_MUTATIONS)', () => {
    const { c, mut, log } = survivor(3);
    expect(mut.idx.balanced).toBe(true);
    // A new game starts with 27 days, capped at the effect's 22 day maximum.
    mut.startGame();
    expect(c.effects.get('accumulated_mutagen')!.duration).toBe(22 * 86400);
    // Without drinking anything nothing happens.
    pass(c, (dt) => mut.update(dt), 86400, 600);
    expect([...c.traits].filter((t) => !mut.isBase(t))).toEqual([]);
    expect(c.inv.consume(dose('mutagen'), null).ok).toBe(true);
    // 22 d / 3 d per mutation: seven changes at once (some upgrade earlier ones), the
    // remainder by roll_remainder.
    const changes = log.filter((l) => /You gain a mutation called|mutation turns into/.test(l)).length;
    expect(changes).toBeGreaterThanOrEqual(7);
    expect([...c.traits].filter((t) => !mut.isBase(t)).length).toBeGreaterThanOrEqual(3);
    expect((c.effects.get('accumulated_mutagen')?.duration ?? 0) / 86400).toBeLessThan(3);
    expect(checkConsistency(c.traits, mut.base)).toEqual([]);
  });

  it('without accumulated mutagen a weak generic dose only accumulates', () => {
    const { c, mut } = survivor(5);
    // is_weak (mutagenic flesh) adds nothing; plain mutagen adds 2 days, mutating once only after 3.
    mut.useMutagen(dose('mutagen'), { type: 'mutagen', is_weak: true });
    expect(c.effects.get('accumulated_mutagen')).toBeUndefined();
    expect([...c.traits].filter((t) => !mut.isBase(t))).toEqual([]);
  });

  it('mutate towards a deep trait walks its prerequisite chain (SCALES via SKIN_ROUGH) and armors', () => {
    const { c, mut } = survivor();
    let n = 0;
    while (!c.hasTrait('SCALES') && n++ < 10) mut.mutateTowards('SCALES');
    expect(c.hasTrait('SCALES')).toBe(true);
    // SKIN_ROUGH changes_to SCALES: replaced, not kept.
    expect(c.hasTrait('SKIN_ROUGH')).toBe(false);
    expect(checkConsistency(c.traits, mut.base)).toEqual([]);
    // "armor": [{"parts": "ALL", "physical": 3}] — stab uses cut armor.
    expect(mut.armor('torso', 'cut')).toBe(3);
    expect(mut.armor('hand_l', 'stab')).toBe(3);
    expect(mut.armor('torso', 'heat')).toBe(0);
    const out = c.inv.absorbHit('torso', [{ type: 'bash', amount: 10 }], new Rng(1));
    expect(out[0].amount).toBeLessThanOrEqual(7);
  });

  it('crosses the LIZARD threshold with an IV serum once it is the primary category above 50', () => {
    const { c, mut, log } = survivor(9);
    for (let i = 0; i < 80; i++) mut.mutateCategory('LIZARD');
    const levels = mut.categoryLevels();
    expect(mut.highestCategory(levels)).toBe('LIZARD');
    expect(levels.get('LIZARD')!).toBeGreaterThan(50);
    // Post-threshold LIZARD mutations (threshreq → threshold_tier 1) strain before crossing.
    // THICK_SCALES: threshreq THRESH_LIZARD (tier 1), prereq SCALES.
    const post = { id: 'THICK_SCALES' };
    let n = 0;
    while (!c.hasTrait('SCALES') && n++ < 10) mut.mutateTowards('SCALES');
    expect(mut.mutateTowards(post.id)).toBe(false);
    expect(log.join(' ')).toContain('yearning to be free');
    let crossed = false;
    for (let i = 0; i < 50 && !crossed; i++) crossed = mut.testCrossingThreshold('LIZARD', 1);
    expect(crossed).toBe(true);
    expect(c.hasTrait('THRESH_LIZARD')).toBe(true);
    expect(mut.threshTier).toBe(1);
    expect(mut.thresholdCategory()).toBe('LIZARD');
    expect(log.join(' ')).toContain('FREE!');
    // Only once, and no other category's threshold afterwards.
    expect(mut.testCrossingThreshold('LIZARD', 1)).toBe(false);
    expect(mut.testCrossingThreshold('BEAST', 1)).toBe(false);
    expect(mut.mutateTowards(post.id)).toBe(true);
    expect(c.hasTrait(post.id)).toBe(true);
  });

  it('a threshold needs the category to be primary and strong', () => {
    const { c, mut, log } = survivor(2);
    mut.mutateTowards('SCALES');
    for (let i = 0; i < 20; i++) expect(mut.testCrossingThreshold('LIZARD')).toBe(false);
    expect(c.hasTrait('THRESH_LIZARD')).toBe(false);
    expect(log.join(' ')).not.toContain('FREE!');
  });

  it('purifier removes one to four mutations, never innate traits', () => {
    const { c, mut, log } = survivor();
    c.addTrait('NIGHTVISION');
    mut.syncBase();
    for (const t of ['SCALES', 'LIZ_EYE', 'CLAWS']) {
      let n = 0;
      while (!c.hasTrait(t) && n++ < 10) mut.mutateTowards(t);
    }
    const before = [...c.traits].filter((t) => !mut.isBase(t));
    expect(before.length).toBe(3);
    expect(c.inv.consume(dose('purifier'), null).ok).toBe(true);
    const after = [...c.traits].filter((t) => !mut.isBase(t));
    expect(after.length).toBeLessThan(before.length);
    expect(c.hasTrait('NIGHTVISION')).toBe(true);
    expect(log.some((l) => /You lose your .* mutation\.|mutation turns into/.test(l))).toBe(true);
  });

  it('mutagen aversion refuses the dose and keeps it', () => {
    const { c, mut } = survivor();
    mut.setMutation('MUTAGEN_AVOID');
    const r = c.inv.consume(dose('mutagen_lizard'), null);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/You're not drinking that chemical stuff/);
  });

  it('restricts_gear: hooves push boots off and then block wearing them; a muzzle pushes off a mask', () => {
    const { c, mut, log } = survivor();
    const dropped: Item[] = [];
    mut.onDropItem = (it) => dropped.push(it);
    const boots = createItem(data, 'boots');
    expect(c.inv.wear(boots, null).ok).toBe(true);
    mut.setMutation('HOOVES');
    expect(c.inv.worn.includes(boots)).toBe(false);
    expect(dropped).toContain(boots);
    expect(log.join(' ')).toContain('Your pair of boots is pushed off!'.replace('pair of boots', boots.name()));
    const r = c.inv.wear(createItem(data, 'boots'), null);
    expect(r.ok).toBe(false);
    expect(r.msg).toMatch(/Hooves mutation prevents you from wearing/);
    const mask = createItem(data, 'mask_dust');
    expect(c.inv.wear(mask, null).ok).toBe(true);
    mut.setMutation('MUZZLE');
    expect(c.inv.worn.includes(mask)).toBe(false);
    expect(dropped).toContain(mask);
  });

  it('claws make unarmed attacks cut (cut_dmg_bonus); night vision comes from night_vision_range', () => {
    const { c, mut } = survivor();
    const rng = new Rng(3);
    const cut = () => rollMeleeDamage(c, null, false, rng, true).find((d) => d.type === 'cut')?.amount ?? 0;
    expect(cut()).toBe(0);
    let n = 0;
    while (!c.hasTrait('CLAWS') && n++ < 10) mut.mutateTowards('CLAWS');
    expect(c.hasTrait('CLAWS')).toBe(true);
    expect(cut()).toBeGreaterThan(0);
    expect(mut.nightVisionRange()).toBe(0);
    mut.setMutation('NIGHTVISION');
    expect(mut.nightVisionRange()).toBe(2);
  });

  it('saves and restores powered mutations and the threshold tier', () => {
    const a = survivor();
    a.mut.setMutation('THRESH_LIZARD');
    a.mut.threshTier = 1;
    a.mut.threshCategory = 'LIZARD';
    const active = Object.values(data.misc.mutation as Record<string, any>).find((d) => d.active && !d.transform)!;
    a.mut.setMutation(active.id);
    a.mut.powered.add(active.id);
    const j = JSON.parse(JSON.stringify(a.mut.toJSON()));
    const b = survivor();
    b.c.traits.add('THRESH_LIZARD');
    b.c.traits.add(active.id);
    b.mut.load(j);
    expect(b.mut.isPowered(active.id)).toBe(true);
    expect(b.mut.threshTier).toBe(1);
    expect(b.mut.thresholdCategory()).toBe('LIZARD');
    // v1 (DDA) saves carried vitamins and CHANGING timers: they load without them.
    const old = survivor();
    old.mut.load({ vitamins: { mutagen: 300 }, powered: [], base: [], time: 5 } as never);
    expect(old.mut.threshTier).toBe(0);
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
    // Autodoc install program: skill level override 10 → pl 120.
    expect(bionicsPlSkill(c, true, 10)).toBe(120);
    c.setSkill('electronics', 8);
    c.setSkill('firstaid', 8);
    c.setSkill('mechanics', 8);
    expect(bionicSuccessChance(c, false, 1)).toBeGreaterThan(80);
  });

  it('BN always installs the CBM; failed rolls add complications at the success rate', () => {
    const N = 1500;
    let clean = 0;
    const fails: Record<number, number> = {};
    let chance = 0;
    for (let i = 0; i < N; i++) {
      const { bio, c } = survivor(1000 + i);
      const hp = c.hp.torso.cur;
      const r = bio.install('bio_power_storage');
      chance = r.chance;
      expect(r.ok).toBe(true);
      expect(bio.has('bio_power_storage')).toBe(true);
      expect(bio.maxPower()).toBeGreaterThanOrEqual(r.faulty ? 0 : 100 - (r.failType! >= 4 ? 100 : 0));
      if (r.success > 0) clean++;
      else {
        fails[r.failType!] = (fails[r.failType!] ?? 0) + 1;
        // Power storage occupies no body part: complications hurt the torso.
        if (r.failType! <= 3) expect(c.hp.torso.cur).toBeLessThan(hp);
        if (r.faulty) expect(bio.has(r.faulty)).toBe(true);
      }
    }
    expect(chance).toBe(41);
    expect(clean / N).toBeGreaterThan(0.41 - 0.04);
    expect(clean / N).toBeLessThan(0.41 + 0.04);
    expect(Object.keys(fails).length).toBeGreaterThan(1);
  });

  it('installation checks duplicates and prerequisites; no slot limit unless CBM_SLOTS_ENABLED', () => {
    const { bio } = survivor();
    expect(bio.idx.slotsEnabled).toBe(false);
    bio.add('bio_flashlight');
    expect(bio.installBlocker('bio_flashlight')).toBe('CBM is already installed.');
    expect(bio.installBlocker('bio_power_storage')).toBeNull();
    // Power storage is MULTIINSTALL; 100 kJ each.
    for (let i = 0; i < 42; i++) bio.add('bio_power_storage');
    expect(bio.maxPower()).toBe(4200);
    expect(bio.installBlocker('bio_power_storage')).toBeNull();
    const withReq = [...bio.idx.defs.values()].find((d) => d.required_bionics?.length);
    if (withReq) expect(bio.installBlocker(withReq.id)).toMatch(/requires prior installation/);
  });

  it('self-installation is off (MANUAL_BIONIC_INSTALLATION); an Autodoc needs 42 anesthetic per difficulty', () => {
    const { bio } = survivor();
    expect(bio.idx.manualInstall).toBe(false);
    // requirement "anesthetic" (3 kit charges) × difficulty × 2 × 7.
    expect(bio.anesthesiaNeeded('bio_flashlight')).toBe(3 * 2 * 2 * 7);
    expect(bio.needsAnesthesia()).toBe(true);
    bio.add('bio_painkiller');
    expect(bio.needsAnesthesia()).toBe(false);
  });

  it('power drains while a toggled bionic is on, and it powers down when empty', () => {
    const { bio, c, log } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_flashlight');
    bio.modPower(50);
    expect(bio.activate('bio_flashlight')).toBe(true);
    expect(bio.isActive('bio_flashlight')).toBe(true);
    pass(c, (dt) => bio.update(dt), 3600, 60);
    // act 8 J, then 8 J per turn after the first (charge_timer starts at charge_time 1).
    expect(bio.power).toBeCloseTo(50 - 0.008 - 3599 * 0.008, 3);
    bio.power = 0.001;
    pass(c, (dt) => bio.update(dt), 60, 60);
    expect(bio.isActive('bio_flashlight')).toBe(false);
    expect(log.join(' ')).toContain('powers down');
  });

  it('power sources: metabolic interchange burns calories, the torsion ratchet charges from walking', () => {
    const { bio, c } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_metabolics');
    expect(bio.activate('bio_metabolics')).toBe(true);
    const kcal = c.storedKcal;
    pass(c, (dt) => bio.update(dt), 60, 1);
    // 1 kcal → 4.184 kJ × 0.25 per turn.
    expect(bio.power).toBeGreaterThan(10);
    expect(c.storedKcal).toBeLessThan(kcal);
    const r = survivor();
    r.bio.add('bio_power_storage');
    r.bio.add('bio_torsionratchet');
    r.bio.onMoved(100);
    expect(r.bio.power).toBeCloseTo(100 * 0.00625, 5);
  });

  it('stat_bonus: Muscle Augmentation is a permanent +2 Str; Power Overload -3 above 75%', () => {
    const { bio, c } = survivor();
    bio.add('bio_str_enhancer');
    c.resetStats();
    expect(c.str).toBe(c.str_base + 2);
    bio.add('bio_power_storage');
    bio.add('bio_power_weakness');
    bio.modPower(80);
    c.resetStats();
    expect(c.str).toBe(c.str_base + 2 - 3);
  });

  it('bionic claws are wielded while active and cannot be dropped', () => {
    const { bio, c } = survivor();
    bio.add('bio_power_storage');
    bio.add('bio_claws');
    bio.modPower(10);
    c.inv.wield(createItem(data, 'knife_combat'), null);
    expect(bio.activate('bio_claws')).toBe(true);
    expect(c.inv.wielded?.typeId).toBe('bio_claws_weapon');
    expect(c.inv.carried().some((it) => it.typeId === 'knife_combat')).toBe(true);
    expect(c.inv.drop(c.inv.wielded!).ok).toBe(false);
    bio.deactivate('bio_claws');
    expect(c.inv.wielded).toBeNull();
  });

  it('alloy plating reduces damage under the clothes (cut_protec 6)', () => {
    const { bio, c } = survivor();
    bio.add('bio_armor_torso');
    expect(bio.armor('torso', 'cut')).toBe(6);
    expect(bio.armor('torso', 'stab')).toBe(6);
    expect(bio.armor('torso', 'bullet')).toBe(5);
    const out = c.inv.absorbHit('torso', [{ type: 'cut', amount: 10 }], new Rng(1));
    expect(out[0].amount).toBeLessThanOrEqual(4);
  });

  it('bio_tools (fake_item toolset, INITIALLY_ACTIVATE) satisfies crafting tool qualities while on', () => {
    const { bio, c } = survivor();
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('SCREW', 1)).toBe(false);
    bio.add('bio_power_storage');
    bio.add('bio_tools');
    expect(bio.isActive('bio_tools')).toBe(true);
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('SCREW', 1)).toBe(true);
    expect(CraftingInventory.gather(data, c, null, null).hasQuality('WRENCH', 1)).toBe(true);
    expect(c.inv.hasQuality('PRY', 1)).toBe(true);
    bio.deactivate('bio_tools');
    expect(c.inv.hasQuality('PRY', 1)).toBe(false);
  });
});

describe('bionics in a game', () => {
  function stubInput(): any {
    return { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  }
  it('bio_flashlight toggles the player light (LUMINATION max 300 while active)', () => {
    const game = new Game(data, 3, stubInput());
    game.map.generator = new TestGenerator();
    const mods = installMutBio(game, null);
    mods.bio.add('bio_power_storage');
    mods.bio.add('bio_flashlight');
    mods.bio.modPower(20);
    expect(playerLight(game)).toBe(0);
    mods.bio.toggle('bio_flashlight');
    expect(playerLight(game)).toBe(300);
    expect(playerLightState(game).on).toBe(true);
    mods.bio.toggle('bio_flashlight');
    expect(playerLight(game)).toBe(0);
  });

  it('bionic night vision (NIGHT_VISION max 10) lowers the vision threshold', () => {
    const game = new Game(data, 3, stubInput());
    game.map.generator = new TestGenerator();
    const mods = installMutBio(game, null);
    expect(visionThreshold(game, 1)).toBe(LIGHT_AMBIENT_LOW);
    mods.bio.add('bio_power_storage');
    mods.bio.add('bio_night_vision');
    mods.bio.modPower(20);
    mods.bio.toggle('bio_night_vision');
    expect(mods.bio.nightVisionRange()).toBe(10);
    expect(visionThreshold(game, 1)).toBeLessThan(2.5);
  });
});
