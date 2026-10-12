# Bright Nights bionic guns

Read-only source: Cataclysm-BN `src/bionics.cpp` activate_bionic (BIONIC_GUN branch, 715–725; `act_cost` loaded as kJ at 301; `enough_power_for` in `character.cpp` 2414), `src/avatar_action.cpp` fire_ranged_bionic (1160), `src/activity_actor.cpp` aim_activity_actor::use_bionic / do_turn / finish (135–265), `src/ranged.cpp` fire_gun (1301–1530), make_gun_projectile (2390), `src/item.cpp` ammo_required (8609) and ammo_effects (8793), `src/projectile.cpp` apply_ammo_effects (113), `src/ammo_effect.cpp` aoe loader defaults.

## What is implemented

Turning on a BIONIC_GUN bionic (Finger-Mounted Laser, Fusion Blaster Arm, EMP Projector, Chain Lightning) in the bionics panel (`p`) requires the power for one shot (BN `power >= power_activate`). It announces the activation, refunds the cost and closes the panel. The bionic's `fake_item` is created as a detached gun (`src/game/bionicguns.ts`). It is never wielded or placed in the inventory or on the ground, and it is not saved. The wielded item stays where it is, and that exact object is back in use when aiming ends.

While aiming, left click or `f` fires the fake gun, `b` cycles its modes (the blaster's triple shot), and right mouse aims. The HUD weapon box shows the gun, its kJ cost per shot, the shots that power allows and "Esc stops". The bionic card lists the cost as per shot. The ADS zoom, aim readout, spread circle, top-view aim line and aim hints read the aimed gun through `activeWeapon()`.

Each shot that actually fires pays `act_cost` kJ through `BionicState.modPower`. A refused shot pays nothing, whether it was jammed or lacked power. This matches BN's `bp_cost_per_shot × shots_fired`, charged only when `shots_fired > 0`. Hitscan impact uses the gun that fired the round. Burst rounds carry their own gun reference, so they keep coming from the fake gun even if the wielded item is swapped mid-burst.

Aiming persists after a shot, matching BN's AIM_AFTER_FIRING (default on). It ends when:
- Esc (the menu key) is pressed. As in BN's aiming UI, this does not open the pause menu.
- The next shot can't be paid.
- The bionic is removed.
- The survivor dies.
- A save is loaded. Every activity is dropped on load here (`save/format.ts`).

Ending mid-burst stops the remaining rounds and gives back their burst time.

**ammo_required audit.** BN `item::ammo_required` for guns: 0 when the gun has no ammo types, 100/50/20 for FIRE_100/50/20, else `ammo_to_fire × Π ammo_to_fire_multiplier + Σ ammo_to_fire_modifier`, truncated. Now implemented as `ammoRequired()` in `src/game/gunmods.ts` and used by `fireGun`:
- A gun refuses when it holds fewer than the required rounds (BN `ammo_sufficient`).
- Each shot consumes exactly that many rounds.
- A burst is capped at `remaining / required` (BN fire_gun).

Before this change every gun used 1 round per shot. That under-charged flamethrowers (`ammo_to_fire` 20/50/100, `aux_flamer` FIRE_100). Fake bionic guns need 0 and fire with nothing loaded. Recoverable-ammo recovery (arrows) applies only to guns that need exactly 1 round.

**UPS-powered guns.** BN `item::get_gun_ups_drain` is `ups_charges × Π ups_charges_multiplier + Σ ups_charges_modifier`, truncated. It is implemented as `upsDrain()`, with `upsShots()` and `gunShortfall()` alongside, in `gunmods.ts`.
- **Who:** this applies to the player and to NPCs, whose only firing path is `fireGun`.
- **Refusal:** like `gunmode_checks_weapon`, a gun refuses unless the carried UPS charge (`Inventory.upsCharges()`) covers one shot. The message is BN's "You need a UPS with at least N charges or an advanced UPS with at least N/2 charges…". The crosshair reason is "not enough UPS charge".
- **Charging:** each fired shot draws the drain through `Inventory.useUpsCharges()`, which applies `ups_eff_mult` (an advanced UPS spends half its own charge) and keeps fractional credit.
- **Bursts:** capped at UPS charge ÷ drain, as in `fire_gun`.
- **Exemption:** VEHICLE guns are exempt, as in BN.
- **NPCs:** an NPC whose gun lacks UPS charge puts the gun away instead of dry-firing.
- **What this fixed:** the first `ammoRequired()` commit let ammo-less UPS guns (laser rifle, V29, EMP gun, laser cannon, unbio blaster) fire for free. Before it, they could never fire. UPS guns that also take rounds (coilgun, rail and plasma rifles) now also need UPS charge, which they previously ignored.
- **Monster guns:** monster gun attacks (`monguns.ts` gunActor: acid spit, monster EMP gun, turrets) do not use `fireGun` and are unchanged. In BN, their fake shooter carries a 1000-charge UPS.
- **Not modelled:** `bio_ups` and mech batteries are not UPS sources (see UPS_TRANSFER.md).

**Ammo effects.** Shots carry BN `item::ammo_effects`: the gun's `ammo_effects`, the loaded ammo's and the gunmods'. The extracted `aoe` of an ammo effect is a single object. The old code iterated it as an array, which threw on PLASMA (and FLAME/NAPALM) hits. It now follows `apply_ammo_effects`: every tile within `radius` (loader default 1) has a `chance`% (default 100) roll for a field of `rng(intensity_min, intensity_max)`.

## Adaptations from BN

- BN charges the whole burst after it is fired and never re-checks power while re-aiming. As a result, BN lets a bionic gun keep firing at 0 kJ (`mod_power_level` clamps). Here, burst rounds are real-time events: each one is paid as it fires. A burst stops when the next round can't be paid, and aiming ends with "out of power".
- BN's re-aim stops when no targets remain (`abort_if_no_targets`). That is not modelled: aiming lasts until one of the endings listed above.
- BN saves the aim activity, including the fake weapon. Here, aiming is dropped on load like every other activity.

## Limitations (not implemented)

- **Effect fidelity.** The following are not modelled. Their damage applies, but the special behaviour does not.
  - EMP blast: `EMP`, `do_emp_blast`, on the EMP Projector.
  - Chain/bouncing lightning: `BOUNCE`/`LIGHTNING`, on Chain Lightning.
  - Projectile trail fields: the laser `fd_laser`, the plasma `fd_plasma` and the lightning `fd_electricity` trails.
  - `WIDE`, `DRAW_AS_LINE` and `NO_PENETRATE_OBSTACLES`.
  - The aoe `check_sees`/`check_passable` gates.
  - PLASMA's impact aoe and INCENDIARY are applied. Fidelity is not complete.
- **NPCs never fire bionic guns.** BN's `npc::check_or_use_weapon_cbm` / `cbm_fake_active` and the NPC CBM reserve rule are not ported.
- **First-person view.** The first-person hands keep showing the wielded item while a bionic gun is aimed. There is no dedicated bionic-gun viewmodel or firing animation.
- **No UPS for bionic guns.** None of the BN bionic guns use UPS drain, so `get_gun_ups_drain` is not involved here.

## Validation

`tests/bionicguns.test.ts` (22 tests) covers:
- Activation refund and power gating.
- The wielded item's identity and inventory are unchanged, and the fake gun is never owned.
- The first shot's damage and payment, and the wielded gun's ammo is untouched.
- The session ends when the next shot can't be paid.
- A jammed refusal costs nothing.
- Burst exhaustion when power runs out mid-burst, and when power is drained externally between rounds. Unfired time is given back.
- Delayed burst rounds come from the fake gun after a wield swap.
- PLASMA aoe fields.
- Esc stops aiming and does not open the menu; the menu opens on the next Esc.
- Cancelling mid-burst.
- Removing the bionic, and death.
- Nothing saved; a load drops the aim.
- `ammo_required`: 0 for fake guns, 1, 20, FIRE_100, insufficient charges, and exact consumption.
- UPS: laser rifle refuses without UPS; it drains exactly 40 from a UPS and 20 own charge from an advanced UPS; the auto burst is capped by UPS; a loaded coilgun needs UPS (5 tests).
- In `tests/npcs.test.ts`: an NPC fires a laser rifle on adv_UPS charge and puts it away without any.

Interactive check: headful Chromium under Xvfb with OS-level xdotool input (`tools/drive.ts --headful`, `realinput=1`, classic look). Debug helpers were used only for setup: installing the bionics, giving power, wielding a knife, spawning a zombie and making it immobile. Everything else was real key and mouse input:
- `p` opened the bionics panel and Enter activated the Finger-Mounted Laser. The panel closed and the HUD showed "laser finger (CBM) · 10 kJ/shot".
- Holding RMB zoomed (ADS). A left click hit the zombie for 5 damage, and power went from 250 to 240.
- `f` fired from the key, and power went from 100 to 90.
- Esc stopped aiming. "You stop aiming your laser finger." appeared, no pause menu opened, the HUD returned to the combat knife and power was unchanged.
- The Fusion Blaster Arm, switched with `b` to triple shot at 100 kJ, fired two rounds (one hit for 16). The third was refused with "not enough bionic power (50 kJ per shot)". Aiming then ended with "out of power" and the knife was back in the HUD.

Inspected screenshots:
- [panel card](screenshots/gaps/bionic-gun-menu.png)
- [activated](screenshots/gaps/bionic-gun-activated.png)
- [aiming down sights](screenshots/gaps/bionic-gun-aiming.png)
- [hit](screenshots/gaps/bionic-gun-fired.png)
- [Esc cancel](screenshots/gaps/bionic-gun-cancelled.png)
- [blaster triple-shot mode](screenshots/gaps/bionic-blaster-burst-mode.png)
- [burst stopped by power](screenshots/gaps/bionic-blaster-burst-exhausted.png)
