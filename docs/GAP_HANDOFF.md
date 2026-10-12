# Gap implementation handoff — 2026-10-07 (second session)

The three bounded tasks from the first handoff and every "next independent package"
except the larger lanes below are reviewed, merged into `gaps-20261004-integration`
and applied to the original checkout (uncommitted, alongside the user's own work;
branch/index untouched). Integration and the original checkout both pass 147 files /
1,878 tests, typecheck and production build. Details per package:
[GAP_IMPLEMENTATION_WORK.md](GAP_IMPLEMENTATION_WORK.md); scope inventory:
[IMPLEMENTATION_GAPS.md](IMPLEMENTATION_GAPS.md).

## Delivered this session

Carried UPS transfer (+ advanced-UPS efficiency fix in direct draw); first-use flora
atlas partial uploads; bionic guns (+ BN `ammo_required`, UPS-powered gun drain —
the lead caught ammo-less UPS guns firing free); vehicle beds/seats and BN workbench
selection (furniture benches now apply speed too — a behaviour change to confirm with
the user); power armor activation and interface CBM; rubble saved progress and helper
speed; deferred tool-use gestures (+ the `u` picker's empty Use submenu fix); BN item
action names in Use menus; NPCs in the line of fire (stray hits no longer anger NPCs);
achievement coverage verified complete (gap was stale). A reported reload item loss was
a drive-tool artifact (webdriver skips the title); `tools/realinput_saveload.ts` guards it.

## Decisions (user, 2026-10-09)

1. Furniture workbenches keep BN speed (×1.2 etc., ground ×0.7 for large crafts) — **kept**.
2. Stray projectile hits don't provoke NPCs (only the aimed-at NPC), as BN — **kept**.

## Remaining packages (each needs its own bounded package)

Status 2026-10-09: anatomy delivered (per-strike rolls on apply, BN venom; bodies were
already BN's 12-part anatomy, see [BN_MUTATION_ATTACKS.md](BN_MUTATION_ATTACKS.md)).
World transport audited, see [WORLD_TRANSPORT.md](WORLD_TRANSPORT.md) for the ranked gaps. Vehicle
physics is now a feel pass toward GTA 3 / Vice City, not BN parity. The rest stay TODO.

Networks/grid power; towing/coupling, turrets/ammo feed, crew/autopilot; walkable
parked rigs; world transport content; broader dialogue conditions/effects;
physics/anatomy; remaining art/performance (worker meshing, dynamic crowd transforms,
LOD transitions). Smaller follow-ups are listed in each package's "Remaining scope"
row. Known flake: `tests/inventory_ui2.test.ts` fuzz can exceed its 5 s timeout under
machine load; it passes alone.

Worktrees: `/tmp/cdda-gap-work-20261004/{vehicles,simulation,presentation,integration}`
(lane branches have been merged; merge integration into a lane before starting work).
Apply to the original checkout as per-package `git diff` patches — the checkout has
diverged from integration, so never copy the tree wholesale.
