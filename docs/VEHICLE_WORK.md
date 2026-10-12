# Vehicle work: adoption and queued fittings

Examine a vehicle, select a chassis square, and choose **Plan vehicle work…**.
Unlock it if needed and choose **Adopt this vehicle**. Park, stop the engine,
and release the controls before working. Work uses carried supplies and items
on nearby ground, including nested supplies, through the existing crafting and
item movement APIs.

Choose **Remove / salvage**, **Repair**, or **Install**, then a part. The panel
shows the work time and every unmet skill, tool, component or mounting condition.
**Add to work queue** records the plan. **Start queued work** runs an interruptible
activity; movement or danger stops it. Saved adoption, queue entries and elapsed
work survive loading, and **Resume queued work** continues. Supplies are checked
again during work and immediately before completion. Each completed job changes
the vehicle and proceeds to the next job; a job needing supplies or a closer
position stays queued. Discarding queued work consumes no supplies.

Choices and queue admission use the projected chassis after earlier queued jobs.
For example, queue a fitting's removal before installing its replacement into the
same location. The panel shows projected part count and mass and warns about
blocked queued jobs, including a dependency discarded from earlier in the queue.
The preview changes no real parts or supplies. Each actual job still validates
the real vehicle at execution. Supplies must currently be available; the planner
does not forecast salvage or reserve components for later jobs.
The geometry preview assumes successful operations and empty, fully intact new
installations; actual installation preserves the consumed item's condition.
Warnings remain visible for invalid saved or changed jobs, and the geometry
summary does not promise they can execute. Prospective mass omits supplies yet
to be consumed and the condition/fuel contents of future installations.

The [inspected projected queue](screenshots/screens/vehicle-work-projection.png)
was populated with real OS Enter on the replacement action after an existing
solar-panel removal; both jobs were queued while all 80 live parts remained.

**Queue stripping fittings across vehicle** schedules eligible fittings on every
square, removing attached fittings before their mounts. Frames remain installed.
Loaded tanks/batteries, occupied cargo, unsupported salvage and missing skills or
tools remain installed and appear in an individual blocker report. Planning can
include distant squares; actual execution pauses until you move within four
metres of the next square and resume. Repeating the action does not duplicate jobs.
The [inspected strip panel](screenshots/screens/vehicle-strip.png) used real OS
Enter to queue two solar panels on separate squares while preserving all 27
live parts and explaining why a battery with 50 kJ could not be removed.

Removal produces the actual part item on the ground with its condition. Installed
item metadata survives saving and later removal. Broken fittings yield BN's
`breaks_into` items, rolling the source ranges. Empty cargo and fuel before removal;
empty installation parts before fitting them. Liquid tanks can be emptied with
[siphoning](SIPHONING.md). These restrictions prevent contents,
ammunition or stored energy from silently disappearing. An empty matching part is
selected even when a loaded matching part is also present. Chassis frames remain
installed during the bulk strip action, so stripping fittings retains the adopted
vehicle's body template. To dismantle a chassis, select a frame with **Remove /
salvage** at a ground-level vehicle garage after removing its attached fittings.
BN `can_unmount` four-neighbour connectivity prevents splitting the remaining
vehicle; an alternate path allows removal. The final frame returns its actual
item and unregisters the empty vehicle. Partial frame removal keeps normal saved
queue progress. The same fitting/connectivity rules apply to BN `EXTENDABLE`
parts, including external buoyancy cells; the v3 garage requirement applies only
to parts whose location is `structure`.

The [inspected frame-removal panel](screenshots/screens/vehicle-frame-removal.png)
was operated with OS Enter to queue and run final-frame removal. Completion
unregistered that vehicle and left exactly one light wooden frame with damage1000.

Installations enforce an intact frame on the square, one part per location,
mounting flag dependencies, cargo exclusivity and template sockets. Repairs fully
restore an intact part, consuming BN requirements multiplied by its damage level;
broken parts must be removed and replaced. Parts marked `NO_REPAIR` cannot be fixed.

## Source rules

`tools/extract/vehicles.ts` now extracts work data for all 813 BN parts:
skills, flattened requirements, times, mounting `requires_flag` dependencies,
and broken-part yields. BN integer work times are moves divided by 100;
string times use seconds. Default installation and repair times are one hour,
and omitted removal times are half installation time. Installation adds the
part's base item requirement (`veh_type.cpp::finalize`). `using` replaces inline
lists like BN's `parse_vp_reqs`; the current BN vehicleparts scan found no entries
combining `using` with inline tools/components/qualities.

Runtime references:

- `veh_type.cpp::scale_time`: 10% reduction per excess skill level, capped at 50%.
- `veh_utils.cpp::repair_part`: material/tool charges scale by `damage_level(4)`,
  full repair, and time scales with the damage fraction (`veh_interact.cpp`).
- `veh_utils.cpp::calc_xp_gain`: installation difficulty/time and excess skill
  determine practice; successful removal awards half, and broken salvage none.
- `veh_interact.cpp::jack_quality`: current foundation retains BN's
  `ceil(min(mass, 8500 kg) / 500 kg)` and working `SELF_JACK` support. The agreed
  garage/chassis-class simplification needs authored planner classes later.

## Validation and limits

Unit/regression checks cover extraction, adoption and skill gates, socket
failures, saved partial progress, removal/reinstallation conservation and condition,
metadata preservation, fueled/cargo protections, empty-source selection, lost-tool
interruption, repair materials, failed shared-tool rollback and completion practice.
Typecheck and a production build pass. A headful Chromium session used OS Enter,
End, Tab and movement to adopt a car, select a solar panel, queue its removal,
start work, interrupt it at 1192.5 game seconds, and resume it. Completion left
one solar-panel item and removed exactly its installed part. The inspected
[work panel](screenshots/screens/vehicle-work.png) shows the retained progress.

`tools/dev/vehicle-work-bench.ts` measures checks with 501 actual carried items:
100 checks after 10 warmups measured p50 0.074 ms, p95 0.179 ms, max 4.13 ms locally.
No expensive-check cache is needed at these timings; completion always revalidates.

This is a selected-square work foundation. The complete v3 planner remains:
3D ghosts and prospective driving/handling stats,
authored lift classes and lifting assists, NPC helpers,
vehicle facility supplies, and per-socket attachment rendering. The queue currently
uses actual available supplies rather than reserving them at planning time. Normal
BN `NOINSTALL`, anchor and slot rules are supported. Engine exclusion classes are
extracted from vehicle-part definitions and checked across the vehicle like
`vehicle::has_engine_conflict`. Mirror/opaque conflicts preserve the camera
exception; distinct turret mounts cannot stack, and manual-only turrets reject
powered controls and laser designators. Existing `EXTENDABLE` cells reject other
attachments. Special outward installation of new `EXTENDABLE` cells and custom
chassis expansion remain part of the placement work.

[Chassis construction at a garage](VEHICLE_CHASSIS.md) is available from the modern
construction menu, including the authored Rig template.

Automation: `cdda.vehicleWork(uid?)`, `adoptVehicle(uid?)`,
`queueVehicleWork(uid, {kind, part, mx, my})`, `resumeVehicleWork(uid?)`.
