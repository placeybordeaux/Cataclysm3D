# CDDA-3D — architecture & team conventions

A real-time, first-person 3D remake of **Cataclysm: Dark Days Ahead**, built in the browser
with TypeScript + Three.js, reusing CDDA's actual JSON content and the UltiCa pixel-art
tileset, rendered in the "3D pixel art" style of *Project Shadowglass*.

## Goals (in priority order)

1. **Completeness** — a full game loop: character creation → evacuation shelter start →
   scavenge a procedurally generated New England town → fight zombies → eat, drink, sleep,
   craft, build → die → memorial screen. No dead ends, no placeholder menus.
2. **Retention** — use CDDA's real data (items, monsters, recipes, mapgen, professions…)
   and mechanics (body-part HP, pain, hunger/thirst/fatigue, skills, noise attracts
   zombies, bashing terrain, item groups, recipes with tools/qualities/components). Keep
   CDDA's names, messages, colors, key bindings and curses-style UI wherever sensible.
3. **Enjoyment** — responsive real-time controls, readable combat, atmosphere at night.
4. **Style** — Shadowglass-like: stable low-resolution pixel rendering of a real 3D world.

## Source material

- **v2: game data comes from Cataclysm: Bright Nights** (`~/code/Cataclysm-BN`, read-only;
  C++ in `src/` is the reference, there are no JSON docs). The extractor's default checkout
  is BN (`CDDA_DIR` overrides). The normalized item/container/magazine/armor model and BN's
  carrying rules are in `docs/BN_DATA_MODEL.md`; DDA notes below are historical.
- CDDA source + data: `~/code/Cataclysm-DDA` (read-only! never modify). JSON docs:
  `~/code/Cataclysm-DDA/doc/JSON/` (JSON_INFO, MAPGEN, ITEM, MONSTERS, …). C++ in `src/`
  is the ground truth for formulas (e.g. `melee.cpp`, `monattack.cpp`, `character.cpp`).
- Tileset (CC-BY-SA): `/home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm`
  (source form: per-sprite PNGs + JSON; see its `tile_info.json`). `vendor/` is git-ignored —
  from a worktree, use the absolute path above.
- v2 (Bright Nights): `npm run atlas` reads BN's *compiled* UltiCa by default
  (`~/code/Cataclysm-BN/gfx/UltimateCataclysm`: tile_config.json + sheets, tools/atlas/compiled.ts);
  `--source-form --tileset-dir <vendor dir>` is v1's input, `--fill-from <vendor dir>` optionally adds
  the ids BN's tileset lacks. The world extractors (mapgen, npcs, vehicles, ui, achievements) default
  to `~/code/Cataclysm-BN` like the core one (`defaultCddaDir()`; `$CDDA_DIR` overrides).

## Tooling

- Everything runs inside `nix-shell` (repo root `shell.nix`: node 22, chromium, imagemagick).
  e.g. `nix-shell --run 'npm run typecheck'`.
- **Memory-heavy commands (npm install, vite build, headless chromium) must go through**
  `~/claude-stuff/bin/heavy --mem 1.5 --name "<what>" -- <cmd>`. The machine is shared.
- `npm run typecheck`, `npm test` (vitest, `tests/**/*.test.ts`), `npm run build`.
- `npm run shot -- --params "seed=1" --eval "<js using cdda>" --out shots/x.png` —
  headless screenshots (see `tools/shot.ts --help`). **Look at your screenshots with the
  Read tool**; visual features are not done until you've seen them working.
  `--print "<expr>"` prints JSON from the page for scripted assertions.
- `tools/drive.ts` keeps one Vite + headless Chromium session alive for long playtests:
  `tsx tools/drive.ts serve [--gpu] [--dist]` (via `heavy`), then `drive.ts eval|shot|load|log` (or curl
  `127.0.0.1:9555/eval`); page scripts can `await shot(path)`. `--gpu` renders on the real GPU;
  `--dist` serves the production build (`npm run build` first). Real input: `drive.ts key "i Escape
  ArrowDown*5 Shift+e"`, `hold "w 1500"`, `click "480 270"`, `type "text"`. For scripted walks,
  `cdda.findPath(x, y)` returns a door-aware A* route; `cdda.godMode(true)` for long captures.
  Puppeteer's input skips the browser's own key handling (its Esc never releases pointer lock),
  so **anything a player does must also be checked with OS-level input**: `drive.ts serve
  --headful --params "...&realinput=1"` runs a windowed Chromium on Xvfb with `xkey`/`xmove`/
  `xclick`/`state` commands (xdotool), and `tools/realinput.ts` is the scripted real-input
  regression (pointer lock, Esc, fullscreen, stuck keys, AZERTY, rebinding, inventory, quit…; ~315
  checks). `--gpu` (via `heavy --kind gpu`) renders on the real GPU — SwiftShader is too slow for the
  default look; `--browser firefox` runs it in Firefox (the human's browser); `--hmr` like `npm run dev`.
  Findings of the v2 newcomer playthrough: docs/QA_V2.md.
- Static assets are fetched relative to `ASSET_BASE` (src/core/assets.ts, Vite `base: './'`), so
  `dist/` works from any sub-path: never hard-code `/data/`, `/atlas/`, `/audio/`.
- `window.cdda` (src/debug.ts) is the automation API. Register helpers for anything you
  add (`cdda.spawnMonster(id, dx, dy)`, `cdda.giveItem(id)`, …) so others can test.
- Generated data lives in `public/data/` (by `npm run data:all`, which runs every extractor) and `public/atlas/`
  (by `npm run atlas`). Both are **committed** so worktrees run without regenerating.

## Coordinates & units (see src/world/coords.ts, src/data/types.ts)

- Tile grid: x east, y **south**, z level. 1 tile = 1 m. Chunk = 24×24 = one CDDA OMT.
- Three.js: world (x, y, z) → `THREE.Vector3(x, z * LEVEL_HEIGHT, y)`.
- Units: ml, g, game seconds, cents, °C. The extractor normalizes CDDA strings.
- Time: movement/combat is real-time at `ACTION_SCALE` CDDA turns per real second (100
  moves = 1/3 s). Calendar runs at `CLOCK_SCALE` game-s per real-s (24×; a day ≈ 1 h real);
  long actions (crafting, reading, sleeping, waiting) warp the clock (`clock.warp`) and are
  interrupted when a hostile comes into view, like CDDA activities.

## Code layout

```
src/
  main.ts            boot: load data, build Game, Renderer, UI; main loop
  debug.ts           window.cdda automation API
  core/              rng, events (typed bus), time, input
  data/              types.ts (normalized CDDA types), load.ts, item group expansion …
  world/             coords, map (chunks, registry), physics helpers, generators
    overmap/         overmap generation (cities, roads, forests, rivers)
    mapgen/          CDDA JSON mapgen interpreter (rows, palettes, nested, items, monsters)
  game/              simulation: game.ts loop, player, creatures, monsters, AI, items,
                     inventory, combat, crafting, needs, effects, fields, sound …
  render/            Three.js pixel-art pipeline, chunk meshing, sprites, lighting, sky
  ui/                DOM overlay in CDDA curses style: sidebar, log, menus, screens
  audio/             WebAudio engine (audio.ts), CDDA soundset lookup, sfx.* helpers,
                     ambience/footsteps/world-sound mapping, procedural fill-ins
tools/
  extract/           CDDA JSON → public/data/*.json
  atlas/             UltiCa PNGs → public/atlas/*
  audio/             CC CDDA soundpacks → public/audio/* (Opus + soundset.json + CREDITS.md)
  shot.ts            headless screenshot harness
tests/               vitest unit tests (pure logic, no DOM/WebGL)
```

### Survivor simulation (src/game, UI-free)

- `item.ts` BN Item (charges / integral-magazine `ammoId`, one-load container `contents`, `magazine`
  slot, gunmods, damage, rot), `createItem`, `fromSpawned`, `inNewContainer`. See docs/INVENTORY_MODEL.md.
- `moves.ts` **the only place items change location**: `Loc` (`L.hands/worn/inv/in/mag/mod/ground/
  cargo/stock`), `moveItem(item, from, to, opts)`, `spawnItem`/`spawnOnGround` (creation),
  `consumeItem` (use-up), `unloadItem`, `transaction`, `census`. Never edit item lists directly
  (tests/moves_lint.test.ts); conservation is property-tested (tests/conservation.test.ts).
- `inventory_view.ts` UI-free data for inventory screens: `inventoryView`, loc/item keys, `verdict`
  (drop checks with reasons), `itemActions`.
- `character.ts` Character: stats, skills, body-part HP, pain, stamina, needs, sleep,
  morale/focus, body temperature, traits. `update(gameDt)` in game seconds. BN rules (file
  header lists the DDA differences): `storedKcal` capped at `maxStoredKcal()` (17500), a
  calorie-only `stomach`, instant thirst, flat 10000 stamina. Traits act through
  `mutationValue(field)` (BN mutation_branch floats, BN aggregation) and BN enchantments
  (`enchant(value)` / `enchantBonus(value, base)` = add + base × multiply + max; providers in
  `enchantProviders`; BN's suffix tree of enchantment values, such as CLIMATE_CONTROL_COOLING_TORSO,
  is in `enchantValues.ts`). Item relic passive effects come from `relicEnchant.ts`: wielded, worn
  and carried items, under every BN enchantment condition. Conditions that depend on where the
  character is read `Character.world` (`characterWorld.ts`, set for the player and NPCs). Climate
  control is applied in `climateCorrected`. `sleepComfort` (set by rest.ts) feeds `rollCanSleep`.
- `healing.ts` BN heal_actor (`applyHealActor`), used by Inventory.use for `heal` actions.
- `effects.ts` data-driven effect_type (misc.effect_type, with built-in fallbacks).
- `inventory.ts` `character.inv`: BN carrying (flat `items` inventory vs worn `storage`, weight
  capacity), wield/wear/take off/pick up/drop/consume/use/reload/unload built on moves (they take
  the item's `from` location; `null` = a new item), qualities, encumbrance, armor absorption.
  Actions return `{ok, msg, moves, code?}`. `Character.groundLoc` says where drops land.
- `combat.ts` pure CDDA melee/ranged/monster-attack math taking an Rng.
- `player.ts` PlayerAvatar = Character + position/view. Game wires `onMessage`/`onDeath`.
- Terrain `move_cost` is in units of 50 moves (2 = flat ground = 100 moves): multiply by 50
  before passing to `moveSpeed`.

### Monsters & combat (src/game, wired by src/monsters.ts `installMonsters`)

- `monster.ts` Monster instance (float pos, hp, anger/morale, effects, specials, upgrades);
  timers are real seconds (`turnsToSeconds`); player effects from monster attacks use
  `turnsToEffectSeconds` (turns × CLOCK_SCALE / ACTION_SCALE game seconds).
- `monai.ts` MonsterSystem (`game.monsters`): reality bubble (60 tiles, z±1) — the rest are
  dormant but drift toward loud noises (hordes); hearing via `sound` events; vision by light;
  chase/flee/wander/idle; budgeted A* (`pathfind.ts`) over `los.ts` Grid (never generates
  chunks); `hurt(m, dmg, 'player')`, `die`, corpses (`corpses`, `onDied`, `onCorpseGone`),
  kills. Emits `playerHurt` and `creatureDied`.
- `monstash.ts` (`sys.stash`): idle dormant monsters > 7 OMTs away are serialised per OMT column
  and leave `sys.all` (back within 6 OMTs); unnamed/non-friendly only, so don't hold references to
  far monsters. Spawner dormant corpses are chunk baseline (rebaselined), stashed on eviction and
  re-laid on regeneration; saved in the `monsters` section's `stash`. `cdda.monsterStash()`.
- `monattack.ts` special attacks, BN rules: melee/bite actors (named JSON `monster_attack`s like
  `scratch` merge under the monster's entry; min_mul 0, `body_parts`, effects only on damage; a bite
  infects only a grabbed target), leap/gun actors, and the hardcoded monattack.cpp ids GRAB (dodge_check,
  martial-art grab break, `grabbed` intensity += grab_strength; a parried grab never takes hold),
  GRAB_DRAG, SMASH (fling dice×sides×3), LUNGE, LONGSWIPE, SHRIEK(_ALERT/_STUN), ACID(_BARF), BOOMER(_GLOW),
  RESURRECT (charge-up), SHOCKSTORM, PARROT. `isMeleeSpecial(def)` = spends a swing. No dialogue conditions.
- `mondeath.ts` BN `death_function` lists: NORMAL (corpse; pulverized when 2.5×overkill/max hp > 5),
  SPLATTER, BOOMER (no corpse, 15 bile tiles, boomered if adjacent), ACID, BROKEN (`broken_<id>` item),
  MELT, DISINTEGRATE, EXPLODE/SMOKEBURST/GAS, WORM/BLOBSPLIT. Corpses get overkill damage and
  `vars.dissectables` (the harvest's bionic / bionic_group entries, rolled at death). `monfaction.ts`
  `monsterFactionAttitude(data, a, b)` (BN monfaction.cpp, base_faction inheritance) for future
  monster-vs-monster fights. Upgrades: half_life × MONSTER_UPGRADE_FACTOR 2, EVOLVE_MAX_ITERS 5.
- `spawner.ts` consumes `chunk.spawns` (then clears them) + CDDA city hordes; tuning knob
  `cityHordeScale` (0.3 of CDDA's 80 zombies × city size).
- `mongroups.ts` (genVersion >= 3): BN overmap special spawns (anthill colonies etc.), per-submap
  groups from `Overmap.monGroupsAt`, materialised when their submap enters the 11×11-submap bubble;
  save section `mongroups` = spent group keys. docs/WORLD_TRANSPORT.md "Special spawns".
- `playercombat.ts` RMB-readied LMB melee (crosshair cone) / hitscan guns / `G` throw; `butchery.ts`.
- Seams: `game.bash?.(x, y, z, str)` (bash.ts) lets zombies smash doors;
  `game.stats?.kills` gets kill counts; `renderer.viewmodel?.attack(kind)` is called on
  attacks. Rendering: `src/render/monsterView.ts` (sprites, corpses, blood decals).
- Crafting (`crafting*.ts`, `requirements.ts`, `construction.ts`, `disassembly.ts`, `reading.ts`,
  `fire.ts`), Bright Nights rules: functions take a `CraftHost` (Game satisfies it).
  `CraftingInventory.gather` = inventory + map items/furniture pseudo tools within 2 tiles + `fire`
  from a nearby `fd_fire`; components are consumed or moved (`into`) through moves.ts.
  **In-progress crafts are real items** (BN itype `craft`, vars `craft_recipe/progress/…`) holding
  their components in `contents`: `startCraft` → `continueCraft` / `abandonCraft` (components
  back) / `completeCraft`; `craftQueue(host)` runs several in a row. **Unfinished constructions**
  are the same item type with `vars.con_id`, lying on the site with the materials
  (`continueConstruction` / `cancelConstruction`). moves.ts refuses hand moves into/out of crafts.
  Light: BN `lightSpeedMultiplier` (dark = slower; BLIND_* flags), `fineVisionMod` uses
  `game.lightAt`. Knowledge on Character (`learnedRecipes`, `identifiedBooks`); book recipes need
  no identification (BN). Hooks: `craftedHooks`, `craftStoppedHooks`, `constructedHooks`,
  `readHooks`, `readSessionHooks`; activities set `kind/target/at/customUi` (ActivitySpec).
  UI: `installCrafting(game, api, renderer)` (src/ui/crafting_install.ts) → ui2 screens in
  src/ui/craft2 (`&` crafting browser, `*` construction list + in-world placement ghost, reading
  card and progress bars in overlay.ts), item actions via `itemActionProviders`
  (src/game/inventory_view.ts; `readAction`, `disassembleAction`, `craftItemActions` in
  craft2/actions.ts), world menu "Continue construction" / "Build here…". `cdda.crafting.*`,
  `cdda.construction.*` for automation.

### Combat depth (src/game/{techniques,martialarts,gunmods,monguns,blast,armed}.ts, wired by src/combatdepth.ts)
- `meleeAttack(c, {dodge, armor, info?: TargetInfo}, rng, name, {allowSpecial, aoeTargets, forceTechnique})`
  picks a weapon/style technique (BN melee.cpp get_valid_techniques: dummy/defensive skipped, crit_tec,
  downed/stunned/human_target, BN ma_requirements (req_buffs, skills, weapon damage/flags/categories,
  mutations_required, wall_adjacent via `maWorld`), weighting, AoE needing victims; no DDA dialogue
  conditions) and returns `technique` + `outcome` (stun/down turns, knockback, aoe, disarm);
  Rolled damage carries BN's `multiplier` (armor comes off before it: `applyFlatArmor`).
  the world layer applies it (`applyTechniqueToMonster` in playercombat.ts: monster effects +
  dash knockback; `PlayerCombat.swingAt`/`aoeVictims` for wide/spin/impale follow-ups). Messages
  use the technique text (`techniqueMessage`, `hitMessage`: "You sweep the zombie for 12 damage.").
  No `info` = no techniques (legacy callers). Glass shattering + `handleMeleeWear` happen inside.
- Defense: `monsterMeleeAttack` uses `tryDodgeRoll` (BN: always rolls, each dodge already spent this
  turn costs 2 dodge; `onDodged(c, attackerSkill)` spends it when the attack misses) and
  `blockHit` (WBLOCK_1/2/3 weapons, style arm/leg blocks, logarithmic_range(0,40,score) of physical
  damage gets through, "You block most of the damage with your baseball bat!"); NPC-vs-character
  melee uses `characterDefend`. A combat turn is `COMBAT_TURN` = 1/MELEE_SCALE real s; dodges/blocks
  refresh and buffs tick in `tickMartialArts` (PlayerCombat.update for the player, NpcSystem for NPCs).
- Martial arts: `maOf(c)` (WeakMap state: known styles, style, buffs with stacks, dodges/blocks
  left); `learnStyle`, `selectStyle`, `triggerBuffs(c, 'onhit'|…)`, `buffFlat/buffMult` feed hit,
  dodge (Character.dodge), speed (resetStats), damage, arpen, armor, move cost, crit. Manuals teach
  their `martial_art` when read (`readHooks` in reading.ts) or activated (MA_MANUAL); Brawling
  autolearns at melee 1; profession traits' `initial_ma_styles` show as choices in the `_` menu.
  Save section `martialarts` (order 12).
- Guns: `Item.gunmods` (saved in ItemJSON), `gunmodCompatible/installGunmod/removeGunmod`
  (valid_mod_locations + add_mod mounts, mod_targets, blacklists, IRREMOVABLE), `sightDispersion`,
  mods in `gunDispersion/gunRecoil/gunNoise/aim`; `gunModes/currentMode/cycleMode` (`gun.vars.gun_mode`);
  `fireGun` rolls malfunctions/jams (`gun.vars.jammed`, cleared by `r`), adds 5×recoil×(1−skill/20)
  per round and returns `delayedRecoil`, `pellets/shotSpreadMoa/shotDamage`, `ammoEffects`.
  PlayerCombat fires bursts BURST_INTERVAL apart (`combat.burst`), pellets per ray, INCENDIARY/
  EXPLOSIVE/aoe ammo effects through `combat.hooks` (every explosion goes through `blast.ts detonate`, BN
  explosion.cpp; `vehicleDamage.ts` is BN vehicle::damage for blasts and rounds; `armed.ts` ticks a
  live grenade's fuse). Aim levels:
  `aimState(c, gun)` → Immediate/Regular/Careful/Precise (CDDA get_aim_types thresholds).
- Monster guns (`monguns.ts gunActor`): special attack type "gun" — ranges pick the fire mode,
  starting_ammo pool, targeting lock + `targeting_sound` announcement, fake shooter stats, hitscan vs
  the survivor, "throw" skill actors lob a projectile. Survivor only (no NPC targets yet).
- Hooks: `combatHooks.onBlock/onWeaponBroken`, `monsterGunHooks.tracer`, `inventory_ui.extraItemActions`
  (item-menu entries), `renderer.viewmodel.block()` + attack kind `'sweep'`.
- Keys `_` martial arts, `b` fire mode (CDDA `F` is our flashlight). Debug: `cdda.learnStyle(id)`,
  `cdda.setStyle(id)`, `cdda.martialArts()`, `cdda.openMartialArts()`, `cdda.techniques(crit?)`,
  `cdda.fireMode()`, `cdda.cycleFireMode()`, `cdda.installGunmod(gunId?, modId)`, `cdda.openGunmods()`,
  `cdda.aimState()`, `cdda.detonate(dx, dy, explosion | itemId)` (a BN explosion beside you).

### World interaction (src/game, installed by src/worldInteraction.ts)

- `sound.ts` `emitSound(game, {x,y,z}, volume, desc, {category?, source?, sfxId?})` — use it
  for every noise (not `events.emit('sound')` directly): the player hears it (log, waking,
  interrupting activities) and monsters poll `soundsHeardAt(game, x,y,z, hearing)` /
  `recentSounds(game)`; CDDA sound_distance + weather attenuation + wall muffling.
- `vision.ts` `lineOfSight`, `lightAt(game,x,y,z)` (CDDA light units), `playerCanSee`,
  `creatureCanSee(game, from, to, visionDay, visionNight)`, `tooDarkReason(game,'read'|'craft')`.
- `bash.ts` `bash(game,x,y,z, str | {bash,cut}, {source?,silent?,destroy?})` with CDDA
  persistent map damage; `playerSmash` is the `X` key.
- `fields.ts` fire/smoke/blood processing near the player; `ignite`, `addField`,
  `fieldDamageAt(game,x,y,z,{materials,flags})` for monsters standing in fire.
- `targeting.ts` `targetTile(game)` = tile under the crosshair within reach; `interact.ts`
  (`e`), `zlevels.ts` (`<`/`>`, falling; in deep water they dive and swim between the lake
  levels, `water.ts` `swimVertical`, docs/WORLD_TRANSPORT.md "Lakes in depth"), `rest.ts` (`|` wait, `$` sleep), `weather.ts`
  (`game.weather`), `traps.ts`, `lightitems.ts` (`F`: flashlight transform).
- Walkable stairs (docs/STAIRS.md): `stairs.ts` solves each BN stair pair into a link (straight
  flight / spiral / ladder, footprint, landings, path), `stairwalk.ts` carries walkers along it
  (`liftOf(creature)` = metres above its level; renderers add it), `src/stairs.ts` wires the
  player (`game.stairStep`), `<`/`>`, monsters (`MonsterSystem.stairs`), followers, saving;
  `render/stairs/` models flights and stairwells (`MeshExtras.stairs`). `?stairs=flight|compact|classic`.

### Vehicles (src/game/vehicle*.ts, src/render/vehicleMesh.ts, src/ui/vehicle_ui.ts)

- Data: `public/data/vehicles.json` from `npm run extract:vehicles` (prototypes with CDDA's
  copy-from "parts append" rule, slimmed vehicle parts, vehicle groups, fuel kJ/charge).
  `npm run data:all` regenerates every public/data file in order (core, npcs, mapgen, vehicles,
  ui). Vehicle types are no longer in misc.json.
- `vehicle.ts` `Vehicle`: parts on CDDA mount points (+x forward, +y right), world pose
  `x,y` (centre of mount 0,0) + `facing` deg (0 east, clockwise). `occupiedTiles()`,
  `mountAtTile`, `moveCostAt/opaqueAt` (CDDA obstacle/aisle rules, open doors), mass,
  `totalPower`, `maxVelocity` (CDDA cubic), fuel/battery, `resolveCollision` (CDDA
  part_collision loop), `spawnVehicle` (init_state: fuel %, status -1/0/1/2, locks, wear),
  `toJSON/fromJSON`. Pure logic, unit-tested in tests/vehicle.test.ts.
- `vehicles.ts` `VehicleSystem` = `game.vehicles`: consumes `chunk.vehicles` requests, tile
  index registered as a `GameMap.overlays` entry (so `map.moveCost/passable/opaque`,
  physics and monster `Grid` see vehicles), driving physics per tick, collisions (terrain via
  bash.ts, monsters via `monsterCreatureHooks`, the player, other vehicles), engine/horn/
  alarm noise via `emitSound` (with CDDA sfx id/variant), save section `vehicles` (order 30).
  Audio: `src/audio/vehicleAudio.ts` `EngineSounds` (running-engine loop per nearby vehicle,
  internal while driving, rate by CDDA gear, gear-shift clunks) and CDDA variant pickers.
- Keys: `^` take controls / controls menu, `k` engine, `h` headlights, `n` horn; at the
  controls WASD drive (direct by default: W throttle with a short ramp, release coasts, S
  brakes then reverses after a beat, `c` cruise control locks the speed; CDDA's 4-mph-step
  cruise model is the "Driving controls" option), Space handbrake. Launch acceleration is
  CDDA power/mass compressed toward a car (`feltAcceleration`, 0-30 mph in ~4 s); steering
  lock narrows with speed (`maxSteerAt`, lateral accel <= 5.5 m/s^2).
- Run-over bodies (docs/VEHICLES.md "Run-over bodies"): `runoverFling.ts` plans the throw in the sim (corpse at its end, survivors fly it via `Monster.fling` then get up), `render/chars/ragdoll.ts` tumbles it; `vs.runoverMode` loose (default)|ragdoll|fall, `?runover=`, `cdda.runoverBodies()`.
- Gibbed bodies (docs/VEHICLES.md "Gibs"): BN still decides the gib (`mondeath.ts gibbedBody`, no corpse); `game/gibs.ts planGibs` flies a piece per slot from the blow (a vehicle's throw or the killer's direction), `ms.onGibbed` hands them to `render/chars/gibs.ts` (the rig cut into pieces via `CharInstance.hidden`, `GibSet` lifetime/cap); `ms.gibMode` pieces|splat, `ms.gibGore` some|lots|max, `?gibs=`, `?gore=`, `cdda.gibbedBodies()`, `cdda.gibPieces()`.
- Run-overs use BN's impulse model (`resolveBodyCollision`, 0.1 damage per N·s, minus torso bash armor; a car at 20 mph kills an ordinary zombie) and credit the kill to the driver (`hurt(m, dmg, "player")` only when you drive; tests/runover.test.ts). Terrain impacts still use the DDA energy loop (`resolveCollision`, on the speed into the obstacle); vehicle-vs-vehicle crashes exchange a rigid-body impulse with a transient slide/spin per vehicle (`vehicleImpact.ts`, docs/VEHICLES.md "Momentum crashes"; Options > Vehicle crashes keeps the old immovable model), and heavy/tracked handling comes from `handlingFor` (mass, power, tracks). `vs.creatureHooks = composeCreatureHooks([monsterCreatureHooks(ms),
  npcCreatureHooks(game, vs)])` — NPCs take CDDA impact damage on the torso, get stunned,
  flung and downed, and npcai `afterHit` handles death drops and anger. `e` on a vehicle part goes
  through `interactOverrides` in interact.ts (doors toggle, else a part menu: cargo get/put,
  controls, hotwire with a SCREW tool, parts list).
- Seams: `vehicles.creatureHooks` (run-over damage/placement), `vehicles.onBash`,
  `game.movementOverride` (WASD doesn't walk while driving), `renderer.beforeRender`,
  `renderer.handsBusy`, `rig.suppressBob`. Debug: `cdda.spawnVehicle(proto, dx, dy, deg,
  {fuel,status})`, `cdda.vehicles()`, `cdda.enterVehicle()`, `cdda.drive(throttle, steer,
  s, brake?)`, `cdda.roadTrip(proto)`, `cdda.gotoVehicle(regex, {angle, dist})`,
  `cdda.vehicleLights(on)`, `cdda.vehicleAt(dx, dy)`.
- Towing (docs/VEHICLES.md "Towing"): `vs.towing` (`src/game/towing.ts` `TowSystem`) links two vehicles
  with BN's `hd_tow_cable` (a part on each, the item in the tower's part); `step` runs after every
  vehicle moved: a rope impulse through `applyImpulse` once the hooks are 7 m apart, the towed
  vehicle's axles grip / steer to the pull (`decayMotion(..., towed)` skips its flat decay), BN's
  breaks plus overload. Saved in `VehicleSaveJSON.tows`. `src/towing.ts` wires the cable's use action,
  the vehicle panel actions (`vehiclePanelExtras` in src/screens/vehicle.ts) and `render/towFx.ts`;
  `cdda.towing.*`.
- Mesh (vehicleMesh.ts): bonnet rows ahead of the windscreen slope from 0.9 m to 0.7 m at the
  nose, low dark cowl/dash, thin A-pillars, faint glass (0.14), painted panels mid-tone with
  darker tops (`panelTop`) so sunlit cars don't read as white slabs; BN wheel sizes are cm.
  Headlights: a spot aimed ~30 m out plus four light-map beam lights out to ~30 m. There are
  two shadowed spots (`HEADLIGHT_SPOTS`): the car you drive, then the nearest other lit car.
- Model look (default since wave 3, docs/VEHICLES.md; `?vehicles=model|parts`, Options >
  Vehicle look, `cdda.vehicleLook()`): `vehicleLayout.ts` classifies the grid (style, livery,
  sections, wheels, doors; width squeezed, seats keep their tiles via `zOf`),
  `vehicleModel.ts` builds a profile-lofted body with cut-out windows / arches / open doors,
  `vehicleSkin.ts` paints a 32 texel/m skin (in `vehicleSkinWorker.ts`), `vehicleBikes.ts`
  and `vehicleFrame.ts` cover bikes and odd grids, `vehicleTank.ts` armoured hulls (tanks, IFVs, APCs:
  frame templates plated over half their cells; tracks / wheels / hover pads and the turret read from
  the parts), `vehicleRoller.ts` drum compactors (road roller), `vehicleWork.ts` work machines
  (excavator, dozer, roadheader, trencher, forklift, hoist, tractors and their implements, sweeper:
  chosen by their tool parts), `vehicleGeom.ts` holds shared helpers.
  VehicleRenderer keeps the parts renderer as the `parts` look. Collision follows the drawn
  body: `MapOverlay.shaped/collide` (sub-tile shapes, used by physics.ts), the vehicle system's
  `bodyShape` hook + `bodyRect/occupantAt`, clipping in `src/game/vehicleShape.ts`. The driven
  vehicle gets `vehicleCockpit.ts` (live dials, wheel + hands, windscreen film); `rig.eyeCap`
  keeps the on-foot eye under a car roof in a doorway. Inside a vehicle you don't free-walk: `vehwalk.ts` `VehicleStations`
  (`vs.stations`) seats you at stations (cars: wheel or outside; RVs/buses: seats, aisle, door
  exits; tanks: driver/gunner/hatches) with W/A/S/D hops and `rig.stationEye`; `?vehwalk=`,
  Options > Inside vehicles (docs/VEHICLES.md "Inside vehicles"). `tools/vehicle-freq.ts` ranks what
  mapgen spawns by body style.
### NPCs, dialogue, trade, missions (src/game, wired by src/npcs.ts `installNpcs`)
- Data: `public/data/npcs.json` (`npm run extract:npcs`, tools/extract/npcs.ts): npc templates,
  npc_class, talk_topic (merged like CDDA: responses append across definitions), mission_definition,
  faction, reachable effect_on_condition, name lists. Snippets (`<greet>`…) stay in misc.snippet.
- `npc.ts` `Npc extends Character` (+ position, attitude, faction, personality, `op` opinion
  trust/fear/value/anger/owed, dialogue `vars`, chatbin, shop `stock`); `generateNpc(data, nd,
  {template}|{cls}, seed)` = npc::randomize (4d3 stats + class bonuses, class skills, gear from
  `<class>_<slot>`/`npc_<slot>` groups, names). `toJSON/fromJSON`.
- `npcai.ts` `NpcSystem` (`game.npcs`): reality bubble like monsters; goals fight / flee / follow /
  return (guards, shopkeepers, "wait here") / approach (TALK, MUG) / wander / rest / investigate /
  pulp; melee via combat.ts, guns via fireGun (aimed first) with reload. It is also the dialogue world and mission host (survivor vars,
  faction trust, kills). `spawn(spec, x, y, z, opts)`, `talkTo(n)`, `npcAt`, `toJSON/fromJSON`.
  Monsters hunt NPCs through the additive `MonsterSystem.extraTargets` hook; the player hits
  NPCs through `PlayerCombat.attackGuard` / `npcMelee` / `npcShot` (friendly ones ask first).
- **Follower rules in the AI** (`npcai.ts`, BN arithmetic in `npctactics.ts`, tests
  `tests/npcrules_ai.test.ts`). Per think an `NpcAiCache` (BN ai_cache: danger, danger_assessment,
  emergency, friends, sound alerts, pulp target) is rebuilt. Allies pick targets as BN
  `assess_danger`: def_radius (6, follow distance with follow_close, confident range when only
  defending itself), "too close" to it or a friend always counts, otherwise `ok_by_rules` for the
  engagement rule (NONE / CLOSE / WEAK vs `melee_value` / HIT via hit_by_player / NO_MOVE /
  FREE_FIRE / ALL), forbid_engage drops all; priority = danger − 2 × (scaled distance − 1);
  follow_close or an emergency sends a walking-with follower back first. Non-allies keep the
  nearest-foe choice. `methodOfAttack` = BN `method_of_attack` for everyone: alt attack in an
  emergency (use_grenades; NPC_ALT_ATTACK / NPC_THROW_NOW items, armed at the throw,
  `onThrownExplosive` → `ArmedExplosives`), reach, a shot only within `confident_gun_mode_range`
  (BN hit_range.json × `confidence_mult` by aim rule) and `wont_hit_friend` (else side-step),
  use_guns / use_silent (gun noise < 50) and danger ≥ 3 gate the gun, reload, melee, **aim**
  (recoil falls toward the sight floor; any step or reload resets it to MAX_RECOIL), and only then
  close in, which NO_MOVE / FREE_FIRE and HIT-not-yet forbid. Following: `followDist` (2 with
  follow_distance_2 or out of sight, 4, 1 on stairs), `followPace` (move_own_pace, else the
  survivor's run/crouch, plus the port's catch-up over 8 tiles). Paths (`pathRules`): doors unless
  avoid_doors (doors also avoided), bashing up to `smash_ability` for non-allies and allow_bash,
  hold_the_line avoids open doors / rough tiles next to the survivor (`PathOpts.avoid/bashMax`);
  close_doors shuts the door left behind. Needs: noise investigation (`handle_sound`, not when
  walking with you; 10 tiles, 50 guards, 0 with ignore_noise), pulping reviving corpses within 6
  (allow_pulp; `pulp_do_turn` damage → PULPED, which `monai` won't revive), `complain()` timers in
  `Npc.complaints` (allow_complain; serious ones forced). Not acted on: allow_pick_up and the CBM
  rules (`NpcRules.canUseOffensiveCbm / wantsToRechargeCbm` are ready for NPC bionics). BN's AI
  never reads avoid_friendly_fire (wont_hit_friend always applies), so neither does the port.
- `talk.ts` `Dialogue`: BN dynamic lines (`{"and"}` concatenation), responses (switch/default,
  show_always, truefalse, trials with talk_trial::calc_chance, repeat responses for_item/for_category
  in front), BN conditions/effects (condition.cpp, npctalk.cpp). Variables use BN names
  (`talkVarName`: `npctalk_var_<type>_<context>_<name>`; old saves migrated by `migrateTalkVars`),
  with u_adjust_var/u_compare_var integers; `curItem` (BN cur_item) feeds bulk trades. Kinds the
  port can't honour go through `unsupportedCond`/`unsupportedEffect` (warn once naming the missing
  system, false/no-op; `MISSING_EFFECTS`); kinds BN itself treats as false/no-op (unknown string
  conditions, unknown ally rules) are false with their own warning. Hooks: `pickOption` (barber,
  copy_npc_rules), `playerDriving`, `npcGoToSleep`, `spawnPets` (u_buy_monster). `npcrules.ts`
  `NpcRules` = BN npc_follower_rules on `Npc.rules` (saved; `STORED_ONLY` lists what the AI can't
  act on, each warning once naming the missing system). `traitgroup.ts` rolls npc_class trait groups (background
  stories, starting traits). `tools/dialogue-coverage.ts` measures which kinds the runtime handles,
  weighted by reachable / early (refugee center, starting, random) topics. `talkmath.ts` evaluates
  DDA `math` expressions. `missions.ts`
  `MissionSystem` (FIND_ITEM, KILL_MONSTER_TYPE/SPEC, KILL_MONSTER target, GO_TO(_TYPE),
  ASSASSINATE, CONDITION). `trade.ts` `TradeSession` (npctrade.cpp prices, balance, credit).
- **update_mapgen**: `worldgen.applyUpdate(map, idOrObject, omx, omy, z)` runs an update_mapgen
  on the live chunk (rotated like CDDA, existing items kept, `chunk.version` bumped, new
  spawns/vehicles/NPCs via `map.onChunkUpdated`). mapgen.json `update` holds the ids npcs.json
  references (so `extract:npcs` runs before `extract:mapgen`). Dialogue `mapgen_update` and
  mission start/end/fail `update_mapgen` go through `NpcSystem.mapgenUpdate`;
  `cdda.mapgenUpdate(id, omx?, omy?, z?)`.
- Mapgen `npcs`/`place_npcs` fill `chunk.npcSpawns` (consumed + cleared by installNpcs, skipped
  for chunks generated before a loaded save); the `evac_center` refugee center special is placed
  near the start town (overmap.ts). Towns get a few random survivors / bandits.
- UI `src/ui/npc_ui.ts`: dialogue window, trade screen, mission log (`M`), chat menu (`C`);
  `e` on an NPC talks. Save section `'npcs'` (order 25). Debug: `cdda.spawnNpc(templateOrClass,
  dx, dy, {attitude, follow})`, `cdda.npcs()`, `cdda.talk()`, `cdda.dialogue()`, `cdda.respond(i)`,
  `cdda.respondText(s)`, `cdda.trade()`, `cdda.missions()`, `cdda.missionLog()`,
  `cdda.teleportRefugeeCenter('merchant'|'lobby'|'outside')`, `cdda.faceNpc()`.

### Mutations & bionics (src/game/mutations.ts, bionics.ts, bodymods.ts; wired by src/mutbio.ts)
- `attachBodyMods(character)` → `{ mut: MutationState, bio: BionicState }` (UI-free, unit-tested in
  tests/mutbio.test.ts); `bodyMods(c)` fetches them. Mutations live in `Character.traits` (so trait
  enchantments apply). `MutationState` follows **BN** (no vitamins/CHANGING): mutagen use actions
  (`useMutagen` = mutagen_actor, `useMutagenIv` = mutagen_iv_actor, `purify` = PURIFIER/PURIFY_IV/
  PURIFY_SMART, `rejection` = try_reject_mutagen) run from `Inventory.onConsume`; BALANCED_MUTATIONS
  `mutate()` spends the `accumulated_mutagen` effect via `mutationChances()` (`startGame()` gives BN's
  27 days); `mutateCategory` / `mutateTowards` / `removeMutation`; `categoryLevels()` =
  set_highest_cat_level; `testCrossingThreshold(cat, tier)` with `threshTier`/`threshCategory`
  (threshold_muts index = tier); restricts_gear pushes gear off; BN `armor` resistances,
  `night_vision_range`, activation costs/cooldowns.
- `BionicState` (BN): stored `maxPowerLevel` (capacity on install), `fake_item` (BIONIC_WEAPON →
  wielded; otherwise a crafting pseudo tool while passive/powered), `stat_bonus`, bash/cut/
  bullet_protec, `bio_enchantments` (add/multiply/max: LUMINATION, NIGHT_VISION), MULTIINSTALL,
  INITIALLY_ACTIVATE, required_bionics, slots only with CBM_SLOTS_ENABLED; `install()` always installs
  and adds BN complications on a failed roll; `anesthesiaNeeded` = requirement "anesthetic" ×
  difficulty × 2 × 7. Self-install needs MANUAL_BIONIC_INSTALLATION (off): use an Autodoc.
- Starting kit: `professionItems(data, prof, male, traits, rng)` (src/game/profession.ts: groups,
  trait substitutions/bonuses, FIT); chargen's `applyBuild` also installs profession `CBMs` (power
  full), spawns tame `pets`, powers starts_active mutations and calls `mut.startGame()`.
- Hooks other code can use: `Character.enchantProviders` / `enchantCondition`; `Inventory.wearChecks`,
  `extraEncumbrance`, `naturalArmor`, `qualityProviders` (also fed into CraftingInventory),
  `consumeChecks` (comestible `tool`, mutagen refusal), `onConsume`; `visionHooks(game).lights /
  .nightVision` (src/game/vision.ts, `visionThreshold`, `bodyLight`); `renderer.nightVision`,
  `renderer.playerMutationOverlays`; `hud.addSidebarProvider`; `charsheetSections`
  (src/ui/charsheet.ts). Keys: `[` mutations, `p` bionics; `e` on an Autodoc. Save section
  `bodymods` (order 15). Debug: `cdda.mutate(id|cat)`, `cdda.mutations()`, `cdda.crossThreshold(cat)`,
  `cdda.installBionic(id,{surgery})`, `cdda.bionics()`, `cdda.givePower(kj)`, `cdda.toggleBionic(id)`,
  `cdda.spawnAutodoc(dx,dy)`, `cdda.giveCbm(id)`.
- Projectiles: `projectileHit` (src/game/projectile.ts) = BN deal_projectile_attack severity/hit
  location, used by the survivor's shots and monster gun actors.
### Scores & achievements (src/game/achievements.ts, src/achievements.ts, src/ui/achievements_ui.ts)
- Data: `public/data/achievements.json` (`npm run extract:achievements`, part of `data:all`): BN
  achievements + conducts, event_statistics, event_transformations, scores; loaded by the install.
- `AchievementTracker` (UI-free, tests/achievements.test.ts) = CDDA stats_tracker + achievements_tracker:
  `emit(type, fields, count?)` with CDDA event names/fields, `flush()` re-checks watching achievements,
  `value(statId)`, `completion(id)`, `isHidden(a)`, `requirementLines(a)`, `achievementSupported(a)`
  (depends only on `SUPPORTED_EVENTS`; others show as "not tracked", never unlock), `toJSON/load`.
- `installAchievements(game, worldgen, api)` feeds it: creatureDied (kills), playerHurt, playerDied,
  Inventory.onConsume, wrapped PlayerCombat.melee/fire, per-tile `avatar_moves` / per-OMT
  `avatar_enters_omt`, and a 2 Hz poll of the survivor (wake-ups, skill levels, mutations/thresholds,
  CBMs, broken limbs, healing, books, wield/wear). `begin(loaded)` (main.ts) starts tracking.
  New game systems can report more with `achievementsOf(game)?.tracker.emit(...)`.
- Persistence: per character in the save (section `achievements`, order 60); completed achievements
  globally in localStorage `cdda3d.achievements` (`globalAchievements()`), which unlocks chargen's
  scenario/profession `requirement`s. Death screen + memorial entry list the run's achievements.
- UI: `)` scores window (ACHIEVEMENTS / CONDUCTS / SCORES / KILLS tabs), unlock toast + log message.
  Debug: `cdda.achievements(filter?)`, `cdda.unlockAchievement(id)`, `cdda.achievementStat(id)`,
  `cdda.achievementEvent(type, fields)`, `cdda.openAchievements()`.
- Event coverage inventory (which BN event types the current achievement data needs, what feeds
  each, what's out of scope and why): [docs/ACHIEVEMENTS.md](docs/ACHIEVEMENTS.md).

### Underground labs & dissection (src/game/labs.ts, src/labs.ts `installLabs`, src/game/butchery.ts)
- Labs are CDDA 0.J+ **modular JSON labs** (upstream removed the hardcoded lab/lab_stairs/lab_finale
  generator): overmap special `lab_mutagen_6_level` (`LAB_SPECIAL`: fenced parking + security building on
  the surface, residential z-2/-3, cargo z-4, mutagen research z-5/-6, a -7 hallway) and the 4x4 surface
  microlab (`MICROLAB_SPECIAL`, elevator z0 → z-2). Both are in `WILD_SPECIALS` (tools/extract/mapgen.ts)
  and overmap.ts always places one of each in the start region (after all other specials, so older
  placement is unchanged). The map holds BN's z -10..10 (`MIN_Z`/`MAX_Z`); genVersion 1/2 worlds grow specials only to -7..5 (`genZRange`, docs/WORLD_TRANSPORT.md "Full z range"). Stairs line up via the JSON (zlevels' 24-tile stair search
  covers the few offset ones); tests/labs.test.ts walks from the parking lot to z-6.
- Machinery (UI-free, prompts via `LabUi`; `autoUi(game, picks?)` for tests): ID card readers
  (`cardreader` examine actor: card flags, terrain_changes radius, ID_CARD_DESPAWN turrets, consume;
  electrohack hacking = CDDA hack_level/normal_roll → alarm / nothing / unlock + broken reader), computer
  consoles (CONSOLE furniture + `chunk.computers`: login hack Nd6 vs security+2·alerts, unlock(_disarm),
  release(_bionics), research (lab_notes), maps, lists, shutters, elevator_on, …; failures shutdown /
  alarm / manhacks / secubots / damage), elevators (`iexamine::elevator`: stand in the cab, powered
  control floors, OMT rotation between floors, items/monsters ride along), gate controls (misc.gate),
  climbing CLIMBABLE barriers (boom barriers, chain fences). IMMOBILE monsters (turrets) never move.
- `interact.ts` `examineHandlers` (examine_action → interactions) is the hook they use; consoles come
  through `interactionProviders`.
- Dissection (`B` menu → Dissect, BN): CUT_FINE tool, 4× the size cutting time / the CUT_FINE tool
  factor, yields like full butchery plus the corpse's `vars.dissectables` (implants), each recovered on
  x_in_y(roll, 10) with roll = firstaid/2 + electronics/2 + CUT_FINE + dex shift − corpse damage (failed
  CBMs burn out). Butchery (quick/full) follows BN butchery_drops_harvest; blood only from bleeding.
  `dissectYield`/`dissectSeconds`/`corpseDissectables` in butchery.ts, `startDissect` in src/monsters.ts.
- Debug: `cdda.labs()`, `cdda.labMap(special?)`, `cdda.teleportLab(z, special?)`, `cdda.faceLabLoot(z)`,
  `cdda.labLoot(r)`, `cdda.rideElevator(z?)`, `cdda.useComputer(picks?)`, `cdda.swipeCard()`,
  `cdda.dissect()`. Probes: `tsx tools/dev/probe_lab.ts <seed> [special] [z]` (OMTs, stairs, loot),
  `tools/dev/probe_reach.ts <seed> [special] [keys]` (walk-in reachability).

### Bright Nights world (src/world/mapgen/{bnbuiltin,lab}.ts, tools/extract/mapgen.ts)
- BN builds fields, roads and parking lots in C++ and labs in Lua; `mapgen.json` `builtin` maps a
  mapgen id to its generator (`field`, `road_straight`..., `parking_lot`, `empty_rock`, `lua:lab`), and
  `worldgen.generateInto` runs JSON first, then water, then these. bnbuiltin.ts ports mapgen_field /
  mapgen_road / mapgen_parking_lot; lab.ts ports data/json/lua/mapgen/lab.lua (z0 card-reader bunker,
  JSON floor plans `lab_4side`/`lab_1side`/`lab_finale_1level` per room, walls/doors, stairs, lights).
- Overmap: BN city profile (hamlets, finale buildings, urban lists over size 10), the classic `Lab`
  special grows a simplified mutable `lab_basement` (CLASSIC_LAB_SPECIAL, LAB_BASEMENT_TYPES), bridges
  replace straight roads over water, z<0 is `empty_rock`. The start is BN's `Evac Shelter`.
  genVersion 2 (`WORLDGEN_VERSION`, saves keep theirs) adds BN's `UNIQUE` rule, manholes over a
  city sewer (z-1) and subway tunnels (z-2): non-road connections go to `Region.connectionRequests`
  and src/world/overmap/connections.ts (BN overmap_connection layout) builds them per region.
  genVersion 3: subways cross region edges at seed-derived seams (overmap/seams.ts), reserved by
  both neighbours before anything places, so generation stays order independent.
  docs/WORLD_TRANSPORT.md; `tsx tools/transport_probe.ts` counts them per seed.
- Mutable specials (genVersion >= 2): overmap/mutable.ts is a port of BN's join-matching solver,
  overmap/mutable_place.ts scatters `mutableWildSpecials` (anthills, slime pit, Ice Lab, stream, mines +
  mine_tunnel) per region on its own RNG stream; `Overmap.joinAt` feeds mapgen's nested `joins`.
  mapgen/bncaves.ts ports draw_mine, slimepit.lua and mapgen_rock_partial. docs/WORLD_TRANSPORT.md.
- BN semantics kept at runtime: floors have no INDOORS flag (indoors = covered from above), every
  open-air tile over terrain with a `roof` gets it (mapbuffer post-pass), consoles are `t_console`
  terrain, vending machines are `f_vending_c` or broken `f_vending_o`, `translate_ter` works.
  Terrain/furniture `alias` ids are rewritten to canonical ids by the extractor.
- `tools/bn-shots.sh [prefix] [seed]`: shelter, street, house, forest, top-down town, overmap, lab.

### Seasons, foraging, farming, water (src/game/{sun,harvest,farming,water,woodcut,actualize}.ts, src/nature.ts)
- `sun.ts` is the one sun: `sunPosition(seconds)` (CDDA calendar.cpp altitude/azimuth, Boston),
  `sunTimes(day)` → sunrise/sunset/dawn/dusk hours (≈06–18 equinox, 04:20–19:40 midsummer,
  07:25–16:35 midwinter), `seasonAt(seconds)`. vision.ts and the renderer sky (`SkyState.update(hour,
  {sunrise, sunset, altitude, azimuth, season})`: keyframes remapped to the real day + seasonal tints)
  both use it. Chunk meshes/decor rebuild on `clock.season` change; the atlas `_season_<s>` tiles give
  snow cover, bare/autumn trees.
- `e` on nature tiles comes from `interactionProviders` (interact.ts hook): harvest_by_season
  (`harvest.ts`, misc.harvest rolls, `transforms_into` harvested variants), underbrush foraging
  (forage_<season> groups), planting in `t_dirtmound`/planters, crop examine/fertilize/harvest
  (`farming.ts`: seed item hidden on the tile, `vars.planted` = birthday, stage = f(age)), fill
  containers from water, fish, chop trees/trunks with an axe.
- Tool-quality usages (`qualityUsages` in inventory.ts, tool_qualities.json `usages`): AXE → CHOP_TREE /
  CHOP_LOGS / LUMBER, SAW_W 2 → LUMBER, DIG → MAKEMOUND / DIG (pit via construction), FISHING_ROD →
  FISH_ROD; `a` on the tool offers what's possible where you stand.
- `actualize.ts` `Actualizer` (like CDDA map::actualize): chunks within 3 of the player are brought up to
  date every 10 game minutes — HARVESTED terrain regrows next season, crops grow, map items rot by the
  hourly outdoor temperature (+3 °C indoors; unpowered fridges don't help; mapgen food ages from day 0).
  Save section `nature` (per-chunk stamps). `natureOf(game).actualizer.sweep()` forces it.
- `water.ts`: `fillableContainers/fillContainer`, fishing (`startFishing`: CDDA per-turn 1/600000 odds from
  fish populations of FISHABLE monsters in the connected water, else hidden GROUP_FISH fish; catches are
  corpses to butcher), swimming (`updateSwimming`: wet, "Dive into the water?" with items that would
  be ruined, sink when swim_speed ≥ 500 or winded, oxygen 30+2·str, drowning damage);
  `renderer.rig.eyeOffset` puts the camera at the water line.
- Debug: `cdda.setSeason(s, day?)`, `cdda.season()`, `cdda.sunTimes(day?)`, `cdda.plant(seed, dx?, dy?)`,
  `cdda.growPlants(days)`, `cdda.forage()`, `cdda.findHarvest(re)`, `cdda.harvest(x, y)`,
  `cdda.fish(seconds, {run})`, `cdda.chopTree(instant)`, `cdda.findOpenGround(n)`, `cdda.dive(x, y)`,
  `cdda.swim()`, `cdda.actualize()`, `cdda.natureInteractions(x, y)`, `cdda.fillable()`.

### Frame pacing, hit feedback, onboarding, spawn density, liquids, e-files
- `src/world/prefetch.ts` `ChunkPrefetcher` (`cdda.prefetch`): generates chunks ahead of the player
  (radius 6, z±2, biased along the velocity) in `requestIdleCallback` slack; `stats.sync` counts chunks
  someone generated synchronously (hitch candidates), `stats.slowest`. `?prefetch=0` disables.
  `cdda.benchRun({seconds, speed, yawDeg})` ghost-sprints and returns frame-time percentiles
  (`src/perfDebug.ts`). Keep item spawning linear.
- `playerAttack` event (events.ts) per attack: outcome hit/crit/kill/block/miss/whiff, impact point,
  `heavy`, blood field id. `src/render/hitFx.ts` (pixel blood/sparks/dust, crit flash, stagger via
  `MonsterView.kick`), HUD hit marker. `nearClamp` (monsterView.ts) draws creatures closer than
  `NEAR_CLAMP.dist` (1.2 m) as if at that distance.
- Hints popup at new game (`src/ui/tips.ts`, Options "Show hints at start"), CDDA tips of the day
  (`ui.json` `tips`). Weapon speed: `swingSpeedRating`/`unwieldyWarning` (combat.ts), sidebar swing time.
- Zombie density = CDDA SPAWN_DENSITY (`src/game/density.ts`; chargen DESCRIPTION `z`, Options, save
  key `zombieDensity`). Spawner: `CITY_HORDE_REALTIME` 0.2, `SPAWN_REALTIME` 0.75; spawns are held
  (`spawner.hold/release`) while the title screen runs. Outside the bubble only `Monster.horde`
  members hear (`hordeSignal`, CDDA get_signal_for_hordes).
- Liquids: `src/game/liquid.ts` (targets, auto-store, pour, drink; all moves with an explicit `from`)
  + `src/ui/liquid_ui.ts` menu (the liquid stays in its container until a choice moves it), wired
  through `liquidHooks` (crafting.ts) and Unload on containers. (DDA e-file storage is gone: BN has none.)

### Loading: surroundings first, the load gate (src/render/surroundings.ts, src/loadgate; docs/PERF.md "Load gate")
- Per-entity views ask `renderer.chunks.drawnAt(x, y, z)` (level drawn for the eye **and** its chunk built and
  visible, plus the neighbour when within 2 tiles of its edge), never `levels.drawn` alone; tufts/grass use
  `chunks.chunkShown`. Views that update on ticks also hide through `chunks.afterUpdate`. New per-entity
  visuals must do the same.
- `LoadGate` (pure, src/loadgate/gate.ts) holds the game with the tactical-pause hold `'loading'` while
  `chunks.missingAround` reports unbuilt chunks within 40 m on pz +-1 (opens once 64 m is built); armed by
  main.ts when gameplay starts. `cdda.loadGate(mode?)`, `cdda.entityRule(on?)`, `cdda.monsterView`.

### Progression & onboarding (src/progression, docs/DESIGN_V2.md decision 6)
- Title: **Start** = quick start (named Evacuee, BN `unemployed` kit, one name field, difficulty
  stub), **New Game** = start picker (ui2 cards: profession + scenario, pitch, kit preview,
  trade-off; locked cards show requirement + progress; the old chargen is the "Custom survivor"
  card once unlocked), **Journal**; a banner announces unlocks earned since the last title visit.
  The "Show hints at start" popup is now off by default (discovery tips replace it).
- `profile.ts` (UI-free): lifetime stats + unique sets, earned unlocks, tips shown, options
  (Classic mode, hints); localStorage `cdda3d.progression`, export/import validated (throws).
- `unlocks.ts` + `public/data/unlocks.json` (hand-authored ladder): requirements = BN achievement
  ids and/or stat thresholds (`{any: [...]}` for either); grants = profession / scenario / title /
  creator only (sidegrades). Classic mode makes everything available without recording it.
- `placement.ts`: scenarios we can place (`evacuee` shelter, `missed` town house, `wilderness`
  forest); the catalogue validator refuses others. The first second of a new game removes
  hostiles within 10 tiles of the start.
- `discovery.ts` (UI-free): `NUDGES` (first zombie, hunger, night, bleeding, locked door…),
  `NudgeQueue` (once per profile, >= 20 s apart, never while fighting or over a window),
  `craftableDiff` + grouped "You could craft" nudge; HUD badge on the crafting key.
- `install.ts` feeds stats (kills, deaths, days, distance, books, towns, labs, vehicles, crafts via
  `craftedHooks` in crafting.ts, butchering via a wrap of `activities.start`), evaluates unlocks,
  saves the run's journal state (section `progression`, order 65). Journal: key `J` (`journal.ts`).
- `difficulty.ts`: `Difficulty` stub + `difficultyHooks` for the balance work (applied on new
  game and on load).
- Hooks for other systems: `progressionOf(game)?.bump(stat)`, `.note(set, id)`, `.discover(tipId)`.
- Debug: `cdda.progression.{profile(), stat(id), bump(stat,n), unlock(id), classic(on), hints(on),
  discover(id), queue(), checkCraftable(), run(), export(), import(json), reset()}`. Tests:
  tests/progression.test.ts; real input: `tools/realinput.ts --only title,onboarding,newgame`.

### Interaction screens (src/screens, ui2; installed by `installScreens` in main.ts)
- Replace the curses NPC / vehicle / body-mod / achievement windows through seams those systems
  expose: `npcScreens` (npcs.ts: dialogue, trade, missionLog, chat, pickItem), `vehicleScreens`
  (vehicle_ui.ts: partMenu, info, controls, legacyDashboard), `autodocScreen` (mutbio.ts), key
  re-registration (`p`, `[`, `_`), and `src/ui/achievements_ui.ts` lazy-loading
  `src/screens/achievements.ts`. Pure rules in `src/screens/logic/*` (tests/screens.test.ts).
- Dialogue (`dialogue.ts`): portrait, opinion chip, typewriter line (Options: text speed), answers
  1–9/0 with trial chips (`ResponseView.trial` / `.action` / `.plain` from talk.ts), `?` shows
  hidden answers, job-offer card, Scene/Book layouts. Pauses with the ui2 pause setting.
- Trade (`trade.ts`): drag goods onto You give / You get; the deal is `TradeSession.commit` (one
  moves transaction; property test tests/trade_screen.test.ts, `TRADE_SEEDS=400` soak).
- Missions (`missions.ts`): log + Track. **Map markers**: `src/game/mapmarkers.ts`
  (`mapMarkerProviders.push(() => MapMarker[])`, `mapMarkers()`); missions export their targets.
- Vehicles (`vehicle.ts`): parts diagram / gauges / controls panel, cargo panel (the inventory
  screens can take over with `cargoPanel.open = (game, v, part) => …`), driving HUD.
- Body (`bodymods.ts`): bionics (power bar, ON/OFF), mutations, martial arts, Autodoc (odds, risks,
  anesthetic, time under; `beginInstall` / `beginUninstall` in mutbio_ui.ts do the operation).
- Debug: `cdda.screens.{dialogue(), trade(), autodoc(), markers(), trackMission(uid), openMissions(uid?),
  vehicle(dx, dy), bionics(), mutations(), martialArts(), prefs}`, `cdda.openAutodoc()`. Real input:
  `tools/realinput.ts --only talk,trade,missions,vehicle,body,autodoc,scores`.

### Combat feel layer (src/game/combatfeel.ts, wired by src/feel.ts; see docs/COMBAT_FEEL.md)
- All feel constants live in `FEEL` (presets `FEEL_PRESETS.accessible|classic`, `setFeelDifficulty(d, overrides)`
  is the difficulty hook). The CDDA/BN math stays underneath; this layer only times and targets it.
- Survivor swings: `PlayerCombat.beginSwing()` (LMB) → wind-up → contact (resolves via `melee(m, {phased})`
  against `sweptArcTarget`) → recovery, `combat.swing`/`hitStop`; `melee()` without `phased` stays instant.
  Melee control (`meleeControl()`: 'ready' default | 'anytime'): `meleeStance(inputs)` each tick → `combat.stance`
  {ready, canSwing, guarding, moveMul, staminaPerSec}; 'ready' = RMB readies, LMB swings only while readied, readied
  walks at `FEEL.readyMoveMul` and guards (`defenseOf(c).guarding`, read by `blockHit`; parry clock from the raise),
  Shift-running lowers it; 'anytime' = the old LMB-whenever + RMB guard. Options › Controls › Melee, `?melee=`,
  `cdda.setMeleeControl`. Space/double-tap side-step (`tryDodgeRoll` bonus).
- Monsters: `m.windup` telegraphs melee/special blows (`specialTelegraph` in monattack.ts); event
  `monsterAttack` (windup/resolved/whiff/interrupted); hit reactions `m.flinch` + shove; surround slots;
  `sys.struggle()` for grabs (interact key while grabbed).
- Render hooks: `viewmodel.swing/impact/setGuard/setLowered/recoil/jolt/reload/ads`, `rig.kick()/rig.ads`,
  `SpriteHandle.setSize`, `hitFx.tracer/watchTracers`, `playerAttack.hitStop`. HUD: `src/ui/combatHud.ts`.
- Aim models (src/game/aimmodel.ts, wired by src/aim.ts): `aimModel()`/`setAimModel('sway'|'timing'|'dice')`,
  `freeAim()`. Free aim: `combat.aim` (AimSway: sway + kick; the shot uses `shotOffset`), `castAim`,
  `freeHit`; hooks for 3D models: `aimHooks.hitZone(m, hFrac)` and `aimHooks.body(m, dist)`; events
  `monsterDodge`, `playerAttack.quality`; `rig.aimView`, `viewmodel.aimPx`, `game.runVeto`.
  Melee picks with `combat.meleePick()` (fan of rays vs model boxes, `aimHooks.prepare`). Enemy rounds:
  `enemyFireOf(game).fire({...})` (src/game/enemyfire.ts; monguns/npcai use it), event `nearMiss`.
- Debug: `cdda.feel`, `cdda.setFeel(d)`, `cdda.feelState()`, `cdda.recordFrames(n, dt, each)` (frame-exact
  captures for animation timing); `tools/drive.ts seq "…"` (timed real input + screenshot bursts), `xbdown/xbup`.
- Ranged / archery (`src/game/rangedfeel.ts`, pure): `rangedClass(item)` (firearm/bow/crossbow/sling/thrown/
  launcher/energy/air from BN data), `hasMuzzleFlash`, `drawStyle`, BN STR_DRAW rules, `drawSeconds`,
  `rollRecovery`/`embedsIn` (drop_or_embed_projectile), `arcHeight`, `rangedMissReason`. In PlayerCombat:
  `draw` (RMB draws/whirls, LMB looses), `flights` (visible arrows resolved where they arrive), `landed`,
  `rangedTarget()`, `bowPose()`, `settleFlights()` (a save lands arrows). A surviving round leaves the gun as
  an object (`moves.takeRound`) and ends on the ground or in `Monster.stuck` (a cargo-like Loc, saved in
  MonsterJSON, dropped on death). Render: `render/bowArt.ts` (drawn bow viewmodel), `render/arrowFx.ts`.
  Events: `playerAttack.reason/ranged/landed`, `attackRefused`. Tests: tests/rangedfeel.test.ts; real input:
  `tools/realinput_archery.ts` (`--only archery`).

### Difficulty & tactical pause (src/game/{difficulty,balance,pause}.ts, src/difficulty.ts, src/pause.ts; see docs/BALANCE.md)
- `DifficultySettings` holds every balance knob (spawn/horde scale, safe radius, monster speed & resilience, item
  spawn rate, feel, bleed, crash damage, hunger/thirst/fatigue, healing, cold, day length, pause in menus,
  permadeath); presets `DIFFICULTY_PRESETS.accessible|classic`, Custom = anything else. `applyDifficultySettings(game,
  preset, s)` pushes them into the spawner (`registerDifficultyTargets`), `game.map.itemSpawnRate`, `BALANCE`
  (balance.ts: monster speed/resilience, crash damage), `setFeelDifficulty`, `game.player.balance` (per-survivor
  needs/healing/bleed/cold multipliers), `setClockRate` (time.ts; convert real→game time with `clockScale()`, never
  CLOCK_SCALE), `game.pauseInMenus` and ui2 `settings.pauseInInventory`. The new-game flow picks the preset
  (progression `difficultyHooks`); save section `difficulty` (order 18) keeps the full settings per world;
  Options > Difficulty… edits them live. `permadeath(game)` decides whether death deletes the save.
- Tactical pause: `tacticalPauseOf(game)` = manual toggle + named holds ('menus' from ui2 inventory-type windows);
  `game.tacticalPause` is derived from it — don't assign it directly. Key `tactical_pause` (` / Pause) also works
  inside menus via `input.onPriorityPress`. The Esc menu always pauses (`game.paused`).
- `tools/balance_sim.ts` (headless day-1 bot, duels, needs timelines, first night): see docs/BALANCE.md.
  Debug: `cdda.difficulty()`, `cdda.setDifficulty(d, overrides)`, `cdda.openDifficulty()`, `cdda.tacticalPause()`.

### Extension points (prefer these over editing someone else's code)

- `game.systems.push({ name, update(game, realDt, gameDt) })` for per-tick simulation.
- `game.events.on('sound' | 'message' | …)` typed bus in `src/core/events.ts` — add event
  types there.
- `map.onChunkGenerated` for spawning things when chunks appear.
- **Save/load** (src/save): any system with persistent state calls
  `registerSaveable(game, 'key', { save: () => json, load: (json, ctx) => …, missing?, order? })`
  (src/save/registry.ts; `ctx.warn(msg)` for dropped unknown ids; order: map 0, world 5,
  player 10, monsters 20, default 50). Map chunks are saved only when dirty (changed since
  generation — tracked automatically, no calls needed); state kept *outside* the chunk
  (like bash.ts map damage) must be saved by its owner. Saves are gzip JSON in IndexedDB,
  one slot per character; death deletes the save and adds a memorial entry.
  `cdda.save.{save,list,load,queueLoad,stats,memorial}`; `npm run shot -- … --reload`.
  **Chunk eviction** (src/save/eviction.ts): clean (non-dirty) chunk columns farther than render
  radius + 4 are dropped and regenerate on return; their keys join `tracker.priorGenerated`, so
  spawner/NPC/vehicle placement skip them. Per-chunk state kept outside the chunk that must reset
  with it: `map.onChunkEvicted.push(c => …)`. Stats: `cdda.eviction.stats`.
- `input.onPress(e => …)` for global keys, `input.capture(handler)` for modal menus.
- Audio: call `sfx.meleeHit(...)`, `sfx.gunshot(...)`, `sfx.door(...)`… from `src/audio/sfx.ts`
  (no-ops without audio), or put `sfxId`/`sfxVariant` (CDDA sound_effect id/variant) on
  `sound` events; `sfxId: ''` marks a sound you already played. Volumes live in
  `cdda.audio.settings` (assign a field to apply + persist). `npm run audio` rebuilds
  public/audio (committed); `cdda.audioSelfTest()` verifies it headlessly.

## Visual style: "Shadowglass" 3D pixel art

What we know Shadowglass does (Starhelm Studios, Godot, first-person immersive sim):
conventional 3D meshes rendered through custom shaders to look like moving pixel art;
point-filtered textures; LUT color grading; dynamic lights and shadows with carefully
tuned ambient levels and attenuation; "pixel stabilization" so the image doesn't shimmer;
distance-dependent asset detail for readability. Our implementation:

- Render the scene to a **low-resolution target** (~ 320–400 px tall, integer upscaled with
  nearest filtering). All textures `NearestFilter`, no mipmap blur.
- Textures come from **UltiCa sprites** (floors, wall faces, furniture, items, monsters) so
  the world is literally built from CDDA pixel art. Creatures/items are **billboard
  sprites** (Doom/Daggerfall style); walls/floors/roofs are real geometry.
- **Banded/quantized lighting** (few light steps), strong darkness at night, flashlight and
  fire as dynamic point lights, sun/moon directional light with shadows.
- **Palette/LUT grading + ordered (Bayer) dithering** in the post pass, subtle depth/normal
  **outlines**, distance fog. Pixel-stable camera where possible.
- Camera modes (switch with `V`): first-person (default), over-the-shoulder, top-down
  (classic CDDA view). Keep all three working.

- **Visual styles** (docs/LOOKS.md): `look=classic|crisp|voxel|terrain|full` (default full;
  Options > Visual style, persisted; `renderer.setLook(name)`, `cdda.setLook`,
  `cdda.lookTweak({feature: v})`). Features live in `src/render/look.ts`; the mesher reads
  `look.f` through `chunks.extras`. Volumes (voxel props, 3D trees) only within
  `chunks.lodRadius` chunks of the player. Visual ground height (relief, curbs) is
  `renderer.groundAt(x, y, z)`: sprites and the eye ride it, gameplay stays on the flat grid.
  `tools/look-shots.ts` renders the comparison set / GPU bench.

### Renderer APIs (src/render)

Pipeline: scene → low-res MRT target (~360 px tall, or 540-720 px with `px` 0 = auto; exact integer upscale; colour + view
normals + depth) → post pass (depth/normal outlines, fog, Bayer dither, palette/LUT grade)
→ nearest blit. URL params: `px=`, `grade=palette|smooth|off`, `tex=atlas|procedural`,
`cam=first|third|top`, `walls=tinted|sprite`, `radius=<chunks, default 4>`,
`dither=view|screen`, `debug=1` (stats overlay; F6/F7 cycle grade and wall style).
Keys: `V` camera mode, `F` flashlight.

- **Sprites** (creatures, items, effects): `const h = renderer.sprites.add({ x, y, z,
  frame | glyph: {symbol, color}, height, anchor, lift })` → `h.set(x, y, z)`,
  `h.setFrame(frame, height?)`, `h.flash(color, seconds)`, `h.setVisible(b)`, `h.remove()`.
  Tile coords (+0.5 = tile centre). Billboards are lit, shadowed and darker indoors.
  Spec extras: `opacity` (0..1, dithered screen-door; `h.setOpacity(v)`), `fadeNear`
  (dissolve when the camera is within ~2 m). Monster-count scale is fine: dynamic sprites
  share one instanced draw per texture page. Static per-chunk sets use `sprites.addStatic`.
- **Lights**: `const l = renderer.lights.add({ x, y, z, color, intensity, radius, height,
  flicker })` → `l.set(...)`, `l.intensity = …`, `l.remove()`. Terrain/furniture
  `light_emitted`, `fd_fire` fields and items with a `LIGHT_<n>` flag are picked up
  automatically. `renderer.setFlashlight(on)` is the items-system hook.
  All of them go through the **light map** (src/render/lightmap.ts + lightfield.ts): a
  CDDA-lightmap-style CPU pass over 128×128 tiles of the player's z-level (sun/sky through
  open sky, windows and doors as directional cones + a little bounce; every source
  shadowcast with CDDA's falloff), uploaded as a float texture the world/sprite shaders
  sample (masked bilinear, so light never crosses a wall). The nearest 4 sources also get a
  three.js point light for normal shading, gated by the light map (no leaks). Natural light
  rebuilds when chunks change, artificial light at ≤10 Hz (fire flicker) or when a handle
  changes. Daytime interiors use eye adaptation (exposure); nights stay dark.
- **Light queries**: `renderer.lightAt(x, y, z)` → CDDA light level in luminance units
  (daylight ~100, lit room ≥10, `LIGHT_AMBIENT_LOW` 3.5 = too dark to see) — use it for
  vision/stealth. Exact on the player's level within 64 tiles, an indoor/outdoor estimate
  elsewhere. **Gameplay code calls `vision.ts lightAt(game, x, y, z)`**, which reads this
  light map through `game.lightProvider` (`renderer.exactLightAt`, set in main.ts) where it is
  exact, adds the survivor's flashlight beam (a spotlight, not in the map), and falls back to
  vision's own estimate elsewhere and in headless tests.
- **Viewmodel** (first person only): `renderer.viewmodel?.attack('melee'|'fire'|'throw')`
  animates the wielded item (`player.inv.wielded`, atlas sprite composited with a pixel
  fist; bare fists when unarmed): swing/punch, recoil + muzzle flash + light, throw.
  Walking bob and look sway are automatic.
- **Hit feedback**: `renderer.shake(0..1)`, `renderer.hurtFlash(0..1)` (red vignette);
  both fire automatically on `game.events.emit('playerHurt', { amount, bp? })`.
- **Fields** (`chunk.fields`): liquids/gore/debris (fd_blood, fd_bile, fd_gibs_*, fd_acid…)
  are floor decals, smoke/gases are dithered translucent billboards, fire is a billboard +
  light; see `fieldStyle()` in tileKinds.ts. Rain stops at roofs (light-map cover texture).
- **Items on the map**: top item as a small billboard, piles show up to 3; items sit on
  tables/counters, are hidden inside CONTAINER furniture (lockers, dressers, fridges).
- **Tile art**: everything goes through `TileTextureSource` (src/render/textureSource.ts);
  `AtlasTextureSource` (UltiCa) falls back to `ProceduralTextureSource`. Monster/item
  systems should get frames via `renderer.source.sprite(id)` / `.item(id)` / `.glyph()`.
- **Seams**: world textures take alpha (cut-out coverage) from mip 0 while colour uses the chosen
  mip (materials.ts WORLD_MAP), ceilings tuck `CEIL_TUCK` into the walls below and door leaves
  overlap their lintel: edge-to-edge geometry showed sky-coloured dotted cracks on real GPUs.
- **Cameras**: the mouse wheel zooms top-down (`rig.topDistance` 10–60). While driving,
  VehicleRenderer fills `rig.drive` (a `DriveView`: centre, heading, driver eye, length, speed,
  roughness) every frame and V cycles the driving cameras (`rig.driveCam`, persisted in
  localStorage `cdda3d.driveCam`, separate from the on-foot `rig.footMode`): chase (default;
  trails the heading, pulled in by walls, looks further ahead and widens FOV with speed) ->
  cockpit (driver eye ~1.2 m in cars, 1.3–1.45 m in vans/buses; mouse look is relative to the
  car because `p.yaw` turns with it) -> top-down. `rig.mode` reads as the on-foot equivalent
  (chase = third, cockpit = first). Pure math in src/render/driveCamera.ts
  (tests/driveCamera.test.ts).
- **Other**: `renderer.setWeather('clear'|'rain'|'storm'|'snow')`,
  `renderer.setCameraMode('first'|'third'|'top')`, `renderer.flushChunks()` (tests).
  Plain three.js objects added to `renderer.scene` are auto-patched for the MRT output.
- Map edits need no renderer calls: chunk meshes rebuild when `chunk.version` changes.
- Debug API: `cdda.setCameraMode`, `cdda.flashlight`, `cdda.setWeather`, `cdda.settle()`
  (build all chunks + render; call before screenshots), `cdda.renderStats()`,
  `cdda.lightAt(x?,y?,z?)` (absolute tile, gameplay light = this light map where exact),
  `cdda.lightmapAscii(r)`, `cdda.addLight(dx,dy,{…})`, `cdda.addField(x,y,z,type,n)`,
  `cdda.placeItem(id,dx,dy,count?)`, `cdda.lookAt(x,y)`, `cdda.findFurniture(re)`,
  `cdda.viewmodelAttack(kind)` (animation only; `cdda.attack()` really attacks), `cdda.viewmodelPose(kind,t)` (freeze an
  attack pose), `cdda.shake(a)`, `cdda.hurtFlash(a)`, `cdda.benchRender(n)` (ms/frame),
  `cdda.shimmerTest(frames, px/frame)` (pixel-stability metric for a slow pan).
  `tools/render-shots.sh <prefix>` renders the regression screenshot set.

## Game design conversion rules

- Controls: WASD move, mouse look, Shift run, C crouch, LMB attack/fire, RMB aim (guns) / ready (melee: LMB only swings readied),
  E/`e` examine/interact (open doors, furniture), and **CDDA keys for menus**: `i`
  inventory, `w` wield, `W` wear, `T` take off, `E` eat, `g` pickup, `d` drop, `&`
  craft, `*` construct, `@` character, `m` map, `r` reload, `a` activate, `R` read,
  `x` look, `B` butcher, `<`/`>` stairs, `$`/`|` sleep/wait, `Esc` menu, `?` help.
  (WASD collide with CDDA keys `w`/`W`/`E`… — movement keys win; CDDA-menu actions that
  collide get an alternative binding and all are listed in `?` help. Keep a keybinding
  table in one place: src/ui/keys.ts.)
- Combat: real-time melee with cooldown = CDDA attack move cost / `MELEE_SCALE` (2 turns/s, slower than movement so fights read blow by blow; monster swings too); hit
  chance and damage use CDDA formulas (to-hit vs dodge, bash/cut/stab, armor, crits,
  body-part targeting). Ranged: hitscan with CDDA dispersion → cone spread.
- Monsters use CDDA stats; speed → movement rate; senses (vision day/night, hearing via
  `sound` events, smell/scent map simplified). Zombies wander, investigate noise, chase.
- The UI is a CDDA curses look-alike: black panels, VT323-style monospace, the 16 CDDA
  colors, `[x]` letters for menu entries, sidebar with body-part HP bars and needs.

## Team conventions

- TypeScript strict. Match surrounding style. Comments explain *why*, not *what*.
- Fail loudly on bad data (unknown ids) in tools; at runtime, warn once per unknown id and
  continue (CDDA data has many mod-only references) — never silently substitute.
- Unit-test pure logic (formulas, mapgen parsing, item groups) with vitest.
- Visual/interactive features must be verified with `npm run shot` screenshots.
- Before finishing: `npm run typecheck` and `npm test` pass; commit on your branch with a
  descriptive message. Report: what you built, what's verified (with screenshot paths),
  what's missing, and any interface changes other agents must know about.

## Shared infrastructure (use these, don't reinvent)

- **UI framework** `src/ui/framework.ts`: `openWindow`, `openMenu` (CDDA uilist: letter
  hotkeys, headers, detail pane, arrows/jk/Enter/Esc, mouse), `confirm`, `prompt`,
  `colorize` (CDDA `<color_red>…</color>` markup), `c(color, text)`, `cssColor`. Windows
  capture the keyboard while open. Font is CDDA's Terminus (public/fonts). Every screen
  should be built from these.
- **ui2 (v2 UI toolkit)** `src/ui2/`, documented in **docs/UI2.md**: mouse-first pixel-art
  windows, drag & drop, context menus (+ `worldContextProviders` for world objects), tooltips,
  toasts, hotbar, paper doll, integer UI scaling. New and ported screens are built from it.
  Opening a ui2 surface frees the cursor and may add a tactical-pause hold (src/game/pause.ts); `?debug=ui2` is the
  showcase; looting from the world (quick loot at the crosshair, area loot window, pile markers,
  searched memory, smart Take all: `src/ui2/loot/`, docs/UI2.md "Looting");
  i / Tab open the inventory (`src/ui2/bn/`, on the BN item model), `o` the crosshair's
  context menu; 1…0 are hotbar slots.
- **Key bindings** `src/ui/keys.ts`: all default keys live in `DEFAULT_BINDINGS`; systems call
  `game.keys.register(actionId, 'Description', handler)`. To add an action, add it to the
  table (keep it conflict-free; WASD/shift/space are movement). Players can rebind
  (Options > Key bindings, stored as a diff in localStorage; pure rules in `keymap.ts`), so
  **never hard-code a key in text**: use `game.keys.label(id)` / `keyFor(id)`, or write
  `<keybind:id>` inside `game.message()` text. Movement is physical (`e.code`), actions are
  `e.key` (CapsLock-normalized); `keys.movementKeys()` names WASD on the player's layout.
- **Mouse capture** `src/ui/pointer.ts` + `src/core/input.ts`: gameplay holds pointer lock;
  menus keep it (or free the cursor, Options > Menu cursor). Every window closes on its opening
  key, Backspace and Esc (the framework adds that legend to the footer). A browser-eaten Esc
  arrives as a lock loss and is replayed as Esc into the top window. Windows about looking pass
  `mouseLook: true`.
- **Activities** `src/game/activity.ts`: `game.activities.start({name, duration, onComplete,
  onProgress?, onCancel?, warp?, interruptible?})` for any long action (craft, read, butcher,
  construct, wait, sleep). Warps the clock, cancels on movement/danger. Danger sources
  register `game.activities.dangerChecks.push(() => reason | null)`.
  The survivor's own state (freezing, dehydrated) goes in `activities.distractionChecks`: it
  interrupts only when it newly arises, never blocks starting (CDDA's "ignore" semantics).
- **Items on the map** are real `Item` instances (`src/game/item.ts`). Mapgen emits
  `ItemSpawn`s which `GameMap.itemFactory` (set in Game) converts via `fromSpawned`. Game code puts
  items on tiles with `spawnOnGround` / `moveItem` (src/game/moves.ts), never `map.addItem`.
- **Tile raycasts** `src/game/raycast.ts`: `raycastTiles(map, {x,y,h}, dir, {maxDist,
  creatureAt, throughTransparent})` → first creature / furniture / terrain / floor / ceiling
  hit (h = metres, x/y tiles; same as three.js X/Z). `dirFromYawPitch(yaw, pitch)`.
  `game.lookAt(maxDist?)` = ray through the crosshair of the active camera (any mode).
  Monsters: set `game.creatureAt = (x, y, z) => LookCreature | null` so look mode and rays see them.
  `game.creatureAt` is a chain: installNpcs wraps the monsters' version (NPC first, else
  monster). Vehicles block rays via `vehicleAt` (kind `'vehicle'`); look mode lists the vehicle
  name, condition and the parts at that spot (`describeVehicleAt` in src/ui/vehicle_ui.ts).
- **HUD** `src/ui/hud.ts`: `hud.setPrompt('[e] Open door' | null)` (sticky) or
  `hud.addPromptProvider(game => text | null)` (per frame, first non-null wins; returns an
  unregister fn). `hud.safeMode = {text, color}`. The HUD also draws the activity bar.
  v2: the modern HUD (`src/ui/hud_modern.ts` on the ui2 HUD layer; rules in `hud_logic.ts`, pixel
  icons + body silhouette in `pixelart.ts`): body per-part HP with bleeding/bandage/broken marks,
  need icons that light up with advice tooltips, effect chips, compass strip (hostiles in sight,
  destination, refugee centre) + danger light, clock/weather/light, weapon/ammo (sidebar
  providers' lines go under it), message feed (click → log), stamina, activity. **Status banner
  slot**: `hud.setBanner(id, {text, sub?, tone?} | null)` (top centre, under the compass: PAUSED,
  SLEEPING…). Options: "HUD style" (Modern / Detailed = the CDDA sidebar restyled), "HUD width"
  (Auto = centred 16:9 on screens wider than 2.1:1, the ui2 root var `--hud-x`; Full; 16:9). Bottom centre is left for the hotbar.
- **Status screens on ui2** (`src/ui/screen2.ts` `openScreen(game, {action, …})`: a ui2 panel that
  closes on its opening key / Bksp / Esc): character `@` (charsheet.ts, tabs; `charsheetSections`
  still adds boxes), map `m` (overmap_ui.ts: UltiCa overmap sprites, drag/wheel, notes and a
  destination in `mapmarks.ts`, save section `mapnotes`), look `x` / hover (look.ts: world-anchored
  card; `worldHoverListeners` in ui2/install.ts), help `?`, options + key bindings, Esc menu and
  message log (escmenu.ts), death screen. Esc menu/options/help/look use `pauses: 'always'` (time
  stops regardless of the inventory-pause setting); character/map/log follow it (`pauses: true`).
- **Stats** `game.stats` (src/game/stats.ts): `addKill(monId)` (auto-counted from
  `creatureDied` events whose `killer === game.player`; don't double count), `itemsCrafted`,
  `distanceWalked` (tracked by the UI), for the memorial screen.
- **Overmap memory** `game.overmapSeen`: Set of `"omx,omy,z"` (UI reveals ~3 OMTs around you by
  day, 15 at start). **Save/load hooks**: set `game.save`, `game.load`, `game.hasSave`; the menus
  grey out until they exist. Modal windows pause the sim (`game.pauseInMenus`).
- **UI data** `public/data/ui.json` (`npm run extract:ui`): title art, tombstone, names, help.
  Boot shows the title screen unless `?skipmenu=1` (or under automation without `?menu=1`).
  `cdda.ui.quickStart()` makes a default Evacuee; `cdda.ui.open('inventory'|'map'|…)`,
  `cdda.spawnItem(id, dx, dy)`, `cdda.pressKey(key)`, `cdda.ui.lookHit()`.

## Merge etiquette for parallel agents

You work in a git worktree; the lead merges branches. Shared hot files — `src/main.ts`,
`src/game/game.ts`, `src/debug.ts`, `src/core/events.ts`, `src/data/types.ts`,
`src/ui/keys.ts`, `ARCHITECTURE.md` — take **small, additive** edits only (new lines, new
fields), never reformat or reorder them. Put your feature in your own files and wire it in with
a few lines (e.g. `installMonsters(game, renderer)` from main.ts).
