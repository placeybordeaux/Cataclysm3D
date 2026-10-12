import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import { MonsterSystem } from '../src/game/monai';
import { PlayerCombat } from '../src/game/playercombat';
import { attachBodyMods } from '../src/game/bodymods';
import { createItem, loadAmmo, type Item } from '../src/game/item';
import { L, spawnItem } from '../src/game/moves';
import { fireGun } from '../src/game/combat';
import { ammoRequired, upsDrain } from '../src/game/gunmods';
import { activeWeapon, bionicGunHud, bionicGunSession } from '../src/game/bionicguns';
import { installBionicGuns } from '../src/bionicguns';
import { Rng } from '../src/core/rng';
import { makeData } from './fixtures/gamedata';
import { setAimModel } from '../src/game/aimmodel';

// Bionic guns (docs/BN_BIONIC_GUNS.md): BN activate_bionic's BIONIC_GUN branch and
// aim_activity_actor::use_bionic — a detached fake gun, power paid per shot actually fired.

const data = makeData();
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '../public/data', name), 'utf8'));
data.items = read('items.json'); data.misc = read('misc.json'); data.monsters = read('monsters.json');
data.terrain = read('terrain.json'); data.furniture = read('furniture.json');

function fixture(id = 'bio_laser', power = 100) {
  setAimModel('dice');
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, lastEscape: -1,
    onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, 11, input);
  game.player.x = 12.5; game.player.y = 12.5;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0)!.ter.fill(game.map.terrain.index('t_dirt'));
  const sys = new MonsterSystem(game), combat = new PlayerCombat(game, sys);
  const mods = attachBodyMods(game.player);
  const { bio } = mods;
  bio.add('bio_power_storage'); bio.add(id); bio.maxPowerLevel = 500; bio.power = power;
  // A stand-in for the pause-menu key: Esc must stop aiming instead of opening it.
  let menuOpened = 0;
  game.keys.register('menu', 'Main menu', () => void menuOpened++);
  installBionicGuns(game, combat, mods);
  const log: string[] = []; game.events.on('message', (m) => log.push(m.text));
  // A sure-hit shooter so damage assertions don't hang on dispersion rolls.
  game.player.recoil = 0; game.player.dex_base = game.player.per_base = 40;
  game.player.skills.pistol = { level: 10, exercise: 0 }; game.player.skills.rifle = { level: 10, exercise: 0 };
  return { game, input, sys, combat, bio, mods, log, menuOpened: () => menuOpened };
}

/** A zombie straight ahead (yaw 0 looks toward -y), unarmored and downed so it can't dodge. */
function target(game: Game, sys: MonsterSystem) {
  const m = sys.spawnById('mon_zombie', game.player.x, game.player.y - 2, 0)!;
  m.type = { ...m.type, armor: {} }; m.addEffect('downed', 1000);
  return m;
}

function wieldLoadedGlock(game: Game): Item {
  const glock = createItem(data, 'glock_19', { ammo: 'default' });
  expect(game.player.inv.wield(glock, null).ok).toBe(true);
  return glock;
}

/** Everything the survivor carries or stands on: the fake gun must never be among it. */
function ownedIds(game: Game): string[] {
  const p = game.player;
  return [...p.inv.allItems().map((i) => i.typeId), ...game.map.itemsAt(p.tileX, p.tileY, p.z).map((i) => i.typeId)];
}

describe('bionic gun activation (BN activate_bionic BIONIC_GUN)', () => {
  it('aims the detached fake gun without moving the wielded item or spending power', () => {
    const { game, combat, bio } = fixture();
    const knife = createItem(data, 'knife_combat');
    expect(game.player.inv.wield(knife, null).ok).toBe(true);
    const before = JSON.stringify(game.player.inv.toJSON());
    expect(bio.activate('bio_laser')).toBe(true);
    // Activation is refunded (BN refund_power); the bionic is never "powered".
    expect(bio.power).toBe(100); expect(bio.isActive('bio_laser')).toBe(false);
    expect(combat.weapon()?.typeId).toBe('bio_laser_gun');
    expect(activeWeapon(game)).toBe(combat.weapon());
    expect(game.player.inv.wielded).toBe(knife);
    expect(JSON.stringify(game.player.inv.toJSON())).toBe(before);
    expect(ownedIds(game)).not.toContain('bio_laser_gun');
    expect(bionicGunHud(game)).toMatchObject({ name: 'laser finger (CBM)', shots: 10 });
  });

  it('refuses without power for one shot (enough_power_for) or with no aiming hook, losing nothing', () => {
    const { combat, bio, log } = fixture('bio_laser', 9);
    expect(bio.activate('bio_laser')).toBe(false); expect(bio.power).toBe(9);
    expect(log.at(-1)).toMatch(/don't have the power/);
    bio.power = 100; const hook = bio.onGunActivation; bio.onGunActivation = null;
    expect(bio.activate('bio_laser')).toBe(false); expect(bio.power).toBe(100);
    bio.onGunActivation = hook;
    expect(bio.activate('bio_laser')).toBe(true);
    expect(combat.weapon()?.typeId).toBe('bio_laser_gun');
  });

  it('refuses to start aiming while a swing of the wielded weapon is under way', () => {
    const { game, combat, bio } = fixture();
    game.player.inv.wield(createItem(data, 'knife_combat'), null);
    combat.attack();
    expect(combat.swing).not.toBeNull();
    expect(bio.activate('bio_laser')).toBe(false);
    expect(bionicGunSession(game)).toBeNull(); expect(bio.power).toBe(100);
  });
});

describe('firing a bionic gun', () => {
  it("deals the fake gun's damage, pays act_cost per fired shot and leaves the wielded gun untouched", () => {
    const { game, sys, combat, bio } = fixture();
    const glock = wieldLoadedGlock(game);
    const rounds = glock.ammoRemaining();
    const m = target(game, sys), hp = m.hp;
    expect(bio.activate('bio_laser')).toBe(true);
    expect(combat.fire()).toBe(true);
    expect(bio.power).toBe(90);
    expect(m.hp).toBeLessThan(hp);
    expect(combat.shots).toBe(1);
    expect(glock.ammoRemaining()).toBe(rounds);
    expect(game.player.inv.wielded).toBe(glock);
    // BN AIM_AFTER_FIRING: still aiming the same fake gun after the shot.
    expect(combat.weapon()?.typeId).toBe('bio_laser_gun');
    expect(ownedIds(game)).not.toContain('bio_laser_gun');
  });

  it("stops aiming once the next shot can't be paid, handing back the same wielded item", () => {
    const { game, combat, bio, log } = fixture('bio_laser', 15);
    const glock = wieldLoadedGlock(game);
    expect(bio.activate('bio_laser')).toBe(true);
    expect(combat.fire()).toBe(true);
    expect(bio.power).toBe(5);
    expect(bionicGunSession(game)).toBeNull();
    expect(combat.weapon()).toBe(glock);
    expect(log.some((l) => /out of power/.test(l))).toBe(true);
  });

  it('a jammed fake gun refuses without spending power', () => {
    const { game, combat, bio } = fixture();
    expect(bio.activate('bio_laser')).toBe(true);
    combat.weapon()!.vars.jammed = 1;
    expect(combat.fire()).toBe(false);
    expect(bio.power).toBe(100); expect(combat.shots).toBe(0);
    expect(bionicGunSession(game)).not.toBeNull();
  });

  it('a burst stops when power runs out mid-burst: only fired shots are paid, unfired time is given back', () => {
    const { game, combat, bio } = fixture('bio_blaster', 100);
    expect(bio.activate('bio_blaster')).toBe(true);
    combat.weapon()!.vars.gun_mode = 'burst'; // fusion blaster "triple shot" at 50 kJ a shot
    expect(combat.fire()).toBe(true);
    expect(bio.power).toBe(50); expect(combat.burst?.left).toBe(2);
    const fullCooldown = combat.cooldown; // first shot's cooldown + 2 burst intervals
    let elapsed = 0;
    for (let i = 0; i < 20 && combat.burst; i++, elapsed += 0.05) combat.update(game, 0.05);
    expect(combat.shots).toBe(2);
    expect(bio.power).toBe(0);
    expect(combat.burst).toBeNull();
    expect(bionicGunSession(game)).toBeNull();
    // The refused third round's 0.075 s burst interval is given back.
    expect(combat.cooldown).toBeCloseTo(fullCooldown - elapsed - 0.075, 5);
  });

  it('a burst also stops when power is drained by something else between shots', () => {
    const { game, combat, bio } = fixture('bio_blaster', 200);
    expect(bio.activate('bio_blaster')).toBe(true);
    combat.weapon()!.vars.gun_mode = 'burst';
    expect(combat.fire()).toBe(true);
    expect(bio.power).toBe(150);
    bio.power = 10;
    for (let i = 0; i < 20 && combat.burst; i++) combat.update(game, 0.05);
    expect(combat.shots).toBe(1); expect(bio.power).toBe(10);
    expect(combat.burst).toBeNull(); expect(bionicGunSession(game)).toBeNull();
  });

  it('delayed burst rounds come from the fake gun even when the wielded item changes mid-burst', () => {
    const { game, combat, bio } = fixture('bio_blaster', 500);
    game.player.inv.wield(createItem(data, 'knife_combat'), null);
    expect(bio.activate('bio_blaster')).toBe(true);
    const fake = combat.weapon()!;
    fake.vars.gun_mode = 'burst';
    expect(combat.fire()).toBe(true);
    // Swap to a loaded pistol while rounds 2 and 3 are still pending.
    const glock = wieldLoadedGlock(game);
    const rounds = glock.ammoRemaining();
    for (let i = 0; i < 20 && combat.burst; i++) combat.update(game, 0.05);
    expect(combat.shots).toBe(3);
    expect(bio.power).toBe(500 - 150);
    expect(glock.ammoRemaining()).toBe(rounds);
    expect(combat.weapon()).toBe(fake);
  });

  it("applies the fake gun's own ammo effects (PLASMA aoe fields) with no gun wielded", () => {
    const { game, sys, combat, bio } = fixture('bio_blaster', 100);
    const fields: { type: string; intensity: number }[] = [];
    combat.hooks.addField = (_x, _y, _z, type, intensity) => void fields.push({ type, intensity });
    target(game, sys);
    expect(bio.activate('bio_blaster')).toBe(true);
    for (let i = 0; i < 2; i++) { combat.cooldown = 0; combat.fire(); }
    expect(combat.shots).toBe(2);
    // BN PLASMA aoe: radius 1 (loader default), chance 50, fd_plasma 2–3; at most 9 tiles a shot.
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.length).toBeLessThanOrEqual(18);
    for (const f of fields) {
      expect(f.type).toBe('fd_plasma');
      expect(f.intensity).toBeGreaterThanOrEqual(2); expect(f.intensity).toBeLessThanOrEqual(3);
    }
  });
});

describe('cancelling and losing the bionic gun', () => {
  it('Esc (the menu key) stops aiming instead of opening the pause menu, restoring the wielded item', () => {
    const { game, combat, bio, log, menuOpened } = fixture();
    const glock = wieldLoadedGlock(game);
    expect(bio.activate('bio_laser')).toBe(true);
    game.keys.handler('menu')!();
    expect(menuOpened()).toBe(0);
    expect(bionicGunSession(game)).toBeNull();
    expect(combat.weapon()).toBe(glock);
    expect(bio.power).toBe(100);
    expect(log.at(-1)).toMatch(/stop aiming your laser finger/);
    // With nothing aimed the key is the pause menu again.
    game.keys.handler('menu')!();
    expect(menuOpened()).toBe(1);
  });

  it('cancelling mid-burst stops the remaining rounds and charges nothing more', () => {
    const { game, combat, bio } = fixture('bio_blaster', 500);
    expect(bio.activate('bio_blaster')).toBe(true);
    combat.weapon()!.vars.gun_mode = 'burst';
    expect(combat.fire()).toBe(true);
    game.keys.handler('menu')!();
    for (let i = 0; i < 20; i++) combat.update(game, 0.05);
    expect(combat.shots).toBe(1); expect(bio.power).toBe(450);
    expect(combat.burst).toBeNull();
  });

  it('removing the bionic ends aiming; so does death', () => {
    const a = fixture();
    expect(a.bio.activate('bio_laser')).toBe(true);
    a.bio.remove('bio_laser');
    a.combat.update(a.game, 1 / 30);
    expect(bionicGunSession(a.game)).toBeNull();
    expect(a.combat.weapon()).toBeNull();
    expect(ownedIds(a.game)).not.toContain('bio_laser_gun');

    const b = fixture();
    expect(b.bio.activate('bio_laser')).toBe(true);
    b.game.player.dead = true;
    b.combat.update(b.game, 1 / 30);
    expect(bionicGunSession(b.game)).toBeNull();
    expect(b.bio.power).toBe(100);
  });

  it('nothing of the aim is saved, and loading a save drops it', () => {
    const { game, combat, bio } = fixture();
    const knife = createItem(data, 'knife_combat');
    game.player.inv.wield(knife, null);
    expect(bio.activate('bio_laser')).toBe(true);
    const saved = JSON.stringify({ inv: game.player.inv.toJSON(), bio: bio.toJSON() });
    expect(saved).not.toContain('bio_laser_gun');
    game.events.emit('gameLoaded', { slot: 'test' });
    expect(bionicGunSession(game)).toBeNull();
    expect(combat.weapon()).toBe(knife);
  });
});

describe('ammo_required (BN item::ammo_required)', () => {
  it('fake bionic guns need no ammo and fire with nothing loaded, consuming nothing', () => {
    const { game } = fixture();
    for (const id of ['bio_laser_gun', 'bio_blaster_gun', 'bio_lightning', 'bio_emp_gun']) {
      const gun = createItem(data, id);
      expect(ammoRequired(gun)).toBe(0);
      const shot = fireGun(game.player, gun, new Rng(4));
      expect(shot.ok).toBe(true); expect(shot.damage.length).toBeGreaterThan(0);
      // BN item::ammo_effects: the gun's own effects ride on the shot.
      expect(shot.ammoEffects).toEqual(expect.arrayContaining(gun.def.ammo_effects as string[]));
      expect(gun.ammoRemaining()).toBe(0);
    }
  });

  it('conventional guns need ammo_to_fire rounds; FIRE_100 and ammo_to_fire override 1', () => {
    const { game } = fixture();
    expect(ammoRequired(createItem(data, 'glock_19'))).toBe(1);
    expect(fireGun(game.player, createItem(data, 'glock_19'), new Rng(4)).ok).toBe(false);
    expect(ammoRequired(createItem(data, 'aux_flamer'))).toBe(100); // FIRE_100
    expect(ammoRequired(createItem(data, 'rm451_flamethrower'))).toBe(20); // ammo_to_fire 20
    const glock = createItem(data, 'glock_19', { ammo: 'default' });
    const n = glock.ammoRemaining();
    expect(fireGun(game.player, glock, new Rng(4)).ok).toBe(true);
    expect(glock.ammoRemaining()).toBe(n - 1);
  });

  it('a gun holding fewer charges than ammo_required refuses; a shot consumes exactly ammo_required', () => {
    const { game } = fixture();
    const thrower = createItem(data, 'rm451_flamethrower', { ammo: 'default' });
    const loaded = thrower.ammoRemaining();
    expect(loaded).toBeGreaterThanOrEqual(20);
    expect(fireGun(game.player, thrower, new Rng(4)).ok).toBe(true);
    expect(thrower.ammoRemaining()).toBe(loaded - 20);
    thrower.ammoConsume(thrower.ammoRemaining() - 19);
    expect(fireGun(game.player, thrower, new Rng(4)).ok).toBe(false);
    expect(thrower.ammoRemaining()).toBe(19);
  });
});

describe('UPS-powered guns (BN ups_charges / get_gun_ups_drain)', () => {
  /** A UPS_off holding a heavy battery with `charges` kJ, carried in a worn backpack. */
  function carryUps(game: Game, id: 'UPS_off' | 'adv_UPS_off', charges: number): Item {
    const p = game.player;
    if (!p.inv.topLevel().some((i) => i.typeId === 'backpack')) expect(p.inv.wear(createItem(data, 'backpack'), null).ok).toBe(true);
    let u: Item;
    if (id === 'adv_UPS_off') u = createItem(data, 'adv_UPS_off', { charges });
    else {
      u = createItem(data, 'UPS_off');
      const bat = createItem(data, 'heavy_battery_cell');
      loadAmmo(bat, 'battery', charges);
      expect(spawnItem(bat, L.mag(u)).ok).toBe(true);
    }
    expect(p.inv.giveNew(u)).not.toBeNull();
    expect(u.ammoRemaining()).toBe(charges);
    return u;
  }
  function wieldLaser(game: Game): Item {
    const gun = createItem(data, 'laser_rifle');
    expect(game.player.inv.wield(gun, null).ok).toBe(true);
    return gun;
  }

  it('laser_rifle needs no rounds but 40 UPS charges a shot, and refuses with no UPS', () => {
    const { game, combat, log } = fixture();
    const gun = wieldLaser(game);
    expect(ammoRequired(gun)).toBe(0);
    expect(upsDrain(gun)).toBe(40);
    expect(fireGun(game.player, gun, new Rng(4)).ok).toBe(false);
    expect(log.at(-1)).toMatch(/UPS with at least 40 charges or an advanced UPS with at least 20/);
    const refused: string[] = [];
    game.events.on('attackRefused', (e) => refused.push(e.reason));
    expect(combat.fire()).toBe(false);
    expect(combat.shots).toBe(0);
    expect(refused).toContain('not enough UPS charge');
  });

  it('a shot drains exactly 40 charges from a UPS; one left short refuses and keeps its charge', () => {
    const { game, combat } = fixture();
    wieldLaser(game);
    const u = carryUps(game, 'UPS_off', 79);
    expect(combat.fire()).toBe(true);
    expect(u.ammoRemaining()).toBe(39);
    combat.cooldown = 0;
    expect(combat.fire()).toBe(false);
    expect(u.ammoRemaining()).toBe(39);
    expect(combat.shots).toBe(1);
  });

  it('an advanced UPS (ups_eff_mult 2) gives 40 useful charges for 20 of its own', () => {
    const { game } = fixture();
    const gun = wieldLaser(game);
    const u = carryUps(game, 'adv_UPS_off', 100);
    expect(fireGun(game.player, gun, new Rng(4)).ok).toBe(true);
    expect(u.ammoRemaining()).toBe(80);
    expect(game.player.inv.upsCharges()).toBe(160);
  });

  it("the auto burst is capped by what the UPS can pay (charges_of(UPS) / drain)", () => {
    const { game, combat } = fixture();
    const gun = wieldLaser(game);
    gun.vars.gun_mode = 'AUTO'; // 4 rounds
    const u = carryUps(game, 'UPS_off', 100);
    expect(combat.fire()).toBe(true);
    expect(combat.burst?.left).toBe(1); // 100 / 40 = 2 shots
    for (let i = 0; i < 20 && combat.burst; i++) combat.update(game, 0.05);
    expect(combat.shots).toBe(2);
    expect(u.ammoRemaining()).toBe(20);
  });

  it('a gun needing rounds and UPS (coilgun) refuses without UPS even when loaded', () => {
    const { game } = fixture();
    const coil = createItem(data, 'coilgun', { ammo: 'default' });
    const n = coil.ammoRemaining();
    expect(n).toBeGreaterThan(0);
    expect(fireGun(game.player, coil, new Rng(4)).ok).toBe(false);
    expect(coil.ammoRemaining()).toBe(n);
    const u = carryUps(game, 'UPS_off', 50);
    expect(fireGun(game.player, coil, new Rng(4)).ok).toBe(true);
    expect(coil.ammoRemaining()).toBe(n - 1);
    expect(u.ammoRemaining()).toBe(50 - upsDrain(coil));
  });
});
