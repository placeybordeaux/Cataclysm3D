# Recharging

Find a vehicle with a **battery charger** (15 W) or **recharging station**
(600 W) and a cargo compartment on the same square. Additional parts can be fitted through [queued vehicle work](VEHICLE_WORK.md);
existing prototypes also supply chargers.
Examine the vehicle, select the square containing the charger, and choose
**Enable battery charger/recharging station**. Open that square's cargo and put
rechargeable batteries or devices there. Close menus and let time pass (waiting
also works). The engine can be off; the vehicle needs stored battery power.

Chargers refill `RECHARGE` and `USE_UPS` items, including batteries inside
containers and rechargeable magazines installed in devices. Disposable and
plutonium cells cannot be charged. Empty magazine wells stay empty. Broken or
disabled chargers and broken cargo do not charge. A charger serves cargo only
at its own mount. Enabled state and fractional charge progress survive saves.

BN reference: `src/map/map.cpp`, `process_vehicle_items`, and
`src/vehicle/vehicle.cpp`, `get_cargo_recharge_targets`. The part's `bonus` is
watts **per eligible item**; one ammunition charge is 1 kJ. This port accumulates
fractional kJ deterministically instead of BN's random rounding, spending the
vehicle energy immediately and storing the credit on the actual rechargeable
item (the magazine for magazine-fed tools). Charging uses elapsed game time,
including activity time warps, and stops at capacity or when power runs out.

This implements vehicle cargo charging. Connected
vehicle power networks and electrical-grid charging remain separate implementation
gaps. Transfer from a carried UPS into carried `USE_UPS` devices is described in
[UPS_TRANSFER.md](UPS_TRANSFER.md).

Implementation: `src/game/recharging.ts`; integration: `VehicleSystem.update`;
controls: modern vehicle screen and legacy part menu. Automation:
`cdda.vehicleCharging(uid?, enabled?, seconds?)` inspects chargers and cargo,
optionally toggles them or advances charging alone for a supplied duration.
Tests: `tests/recharging.test.ts` covers units, fractional save state, capacity,
power exhaustion, disabled/broken/wrong-mount chargers, disposable batteries,
nested items, magazine charging, and game-time integration.

Validation: typecheck and production build passed; 47 recharge/reload-help checks
passed. The full suite passed 1555 checks, with two failures outside the recharge
change (crafting disassembly recovery and furniture-interaction expectations).
A headful Chromium session verified enabling the charger using OS-level Enter,
then confirmed 100 game seconds at 15 W transferred 1.5 kJ: one battery charge
plus 0.5 kJ saved credit. The resulting vehicle screen was visually inspected:
[charger enabled](screenshots/screens/recharging.png).

## Solar generation

Vehicles with intact solar panels now recharge their intact batteries automatically
while parked or moving. No switch or running engine is needed. Panels must be above
ground, outside, and have daylight; roofs, night, and heavy weather block output.
Panel damage reduces output. Waiting advances generation in game time, with sunlight
sampled every game second across long waits. Artificial light and moonlight never
generate power. Battery capacity limits output, and battery state is already saved.

BN reference: `src/vehicle/vehicle.cpp`, `update_time`: panel epower is watts,
`default_daylight_level()` is 100, and one battery charge is 1 kJ. This adaptation
uses deterministic fractional battery storage and the current weather during a wait.
Implementation: `src/game/vehiclePower.ts`; tests: `tests/vehiclePower.test.ts`.

## Reactors

Examine a square containing a minireactor, carry plutonium fuel cells, and choose
**Load plutonium fuel cell into minireactor**, then **Enable minireactor**. Fuel disappears
from carried inventory through the item movement API; capacity is 10,000 charges.
Reactors produce only energy that intact batteries can store, stop when empty,
and can be disabled from the same panel. Damaged reactors produce less power.
Saved part charges preserve fractional consumption exactly. No engine is needed.

BN `vehicle::power_parts` treats reactor `power` as **kJ per fuel charge**:
the minireactor outputs 100 kW and yields 100 kJ per plutonium charge. This is
different from fuel combustion energy. The port consumes fractional charges
rather than using BN's random rounding. Solar, reactors and cargo chargers
interleave once per game second during long waits, preventing lost solar output
against an initially full battery. Roof checks extend to the world's maximum z.

Validation: 56 vehicle/power/recharge regression tests, typecheck and production
build pass. In a headful browser, OS-level Enter loaded five actual carried fuel
charges and enabled the reactor. Advancing 0.5 game seconds after draining the
battery produced exactly 50 kJ and consumed 0.5 fuel charges. The corrected fuel
charges gauge and enabled action were visually inspected:
[reactor panel](screenshots/screens/reactor.png).

Power-loop measurement (`tools/dev/vehicle-power-bench.ts`): 30 vehicles, each
with battery, solar panel, 600 W charger and a battery in cargo, advanced 120 game
seconds per tick; 25 samples after warmup measured p50 3.48 ms, p95 3.81 ms,
maximum 4.68 ms on this machine. Exposure is scanned once per vehicle tick.

## Carried UPS

A carried UPS charges carried UPS-powered devices at BN's 5 kJ/s (advanced UPS: 10 kJ/s
at efficiency 2) and powers `USE_UPS` tools directly; see [UPS_TRANSFER.md](UPS_TRANSFER.md).
