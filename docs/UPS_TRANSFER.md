# Carried UPS charging

Carry a charged UPS and a UPS-powered device. The UPS tops the device up on its own
while game time passes, waiting included. Inventory menus pause the game, so nothing
charges while one is open. Some devices only do this once switched on. Examples are
the handheld game, professional camera, game watch and electric jackhammer. Open the
inventory (`i`), right-click the device and choose **Use ▸ Enable UPS charging**.
**Use ▸ Disable UPS charging** turns it off again. Each choice prints BN's message.
The setting is saved with the item.

The device's tooltip shows its state. It can say "Charging from your UPS (n/cap)", "Fully
charged", "Not charging: you carry no UPS" or "Not charging: your UPS is out of charge".
It can also say "UPS charging is off: Use ▸ Enable UPS charging". A UPS's own tooltip
shows how much usable energy it holds and its rate. An advanced UPS also shows its
efficiency. A UPS that runs dry while a device still wants charge logs one message:
"Your UPS has no charge left for your …". Reload help no longer says "You don't have one"
for a UPS-charged device when you carry a charged UPS.

## BN rules and units

Source: `Character::process_items` (`src/character_turn.cpp`, recharging after active
item processing), `needs_elec_charges` (same file), `Character::use_charges` for
`itype_UPS` (`src/character.cpp`), `charges_of_ups` (`src/visitable.cpp`), the loader
`item_factory.cpp` `load_tool` (`ups_eff_mult`, `ups_recharge_rate`), and the defaults
in `itype.h` `islot_tool` (`ups_eff_mult = 1`, `ups_recharge_rate = 5`). The toggle is
`iuse::toggle_ups_charging` (`src/iuse.cpp`). Item data is in
`data/json/items/tool/electronics.json`.

| Item | `ups_recharge_rate` | `ups_eff_mult` | Useful kJ/s | UPS charge per useful kJ |
| --- | --- | --- | --- | --- |
| `UPS_off` | 5 (default) | 1 (default) | 5 | 1 |
| `adv_UPS_off` | 10 | 2 | 10 | 0.5 |

- The rate is in useful charges per turn. A BN turn is one second: `from_turns` and
  `from_seconds` in `calendar.h` build the same duration. One battery charge is 1 kJ.
- Each UPS offers `min(stored × ups_eff_mult, ups_recharge_rate × seconds)`. Offers from
  several UPSes add up. The order is wielded item, then carried items, then worn items,
  as in BN.
- A target needs `USE_UPS` (from its type, or the item's own tag set by the toggle). It
  must not be full. If it holds a magazine, that magazine must be `RECHARGE`. It is
  filled up to capacity.
- The UPS loses `delivered / ups_eff_mult` of its own charge. Energy is conserved in
  useful kJ: `UPS stored × ups_eff_mult + device stored` stays the same, with no loss
  term (BN has none). The advanced UPS is "efficient" because each of its own charges is
  worth 2 useful kJ. Nothing is delivered that was not drawn.

## Adaptations (deliberate)

- **Exact fractions instead of BN's random rounding.** BN rounds `used % ups_eff_mult` with
  `x_in_y`. Here every battery keeps the fraction as `vars.recharge_kj`. That is the same
  credit the vehicle chargers use, kept on the actual battery (the UPS's magazine, or
  the integral device or UPS). It survives saves. Fractional seconds deliver fractional kJ, so
  the result doesn't depend on frame rate. Taking part of a kJ from a whole charge breaks
  one charge and keeps the change as credit.
- **Each UPS pays for what it gave.** BN's `use_charges` drains UPSes in visit order. So
  the budget an advanced UPS earned can be paid by a regular one. Here each UPS loses only
  what it contributed.
- **Nested belongings.** BN's flat inventory holds everything you carry. The port keeps
  things in containers, so devices and UPSes in bags, worn storage and holsters count.
  Unfinished crafts are skipped along with everything inside them. Their components are
  escrowed, the same pruning `npcneeds.ts` uses. A UPS or device inside an in-progress
  craft is never drawn from or charged.
- **No phantom magazines.** BN's `ammo_set` on a device with an empty magazine well would
  create a default magazine. Here such a device is skipped.
- A UPS is never a target, and RECHARGE-only devices (smartphones) are not charged. In
  BN they need a vehicle charger, see [RECHARGING.md](RECHARGING.md).

## Direct UPS draw fix

USE_UPS tools that run from a carried UPS (an active exo-suit with a flat cell, transform
`need_charges` checks) used to count an advanced UPS 1:1. That gave it half its BN value.
`Inventory.upsCharges()` now returns `Σ stored × ups_eff_mult`, rounded down.
`useUpsCharges(n)` takes `n / ups_eff_mult` of each UPS's own charge, keeping the exact
fraction. Both skip UPSes escrowed in unfinished crafts. An active item now pays from a
UPS only when at least one whole useful charge is available.

## Implementation and tests

- `src/game/upsTransfer.ts`: energy helpers, the transfer, the status line and the toggle
  label. `Inventory.update` calls it every frame for every character, NPCs included.
  `Inventory.useFrom` handles `TOGGLE_UPS_CHARGING`.
- UI: the ui2 item tooltip note (`src/ui2/bn/model.ts`), the legacy item info
  (`src/ui/iteminfo.ts`) and the activate submenu labels (both inventories).
- `tests/upsTransfer.test.ts` has 19 checks:
  - source rates and efficiency, 5 and 10 kJ/s
  - fractional energy across a save/load with no leak, and the advanced UPS's half-charges
  - capacity, a finite UPS, several UPSes, and a 400-step random conservation run
  - draw/add guards, nested bags, crafts left untouched, and magazine rules
  - the toggle (messages, saved tag), the single dry-UPS message and status lines
  - the reload-help wording
  - the direct-draw efficiency regression, and an active exo-suit on an advanced UPS
- Real input: `tools/realinput_ups.ts`, run with
  `npx tsx tools/realinput.ts --only upscharge --params look=classic --shots …`. It uses
  OS-level `i`, right-click, Use ▸ Enable/Disable, `l` → `1` (wait 20 s) and tooltip hover.
  Debug calls are used only to hand out the items and drain the UPS. All 23 checks passed.
  Game time elapsed × 5 kJ arrived, and UPS loss equalled device gain exactly. Inspected
  screenshots:
  [off](screenshots/screens/ups-charging-off.png),
  [enable menu](screenshots/screens/ups-charging-enable-menu.png),
  [charging](screenshots/screens/ups-charging-charging.png),
  [disable menu](screenshots/screens/ups-charging-disable-menu.png),
  [out of charge](screenshots/screens/ups-charging-out-of-charge.png).

## Limitations

- `bio_ups` (BN adds up to 10 kJ/s of bionic power as UPS charge) and a mounted mech's
  battery are not sources. Neither is ported.
- Toolmods that grant `USE_UPS` (`battery_ups`) only count once the port propagates mod
  flags to their host. That was not checked or added here.
- The use-action submenu shows other BN action ids raw (e.g. "PORTABLE GAME"). That
  existed before and is unchanged here.
