# Vehicles v3: chassis templates, sockets, and a planned build queue

Status: **design agreed 2026-09-30, not built.** Background and sources:
`docs/research/VEHICLE_BUILDING.md`. Current renderer/collision: `docs/VEHICLES.md`.

## Why

Cataclysm vehicles are free grids of 1 m cells. Drawn at real scale in 3D they are pancakes
(a stock car is 6×4 cells, twice a real car's width), so wave 3 squeezes the drawn body, which
makes the drawn car smaller than its gameplay footprint. And BN's building is hundreds of
15–60 minute single-part jobs with no planning and no reason when a part won't fit. Players
love the result (the "deathmobile", the mobile base) and hate the process.

## Decisions (user, 2026-09-30)

Direction **B + E** from the research: a ladder of chassis templates with sockets, plus
plan-first building with a queued, timed job.

| # | Question | Decision |
|---|---|---|
| 1 | One rig or a ladder? Adopt found vehicles? | **Ladder of sizes.** Any found vehicle can be adopted, and parts bolted on. |
| 2 | Ram or rolling home? | Solved by the ladder: small rungs are fast, the top rung is the home. |
| 3 | How do you get a chassis? | **Strip a vehicle down to its chassis, or build a chassis**, then build it up toward whatever model you're going for. |
| 4 | Stock vehicles move to templates too? | **Yes.** Every BN vehicle maps onto a template, so drawn body = gameplay body everywhere. |
| 5 | Keep BN's per-part skill/tool/lift gating, or collapse to "garage + mechanics level"? | **(a) Keep BN's per-part gating** (user agreed with the recommendation); only the jack/lift maths is replaced. |
| 6 | Timed installs or instant garage edits? | **Timed** — things take time, as elsewhere in the game. The plan is queued as one job. |
| 7 | Walk around inside while moving? | **Simplified:** the vehicle's facilities work from where you sit (see below). |
| 8 | Turrets, NPC crews | **Future work** (below). |

### Q4: why *not* move stock vehicles to templates? (and how we handle it)

Reasons it could hurt, each with the mitigation:

- **Odd BN grids** (golf carts, tractors, APCs, carts, player-style builds in the data) may not
  fit any template → a **"frame" template family** that is honest about being a home-made
  grid (today's `vehicleFrame.ts` look), with collision = its cells. Nothing is dropped.
- **BN fidelity**: some BN behaviour keys off cell positions (which part a crash hits, which
  seat you sit in, per-cell cargo) → sockets keep a BN location and a position on the body, so
  crash-by-side, seat and cargo still resolve; part stats are unchanged.
- **Saves**: existing saves hold grids → a one-time migration maps a saved grid onto its
  template (same routine that maps BN spawns), keeping part condition and contents.
- **Mapgen spawns** (wrecks, parking lots) place BN grids → mapped at spawn time by the same
  routine.

So: yes, with a mapping layer and a frame fallback.

### Q5: gating (decided: a)

Two readings of "yes":

- **(a) Keep BN's gating per part**: each part keeps its mechanics skill and tool qualities
  (wrench, screwdriver, welder); only the jack/lift maths is replaced by "work at a garage or
  with a jack of the chassis' class". Most faithful; the plan screen shows every missing
  requirement per part.
- **(b) Collapse**: a socket needs "garage (or field kit) + mechanics level N" per template
  size; tools are checked once for the whole job.

Recommendation: **(a)**, because the plan-first screen (E) removes most of the pain (you see
every missing requirement before committing), and it keeps BN's progression meaningful.

### Q7: facilities from your seat

Agreed, with one refinement:

- **Moving**: you stay in your seat. Every facility the vehicle has (bed/seat to sleep,
  workbench, kitchen/stove, fridge, cargo, faucet, lab) is usable from the seat through a
  vehicle panel, as if you'd walked there. Sleeping while moving needs someone else driving
  (future: NPC crew / autopilot) — otherwise you must stop.
- **Parked**: you can also get up and walk around inside (a parked vehicle is static
  geometry, so this is just normal movement; the top rung is walkable by design).

Walking around inside a *moving* vehicle (moving reference frame) is out of scope.

## Shape of the system

- **Template**: an authored chassis at real scale (bike, car [sedan/hatch/sports], SUV,
  pickup, van/minivan, box truck, bus, semi, "rig" = top rung, frame family), extending the
  wave-3 body styles in `src/render/vehicleModel.ts`. Defines the collision body, seats,
  door/window openings and typed **sockets**.
- **Socket kinds** (each maps to BN locations): frame, wheel (under), cabin cell (center),
  panel per side (armor, doors, windows, boards), roof (roof, on_roof), engine bay
  (engine_block, fuel_source, alternator), interior slots (small grid on bigger rungs).
  Every installed part is drawn on the model (plates over windows, ram, roof rack, panels).
- **Parts**: BN part definitions and stats unchanged; each BN part gets the socket kinds it
  fits. Condition and faults as BN.
- **Adopt**: claim a found vehicle ("your" vehicle: name, history). **Strip**: remove parts
  down to the chassis (salvage into items). **Build a chassis** from frames at a garage.
- **Plan (E)**: a 3D edit mode — ghost parts on sockets, the reason when one won't fit, live
  stats (weight, top speed, power balance, range, armour per side), the list of missing
  tools/skills/parts. **Commit** queues the whole plan as one timed activity (sped up, with
  the activity ring), interruptible, resumable, partial progress kept. Salvage uses the same
  screen ("strip these").

## Phases (proposed)

1. **Templates + mapping** (no building yet): socket data model; map every BN vehicle and
   mapgen spawn onto a template (frame fallback); drawn body = collision body; save
   migration; tests over all 257 BN vehicles. Removes the collision mismatch for good.
2. **Adopt, strip, salvage**: claim a vehicle, remove parts into items, strip to chassis.
3. **Plan-and-queue building**: the 3D planner, requirements (per Q5), queued timed job,
   installing parts into sockets, build a chassis at a garage; the top-rung rig chassis.
4. **Facilities from your seat**: the vehicle panel for beds, workbench, kitchen, fridge,
   cargo, faucet; walking inside when parked.
5. **Polish**: per-part visuals on every template, names/paint, damage by side.

## Future work (split off, not in this pass)

- **Turrets** (mounts, manual and automatic fire, ammo feed).
- **NPC crews** (followers riding, manning turrets, driving so you can sleep; autopilot).
- **Walking around inside a moving vehicle.**
- **Towing, trailers, semi coupling.**
- **Siphoning fuel.**
- Vehicle-vs-vehicle momentum transfer, boats, tanks' tracks.
