# Monster placement and crawlers (wave 3)

Two user reports: "quite a bit of zombies floating" and "crawling zombies are clearly walking".

## Floating zombies

### Root cause

`src/world/levels.ts` (levels from the world) made the chunk manager generate every storey of
every column up to its top. Generating a storey runs its spawns, and the busiest one is the
overmap terrain's static `"spawns"` (BN `overmap_terrain`, e.g. every `apartments_con_tower_*`
storey: `GROUP_ZOMBIE`, population 8-10, 80%). `WorldGenerator.addOterSpawns` turns that into a
group request covering the whole OMT, and the spawner picked spots with `map.passable` only.
`t_open_air` is passable, so on an upper storey (a tower floor surrounded by open air) many
zombies were placed beside the building, in the air. Monsters off the player's level ±1 are
dormant (`monai.ts` reality bubble) and never run `applyGravity`, so they hung there.

Code path: `GameMap.chunk` → `WorldGenerator.generate` → `addOterSpawns` → `Spawner.onChunk` →
`request` (population points) → `randomPoint` / `place` (`map.passable`) → `MonsterSystem.spawn`.

BN does the same static-spawn roll (`mapgen.cpp`, `random_point(passable)`), but its spawns only
become monsters in `map::spawn_monsters_submap`, where `monster::can_move_to` / the group's
`allow_on_terrain` (`passable && has_floor`) apply, and a zombie that does land on open air falls
at once because every level of the bubble is simulated.

Seed 443226190, 11x11 OMTs around Nottingham generated up to each column's top
(`tools/dev/probe_floating.ts --city`):

| | z-1 | z0 | z1 | z2 | z3 | z4 | z5 | on no floor |
|---|---|---|---|---|---|---|---|---|
| before | 157 | 625 | 87 | 85 | 34 | 17 | 56 | **39** |
| after | 157 | 625 | 87 | 85 | 34 | 17 | 56 | **0** |

The counts by level don't change (the misplaced ones move to the nearest floor of their storey):
the upper storeys are full because BN's towers are (8-10 zombies per apartment storey, office
towers' `GROUP_OFFICE_TOWER_2`). The z-1/-2 monsters are real: the subway substations'
`place_monsters` (`repeat` 5-9 at the OMT's density), parking garages, urban basements, the
microlab. They are drawn only when their level is (`levels.drawn`) and far figures on another
level under a roof are skipped (`chunks.covered`), so they don't show through the street.

### Fix: placement valid by construction

`src/game/standing.ts` is the one rule:

- `canStandAt(map, mon, x, y, z)`: passable and a floor under it unless it `FLIES`.
- `standingSpot(...)`: the tile itself, else the nearest tile it can stand on in the same OMT
  and level, else straight down through open air to the first floor (where BN's fall would
  leave it), else null (skip, warn once). `loadedOnly` never generates a chunk.

Used by:

- `Spawner`: spot picking (`randomPoint`, BN `allow_on_terrain`), each individual of a pack, and
  dormant-zombie corpses. A pack with no spot near its point goes through `standingSpot`.
- `MonsterSystem.spawn`: every other path (stash restore, save load, revives, debug spawns,
  labs, NPC-placed monsters) is relocated the same way when its chunk exists.
- `MonsterSystem.settleDormant` (every second): dormant monsters on a tile they can't stand on
  (old saves, a stash restored before its chunk was generated) settle without fall damage.
  Each monster is re-checked only when its tile changes.
- Dormant horde drift (`driftDormant`) stops at the edge of a floor instead of walking off a
  storey toward a gunshot.
- `MonsterView.farFigures` never draws a non-flyer with no floor under it, and warns once
  (`[monsters] … stands on no floor`): with the above it would be a bug.

Tests: `tests/standing.test.ts` (unit cases, spawn/settle/drift/stash paths, and the seed
443226190 tower city generated up to each column's top: 27 unsupported before, 0 after).

## Crawlers

BN has no crawl flag; the data says it in words. `src/game/crawl.ts` `crawlPlanOf`:

| monster | why | plan |
|---|---|---|
| `mon_zombie_crawler` | "drags itself along slowly with its arms. Its legs are damaged" | drag |
| `mon_crawler` | "slowly dragging its eldritch body across the ground" | drag |
| `mon_zombie_crawler_pupa`, `_decoy` | "This half of a human corpse" | legless |
| `mon_zombie_creepy` | named "creepy crawler" | fours |

Only human-shaped bodies (bodytype human, or HUMAN/ABERRATION species without one): the
spidery gangrenous crawler and the sludge crawler keep their own bodies.

`rig.ts` `crawlPose`: the same humanoid parts (the sprite-painted skin still fits), posed prone.
The hips pitch the body forward by θ (1.36 rad dragging, 1.25 on all fours), which lays the
torso along the floor and trails the legs; the root drops so the belly is just off the floor.
On a hanging limb +x swings it forward, and in the pitched torso forward is down, so an arm at
+θ hangs straight down (all fours) and at about 3.0 lies along the floor ahead (dragging).

- drag: each arm reaches (forearm lifted), plants and pulls (upper arm sweeping back, forearm
  flat), two strokes per cycle with a surge and a roll; legs limp, toes trailing.
- legless: the same without legs.
- fours: hands and knees, diagonal pairs together, shins level on the floor.
- Wind-up: rears up on the arms; strike: a lunge; dead: flat on its face, arms flung forward
  (it slumps onto its side instead of toppling a standing body).
- Animation stays stepped (the caller's 8 steps per cycle); slow crawlers still make full
  strokes (`move = gait × 3`).

Height: `rig.height` is the crawl height (0.3 of standing dragging, 0.27 legless, 0.55 on all
fours), so `bodyOf` (blood, arrows) is right, and the hit zones come from the drawn boxes
(`aimHooks.pick`). Without a model (sprite mode, tests, NPC fire) `aimmodel.bodyHeightOf` lowers
the body column the same way.

Checks: `tests/render/chars.test.ts` "crawlers", `tools/realinput.ts --only crawlzones`
(real mouse: shots at the drawn head are headshots; shots at standing chest height pass over
it), `tools/dev/probe_crawl.ts <id> -v` (per-part boxes per pose).

Screenshots (`docs/screenshots/wave3/monsters/`, from `tools/char-shots.ts --views
crawlers,crawl_move`):

- `crawl_crawlers.jpg`: dragging crawlers broadside and head-on, the creepy crawler on all
  fours, the pupa, the fused crawler, a walking zombie for scale.
- `crawl_crawl_move.jpg`: a crawler dragging itself toward the camera, a creepy crawler behind.
- `crawl_headshot.jpg`: the real-input headshot on a crawler.

## Known gaps

- Crawlers still use the walker's collision radius and move speed rules (BN data); a crawler
  can't pass under anything a walker can't.
- The settle pass relocates without a fall; a monster that genuinely walks off a roof while
  active still falls with damage (`applyGravity`).
