// Combat depth against the real extracted CDDA data: weapon techniques, blocking, dodges per
// turn, martial arts buffs, weapon wear/glass, fire modes and bursts, gunmods, shotgun pellets.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import type { Input } from '../src/core/input';
import { Game } from '../src/game/game';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { Character } from '../src/game/character';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat, applyTechniqueToMonster, monsterTargetInfo } from '../src/game/playercombat';
import { aimState, fireGun, gunDispersion, meleeAttack, monsterMeleeAttack, tryDodgeRoll } from '../src/game/combat';
import { createItem, Item } from '../src/game/item';
import {
  applyTechnique, availableTechniques, blockHit, blockingAbility, glassShatter, handleMeleeWear, logarithmicRange, pickTechnique,
  techniqueDef, techniqueMessage, type TargetInfo,
} from '../src/game/techniques';
import {
  buffFlat, COMBAT_TURN, currentStyle, learnStyle, maOf, refreshDefenses, selectStyle, tickMartialArts, triggerBuffs,
} from '../src/game/martialarts';
import {
  aimLevel, aimThresholds, currentMode, cycleMode, gunModes, gunmodCompatible, installGunmod, isJammed, removeGunmod, sightDispersion,
} from '../src/game/gunmods';
import { Monster } from '../src/game/monster';
import { monGunState } from '../src/game/monguns';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'),
    furniture: load('furniture.json'),
    items: load('items.json'),
    itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'),
    monsterGroups: load('monster_groups.json'),
    recipes: [],
    misc: load('misc.json'),
  };
});

function survivor(seed = 3): { c: Character; log: string[] } {
  const c = new Character(data, { seed });
  const log: string[] = [];
  c.onMessage = (t) => log.push(t);
  return { c, log };
}

const zombieInfo = (): TargetInfo => ({ size: 3, bodytype: 'human', species: ['ZOMBIE', 'HUMAN'], flags: [], isMonster: true, hasEffect: () => false });

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}
function fakeInput(): Input {
  return { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
}
function world(seed = 7): { game: Game; sys: MonsterSystem; combat: PlayerCombat; msgs: string[] } {
  const game = new Game(data, seed, fakeInput());
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  game.player.yaw = 0; // facing north (−y)
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) game.map.chunk(x, y, 0);
  const sys = new MonsterSystem(game);
  const combat = new PlayerCombat(game, sys);
  game.systems.push(sys, combat);
  game.clock.seconds = 12 * 3600;
  const msgs: string[] = [];
  game.events.on('message', (m) => msgs.push(m.text));
  return { game, sys, combat, msgs };
}

describe('weapon techniques (pick_technique / evaluate_technique)', () => {
  it('a katana offers RAPID on normal hits; a baseball bat only has its crit-only BRUTAL', () => {
    const { c } = survivor();
    c.setSkill('melee', 3);
    const katana = createItem(data, 'katana');
    const bat = createItem(data, 'bat');
    const rng = new Rng(1);
    expect(availableTechniques(c, katana).map((t) => t.id)).toEqual(['RAPID', 'WBLOCK_2']);
    // WBLOCK_2 is a dummy (blocking only), so a normal katana hit always picks RAPID.
    for (let i = 0; i < 20; i++) expect(pickTechnique(c, zombieInfo(), katana, { crit: false }, rng)?.id).toBe('RAPID');
    expect(pickTechnique(c, zombieInfo(), bat, { crit: false }, rng)).toBeNull();
    expect(pickTechnique(c, zombieInfo(), bat, { crit: true }, rng)?.id).toBe('BRUTAL');
    // RAPID: half the moves, 66% damage.
    const units = [{ type: 'cut', amount: 30, armor_penetration: 0, armor_multiplier: 1 }];
    const r = applyTechnique(c, techniqueDef(data, 'RAPID')!, units, 100, rng);
    expect(r.moves).toBe(50);
    expect(units[0].amount).toBeCloseTo(19.8);
    expect(techniqueMessage(techniqueDef(data, 'RAPID')!, 'the zombie')).toBe('You quickly strike the zombie');
  });

  it('skill requirements and conditions gate techniques (RAPID needs melee 2; BRUTAL not on stunned/huge targets)', () => {
    const { c } = survivor();
    const rng = new Rng(2);
    const katana = createItem(data, 'katana');
    expect(pickTechnique(c, zombieInfo(), katana, { crit: false }, rng)).toBeNull();
    c.setSkill('melee', 2);
    expect(pickTechnique(c, zombieInfo(), katana, { crit: false }, rng)?.id).toBe('RAPID');
    const bat = createItem(data, 'bat');
    expect(pickTechnique(c, { ...zombieInfo(), hasEffect: (id) => id === 'stunned' }, bat, { crit: true }, rng)).toBeNull();
    expect(pickTechnique(c, { ...zombieInfo(), size: 5 }, bat, { crit: true }, rng)).toBeNull();
  });

  it('crit-only AoE: WIDE needs a crit and an extra victim; SWEEP downs a humanoid on normal hits', () => {
    const { c } = survivor();
    c.setSkill('melee', 3);
    const axe = createItem(data, 'battleaxe');
    const rng = new Rng(4);
    const ids = (crit: boolean, aoe: number) => {
      const seen = new Set<string>();
      for (let i = 0; i < 60; i++) seen.add(pickTechnique(c, zombieInfo(), axe, { crit, aoeTargets: () => aoe }, rng)?.id ?? 'none');
      return seen;
    };
    expect(ids(false, 2).has('WIDE')).toBe(false);
    expect(ids(false, 0).has('SWEEP')).toBe(true);
    expect(ids(true, 0).has('WIDE')).toBe(false);
    expect(ids(true, 2).has('WIDE')).toBe(true);
    // Flying targets can't be swept.
    expect(pickTechnique(c, { ...zombieInfo(), flags: ['FLIES'] }, axe, { crit: false }, rng)?.id).not.toBe('SWEEP');
  });

  it('BRUTAL stuns and knocks a zombie back; SWEEP downs it (+3 bash)', () => {
    const { c } = survivor();
    c.setSkill('melee', 3);
    const rng = new Rng(5);
    const z = new Monster(data, data.monsters.mon_zombie, 10.5, 9.5, 0, new Rng(1));
    const units = [{ type: 'bash', amount: 20, armor_penetration: 0, armor_multiplier: 1 }];
    const brutal = applyTechnique(c, techniqueDef(data, 'BRUTAL')!, units, 100, rng);
    expect(brutal.outcome.stunTurns).toBe(1);
    expect(brutal.outcome.knockback).toBe(1);
    applyTechniqueToMonster(z, brutal.outcome, 10.5, 10.5, rng);
    expect(z.hasEffect('stunned')).toBe(true);
    expect(z.dashTime).toBeGreaterThan(0);
    // Pushed straight away from the attacker (north).
    expect(z.dashVy).toBeLessThan(0);
    expect(z.dodge()).toBe(0);
    const sweepUnits = [{ type: 'bash', amount: 10, armor_penetration: 0, armor_multiplier: 1 }];
    const sweep = applyTechnique(c, techniqueDef(data, 'SWEEP')!, sweepUnits, 100, rng);
    expect(sweep.outcome.downTurns).toBeGreaterThanOrEqual(1);
    expect(sweepUnits[0].amount).toBe(13);
  });

  it('in the world: a battleaxe wide-arc crit hits the zombies beside the target too', () => {
    const { game, sys, combat, msgs } = world();
    const p = game.player;
    p.inv.wield(createItem(data, 'battleaxe'));
    p.str_base = 14;
    p.dex_base = 20;
    p.per_base = 20;
    p.update(1);
    for (const s of ['melee', 'cutting', 'bashing']) p.setSkill(s, 10);
    // Target straight ahead (north); two more at the front-left and front-right corners.
    const t = sys.spawnById('mon_zombie', 12.5, 11.5, 0)!;
    const l = sys.spawnById('mon_zombie', 11.6, 11.8, 0)!;
    const r = sys.spawnById('mon_zombie', 13.4, 11.8, 0)!;
    expect(combat.aoeVictims('wide', t).sort((a, b) => a.x - b.x)).toEqual([l, r]);
    let swept = false;
    for (let i = 0; i < 80 && !swept; i++) {
      for (const m of [t, l, r]) (m.hp = 1000), (m.x = m === t ? 12.5 : m === l ? 11.6 : 13.4), (m.y = m === t ? 11.5 : 11.8), (m.dashTime = 0), m.effects.clear();
      msgs.length = 0;
      p.stamina = p.staminaMax();
      combat.swingAt(t, { primary: true });
      if (msgs.some((m) => m.startsWith('You swing in a wide arc through the zombie'))) {
        swept = true;
        expect(msgs.some((m) => /enemies hit!/.test(m))).toBe(true);
        expect(l.hp < 1000 || r.hp < 1000).toBe(true);
      }
    }
    expect(swept).toBe(true);
  });
});

describe('blocking and dodging (block_hit, dodges_left)', () => {
  it('melee 0 never blocks; melee 5 always tries once per turn with the weapon', () => {
    const { c, log } = survivor();
    c.inv.wield(createItem(data, 'bat'));
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      refreshDefenses(c);
      expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, rng).blocked).toBe(false);
    }
    c.setSkill('melee', 5);
    refreshDefenses(c);
    const units = [{ type: 'bash', amount: 10 }];
    const b = blockHit(c, units, 'torso', 3, rng);
    expect(b.blocked).toBe(true);
    expect(b.with).toBe('baseball bat');
    // str 8 + WBLOCK_1 4 + melee 5 = 17 → logarithmic_range(0, 40, 17) of the damage gets through.
    expect(units[0].amount).toBeCloseTo(10 * logarithmicRange(0, 40, 17));
    expect(log.some((m) => /^You block (most|a lot|some|nearly all|a little) of the damage with your baseball bat!$/.test(m))).toBe(true);
    // Only one block per turn.
    expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, rng).blocked).toBe(false);
    // Too big to block: a huge attacker (size 5 > 3 + 1).
    refreshDefenses(c);
    expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 5, rng).blocked).toBe(false);
  });

  it('better blockers absorb more: WBLOCK_2 katana + skill 8 beats a bat at skill 5', () => {
    expect(blockingAbility(createItem(data, 'katana'))).toBe(6);
    expect(blockingAbility(createItem(data, 'bat'))).toBe(4);
    expect(logarithmicRange(0, 40, 8 + 6 + 8)).toBeLessThan(logarithmicRange(0, 40, 17));
  });

  it('unarmed arm blocks need the style arm_block level and move the hit to an arm', () => {
    const { c } = survivor();
    c.setSkill('melee', 5);
    refreshDefenses(c);
    const rng = new Rng(8);
    // No style: arm_block 1 → unarmed 0 can't.
    expect(blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, rng).blocked).toBe(false);
    c.setSkill('unarmed', 1);
    refreshDefenses(c);
    const b = blockHit(c, [{ type: 'bash', amount: 10 }], 'torso', 3, rng);
    expect(b.blocked).toBe(true);
    expect(['arm_l', 'arm_r']).toContain(b.bp);
  });

  it('one dodge per turn: a second attack in the same turn gets no dodge roll', () => {
    const { c } = survivor();
    refreshDefenses(c);
    expect(tryDodgeRoll(c)).toBeGreaterThan(0);
    expect(tryDodgeRoll(c)).toBe(0);
    tickMartialArts(c, COMBAT_TURN + 0.01);
    expect(tryDodgeRoll(c)).toBeGreaterThan(0);
  });

  it('monster attacks are blocked by a skilled survivor with a weapon', () => {
    const { c, log } = survivor();
    c.inv.wield(createItem(data, 'bat'));
    c.setSkill('melee', 6);
    const rng = new Rng(9);
    let blocked = 0;
    for (let i = 0; i < 40; i++) {
      refreshDefenses(c);
      maOf(c).dodgesLeft = 0;
      c.stamina = c.staminaMax();
      for (const p of Object.values(c.hp)) p.cur = p.max;
      const r = monsterMeleeAttack(data.monsters.mon_zombie, c, rng);
      if (r.block) blocked++;
    }
    expect(blocked).toBeGreaterThan(10);
    expect(log.some((m) => m.includes('with your baseball bat!'))).toBe(true);
  });
});

describe('martial arts', () => {
  it('Karate: learned from its manual id, +2 accuracy static buff, techniques need unarmed', () => {
    const { c } = survivor();
    expect(currentStyle(c).id).toBe('style_none');
    expect(selectStyle(c, 'style_karate')).toBe(false); // not known yet
    expect(learnStyle(c, data.items.manual_karate.martial_art as string)).toBe(true);
    expect(selectStyle(c, 'style_karate')).toBe(true);
    expect(buffFlat(c, 'hit')).toBe(2);
    c.setSkill('unarmed', 1);
    expect(availableTechniques(c, null).map((t) => t.id)).toContain('tec_karate_rapid');
    expect(pickTechnique(c, zombieInfo(), null, { crit: false }, new Rng(1))?.id).toMatch(/^tec_karate_/);
    // Karate doesn't allow a katana: its static buff drops out of the requirements.
    c.inv.wield(createItem(data, 'katana'));
    triggerBuffs(c, 'static');
    maOf(c).buffs.clear();
    triggerBuffs(c, 'static');
    expect(buffFlat(c, 'hit')).toBe(0);
  });

  it('Brawling onpause buff stacks twice (+1 hit each) while standing still, then expires', () => {
    const { c } = survivor();
    c.setSkill('melee', 1);
    learnStyle(c, 'style_brawling', true);
    selectStyle(c, 'style_brawling', true);
    tickMartialArts(c, COMBAT_TURN);
    expect(maOf(c).buffs.get('buff_brawling_onpause')?.stacks).toBe(1);
    tickMartialArts(c, COMBAT_TURN);
    tickMartialArts(c, COMBAT_TURN);
    expect(maOf(c).buffs.get('buff_brawling_onpause')?.stacks).toBe(2);
    expect(buffFlat(c, 'hit')).toBe(2);
    // Moving every turn stops the onpause buff from being refreshed.
    for (let i = 0; i < 4; i++) {
      maOf(c).moved = true;
      tickMartialArts(c, COMBAT_TURN);
    }
    expect(maOf(c).buffs.has('buff_brawling_onpause')).toBe(false);
  });

  it('Karate onhit buff (unarmed 3): +1 dodge and +1 block attempt next turn, cheaper swings', () => {
    const { c } = survivor();
    c.setSkill('unarmed', 3);
    learnStyle(c, 'style_karate', true);
    selectStyle(c, 'style_karate', true);
    triggerBuffs(c, 'onhit');
    refreshDefenses(c);
    expect(maOf(c).dodgesLeft).toBe(2);
    expect(maOf(c).blocksLeft).toBe(2);
    const before = meleeAttack(c, { dodge: 0 }, new Rng(1)).moves;
    maOf(c).buffs.clear();
    const after = meleeAttack(c, { dodge: 0 }, new Rng(1)).moves;
    expect(before).toBeLessThan(after);
  });
});

describe('weapon durability', () => {
  it('a glass bottle shatters on the blow, cutting the wielder and leaving their hands', () => {
    const { c, log } = survivor();
    const bottle = createItem(data, 'bottle_glass');
    c.inv.wield(bottle);
    const hp = c.hp.arm_r.cur;
    const r = glassShatter(c, bottle, new Rng(3));
    expect(r.shattered).toBe(true);
    expect(c.inv.wielded).toBeNull();
    expect(log).toContain('Your glass bottle shatters!');
    expect(c.hp.arm_r.cur).toBeLessThanOrEqual(hp);
  });

  it('chip-resistance 0 items wear on every blow until destroyed; DURABLE_MELEE steel rarely does', () => {
    const { c, log } = survivor();
    const bottle = createItem(data, 'bottle_glass');
    c.inv.wield(bottle);
    const rng = new Rng(4);
    expect(handleMeleeWear(c, bottle, 1, rng).damaged).toBe(true);
    expect(log).toContain('Your glass bottle is damaged by the force of the blow!');
    for (let i = 0; i < 3; i++) handleMeleeWear(c, bottle, 1, rng);
    expect(c.inv.wielded).toBeNull();
    expect(log.some((m) => /is destroyed by the blow!$/.test(m))).toBe(true);
    const katana = createItem(data, 'katana');
    c.inv.wield(katana);
    let hits = 0;
    for (let i = 0; i < 500; i++) if (handleMeleeWear(c, katana, 1, rng).damaged) hits++;
    expect(hits).toBeLessThan(5);
  });
});

describe('ranged depth', () => {
  function loadedScar(): Item {
    const gun = createItem(data, 'scar_l');
    gun.magazineWell()!.insert(createItem(data, 'stanag30', { ammo: '223' }));
    return gun;
  }

  it('fire modes come from the gun data; cycling selects AUTO (4 rounds)', () => {
    const gun = loadedScar();
    expect(gunModes(gun).map((m) => [m.id, m.qty])).toEqual([['DEFAULT', 1], ['AUTO', 4]]);
    expect(currentMode(gun).id).toBe('DEFAULT');
    expect(cycleMode(gun).id).toBe('AUTO');
    expect(currentMode(gun).qty).toBe(4);
  });

  it('a burst fires the mode shot count with recoil growing shot by shot', () => {
    const { game, combat } = world();
    const p = game.player;
    const gun = loadedScar();
    cycleMode(gun);
    p.inv.wield(gun);
    p.recoil = 0;
    const before = gun.ammoRemaining();
    const recoils: number[] = [];
    combat.fire();
    recoils.push(p.recoil);
    for (let i = 0; i < 30 && combat.burst; i++) {
      combat.update(game, 0.03);
      recoils.push(p.recoil);
    }
    expect(before - gun.ammoRemaining()).toBe(4);
    expect(combat.burst).toBeNull();
    const distinct = [...new Set(recoils)];
    expect(distinct.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < distinct.length; i++) expect(distinct[i]).toBeGreaterThan(distinct[i - 1]);
  });

  it('a suppressor cuts the noise by its loudness_multiplier; it needs a muzzle slot', () => {
    const { c } = survivor();
    c.setSkill('gun', 5);
    c.setSkill('rifle', 5);
    const gun = loadedScar();
    const loud = gun.gunNoise().volume;
    const sup = createItem(data, 'suppressor');
    expect(installGunmod(c, gun, sup).ok).toBe(true);
    expect(gun.gunNoise().volume).toBe(Math.trunc(loud * 0.7));
    expect(gunmodCompatible(gun, createItem(data, 'suppressor')).reason).toMatch(/already has/);
    // A Glock has no muzzle slot.
    const glock = createItem(data, 'glock_19');
    expect(gunmodCompatible(glock, createItem(data, 'suppressor')).ok).toBe(false);
    expect(removeGunmod(c, gun, sup).ok).toBe(true);
    expect(gun.gunNoise().volume).toBe(loud);
  });

  it('sights: a red dot on a sights mount replaces the iron sights; gunmods survive save/load', () => {
    const { c } = survivor();
    c.setSkill('gun', 5);
    c.setSkill('rifle', 5);
    const gun = loadedScar();
    expect(sightDispersion(gun)).toBe(Number(gun.def.sight_dispersion));
    expect(installGunmod(c, gun, createItem(data, 'red_dot_sight')).ok).toBe(true);
    expect(sightDispersion(gun)).toBe(27);
    const again = Item.fromJSON(data, JSON.parse(JSON.stringify(gun.toJSON())));
    expect(again.gunmods.map((m) => m.typeId)).toEqual(['red_dot_sight']);
    // Mods with a dispersion_modifier widen the gun's dispersion.
    const base = gunDispersion(gun);
    installGunmod(c, gun, createItem(data, 'muzzle_brake'));
    expect(gunDispersion(gun)).toBeGreaterThanOrEqual(base);
  });

  it('aim levels: Immediate → Regular → Careful → Precise at CDDA thresholds', () => {
    const t = aimThresholds(100);
    expect(t).toEqual({ regular: 390, careful: 172, precise: 100 });
    expect(aimLevel(3000, 100)).toBe('Immediate');
    expect(aimLevel(300, 100)).toBe('Regular');
    expect(aimLevel(150, 100)).toBe('Careful');
    expect(aimLevel(100, 100)).toBe('Precise');
    const { c } = survivor();
    expect(aimState(c, loadedScar())).toBe('Immediate');
  });

  it('shotgun buckshot: 9 pellets of shot_damage beyond point-blank, spread over several zombies', () => {
    const { c } = survivor();
    const gun = createItem(data, 'mossberg_500', { ammo: 'shot_00' });
    const shot = fireGun(c, gun, new Rng(5));
    expect(shot.pellets).toBe(9);
    expect(shot.shotDamage).toEqual([{ type: 'bullet', amount: 16, armor_penetration: 0 }]);
    expect(shot.shotSpreadMoa).toBe(300);
    const { game, sys, combat, msgs } = world();
    game.player.inv.wield(createItem(data, 'mossberg_500', { ammo: 'shot_00' }));
    game.player.recoil = 0;
    for (let dx = -1; dx <= 1; dx++) sys.spawnById('mon_zombie', 12.5 + dx * 0.7, 7.5, 0);
    let hitMsgs = 0;
    for (let i = 0; i < 5; i++) {
      game.player.recoil = 0;
      combat.cooldown = 0;
      combat.fire();
      hitMsgs += msgs.filter((m) => / is hit by .* projectiles?, /.test(m)).length;
      msgs.length = 0;
    }
    expect(hitMsgs).toBeGreaterThan(0);
  });

  it('damaged guns jam; a jammed gun refuses to fire until cleared', () => {
    const { c } = survivor();
    const gun = loadedScar();
    gun.damage = 3500; // level 4: 80% jam chance per shot
    const rng = new Rng(6);
    let jammedAt = -1;
    for (let i = 0; i < 10 && jammedAt < 0; i++) {
      fireGun(c, gun, rng);
      if (isJammed(gun)) jammedAt = i;
    }
    expect(jammedAt).toBeGreaterThanOrEqual(0);
    const r = fireGun(c, gun, rng);
    expect(r.ok).toBe(false);
    expect(r.message).toBe(`Your ${gun.baseName()} is jammed!`);
  });
});

describe('NPC parity', () => {
  it('monsterTargetInfo exposes size/bodytype/species for technique conditions', () => {
    const z = new Monster(data, data.monsters.mon_zombie, 1, 1, 0, new Rng(1));
    const info = monsterTargetInfo(z);
    expect(info).toMatchObject({ size: 3, bodytype: 'human', isMonster: true });
    expect(info.species).toContain('ZOMBIE');
  });
});

describe('monster guns (gun_actor)', () => {
  const tick = (game: Game, seconds: number) => {
    for (let i = 0; i < Math.round(seconds * 30); i++) game.tick(1 / 30);
  };

  it('a turret announces its target lock, then fires from its starting_ammo', () => {
    const { game, sys, msgs } = world(11);
    const t = sys.spawnById('mon_turret', 12.5, 6.5, 0)!;
    tick(game, 6);
    const lock = msgs.findIndex((m) => m === 'The improvised MP5 turret says "Hostile detected."');
    const fire = msgs.findIndex((m) => m === 'The improvised MP5 turret fires its H&K MP5A2 submachine gun!');
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(fire).toBeGreaterThan(lock);
    expect(monGunState(t).ammo['9mm']).toBeLessThan(30);
  });

  it('out of range the turret holds fire; with no ammo left it only clicks', () => {
    const { game, sys, msgs } = world(12);
    const t = sys.spawnById('mon_turret', 12.5, 12.5 - 20, 0)!; // MP5 turret: ranges [0, 14]
    tick(game, 3);
    expect(msgs.some((m) => /fires its/.test(m))).toBe(false);
    t.y = 7.5;
    monGunState(t).ammo['9mm'] = 0;
    monGunState(t).targetedUntil = Infinity;
    msgs.length = 0;
    tick(game, 3);
    expect(msgs.some((m) => /fires its/.test(m))).toBe(false);
  });

  it('a feral human throws rocks as a visible projectile', () => {
    const { game, sys, msgs } = world(13);
    const f = sys.spawnById('mon_feral_human_pipe', 12.5, 8.5, 0)!;
    f.anger = 100;
    tick(game, 8);
    expect(msgs.some((m) => m === 'The feral human throws a rock!')).toBe(true);
    expect(monGunState(f).ammo.rock).toBeLessThan(6);
  });
});
