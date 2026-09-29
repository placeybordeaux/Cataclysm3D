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

- CDDA source + data: `~/code/Cataclysm-DDA` (read-only! never modify). JSON docs:
  `~/code/Cataclysm-DDA/doc/JSON/` (JSON_INFO, MAPGEN, ITEM, MONSTERS, …). C++ in `src/`
  is the ground truth for formulas (e.g. `melee.cpp`, `monattack.cpp`, `character.cpp`).
- Tileset (CC-BY-SA): `/home/peter/code/CDDA-3d/vendor/tilesets/gfx/UltimateCataclysm`
  (source form: per-sprite PNGs + JSON; see its `tile_info.json`). `vendor/` is git-ignored —
  from a worktree, use the absolute path above.

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
- `window.cdda` (src/debug.ts) is the automation API. Register helpers for anything you
  add (`cdda.spawnMonster(id, dx, dy)`, `cdda.giveItem(id)`, …) so others can test.
- Generated data lives in `public/data/` (by `npm run extract`) and `public/atlas/`
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

- `item.ts` Item/Pocket (charges, damage, rot, pockets, magazines), `createItem`, `fromSpawned`.
- `character.ts` Character: stats, skills, body-part HP, pain, stamina, needs, sleep, blood,
  morale/focus, body temperature, traits. `update(gameDt)` in game seconds.
- `effects.ts` data-driven effect_type (misc.effect_type, with built-in fallbacks).
- `inventory.ts` `character.inv`: wield/wear/pick up/drop/consume/use/reload, qualities,
  encumbrance, armor absorption. Actions return `{ok, msg, moves, dropped?}`.
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
- `monattack.ts` special attacks: data melee/bite actors (misc.monster_attack), leap, boomer
  bile, and hardcoded SHRIEK, ACID, RESURRECT, SHOCKSTORM, PARROT, SMASH...
- `spawner.ts` consumes `chunk.spawns` (then clears them) + CDDA city hordes; tuning knob
  `cityHordeScale` (0.3 of CDDA's 80 zombies × city size).
- `playercombat.ts` LMB melee (crosshair cone) / hitscan guns / `G` throw; `butchery.ts`.
- Seams: `game.bash?.(x, y, z, str)` (bash.ts) lets zombies smash doors;
  `game.stats?.kills` gets kill counts; `renderer.viewmodel?.attack(kind)` is called on
  attacks. Rendering: `src/render/monsterView.ts` (sprites, corpses, blood decals).
- Crafting (`crafting*.ts`, `requirements.ts`, `construction.ts`, `disassembly.ts`, `reading.ts`,
  `fire.ts`): functions take a `CraftHost` (Game satisfies it). `CraftingInventory.gather` =
  inventory + map items/furniture pseudo tools within 2 tiles + `fire` from a nearby `fd_fire`.
  Knowledge lives on Character (`learnedRecipes`, `identifiedBooks`, `proficiencies`).
  `hasCraftingLight` uses `game.lightAt`/`map.lightAt(x,y,z)` if present (>= 4 = bright enough).
  Other systems' use_actions: `inv.useHandlers.set(type, fn)` (crafting registers `firestarter`).
  UI + keys (`& * ( R`) + `cdda.*` helpers: `installCrafting(game, api)` in src/ui/crafting_install.ts.

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
  (`e`), `zlevels.ts` (`<`/`>`, falling), `rest.ts` (`|` wait, `$` sleep), `weather.ts`
  (`game.weather`), `traps.ts`, `lightitems.ts` (`F`: flashlight transform).

### Extension points (prefer these over editing someone else's code)

- `game.systems.push({ name, update(game, realDt, gameDt) })` for per-tick simulation.
- `game.events.on('sound' | 'message' | …)` typed bus in `src/core/events.ts` — add event
  types there.
- `map.onChunkGenerated` for spawning things when chunks appear.
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

### Renderer APIs (src/render)

Pipeline: scene → low-res MRT target (~360 px tall, exact integer upscale; colour + view
normals + depth) → post pass (depth/normal outlines, fog, Bayer dither, palette/LUT grade)
→ nearest blit. URL params: `px=`, `grade=palette|smooth|off`, `tex=atlas|procedural`,
`cam=first|third|top`, `walls=tinted|sprite`, `debug=1` (stats overlay; F6/F7 cycle grade
and wall style). Keys: `V` camera mode, `F` flashlight.

- **Sprites** (creatures, items, effects): `const h = renderer.sprites.add({ x, y, z,
  frame | glyph: {symbol, color}, height, anchor, lift })` → `h.set(x, y, z)`,
  `h.setFrame(frame, height?)`, `h.flash(color, seconds)`, `h.setVisible(b)`, `h.remove()`.
  Tile coords (+0.5 = tile centre). Billboards are lit, shadowed and darker indoors.
- **Lights**: `const l = renderer.lights.add({ x, y, z, color, intensity, radius, height,
  flicker })` → `l.set(...)`, `l.intensity = …`, `l.remove()`. Nearest 8 are active.
  Terrain/furniture `light_emitted` and `fd_fire` fields are picked up automatically.
  `renderer.setFlashlight(on)` is the items-system hook.
- **Tile art**: everything goes through `TileTextureSource` (src/render/textureSource.ts);
  `AtlasTextureSource` (UltiCa) falls back to `ProceduralTextureSource`. Monster/item
  systems should get frames via `renderer.source.sprite(id)` / `.item(id)` / `.glyph()`.
- **Other**: `renderer.setWeather('clear'|'rain'|'storm'|'snow')`,
  `renderer.setCameraMode('first'|'third'|'top')`, `renderer.flushChunks()` (tests).
  Plain three.js objects added to `renderer.scene` are auto-patched for the MRT output.
- Map edits need no renderer calls: chunk meshes rebuild when `chunk.version` changes.
- Debug API: `cdda.setCameraMode`, `cdda.flashlight`, `cdda.setWeather`, `cdda.settle()`
  (build all chunks + render; call before screenshots), `cdda.renderStats()`.
  `tools/render-shots.sh <prefix>` renders the regression screenshot set.

## Game design conversion rules

- Controls: WASD move, mouse look, Shift run, C crouch, LMB attack/fire, RMB aim,
  E/`e` examine/interact (open doors, furniture), and **CDDA keys for menus**: `i`
  inventory, `w` wield, `W` wear, `T` take off, `E` eat, `g` pickup, `d` drop, `&`
  craft, `*` construct, `@` character, `m` map, `r` reload, `a` activate, `R` read,
  `x` look, `B` butcher, `<`/`>` stairs, `$`/`|` sleep/wait, `Esc` menu, `?` help.
  (WASD collide with CDDA keys `w`/`W`/`E`… — movement keys win; CDDA-menu actions that
  collide get an alternative binding and all are listed in `?` help. Keep a keybinding
  table in one place: src/ui/keys.ts.)
- Combat: real-time melee with cooldown = CDDA attack move cost / ACTION_SCALE; hit
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
- **Key bindings** `src/ui/keys.ts`: all default keys live in `DEFAULT_BINDINGS`; systems call
  `game.keys.register(actionId, 'Description', handler)`. To add an action, add it to the
  table (keep it conflict-free; WASD/shift/space are movement).
- **Activities** `src/game/activity.ts`: `game.activities.start({name, duration, onComplete,
  onProgress?, onCancel?, warp?, interruptible?})` for any long action (craft, read, butcher,
  construct, wait, sleep). Warps the clock, cancels on movement/danger. Danger sources
  register `game.activities.dangerChecks.push(() => reason | null)`.
- **Items on the map** are real `Item` instances (`src/game/item.ts`). Mapgen emits
  `ItemSpawn`s which `GameMap.itemFactory` (set in Game) converts via `fromSpawned`.
- **Tile raycasts** `src/game/raycast.ts`: `raycastTiles(map, {x,y,h}, dir, {maxDist,
  creatureAt, throughTransparent})` → first creature / furniture / terrain / floor / ceiling
  hit (h = metres, x/y tiles; same as three.js X/Z). `dirFromYawPitch(yaw, pitch)`.
  `game.lookAt(maxDist?)` = ray through the crosshair of the active camera (any mode).
  Monsters: set `game.creatureAt = (x, y, z) => LookCreature | null` so look mode and rays see them.
- **HUD** `src/ui/hud.ts`: `hud.setPrompt('[e] Open door' | null)` (sticky) or
  `hud.addPromptProvider(game => text | null)` (per frame, first non-null wins; returns an
  unregister fn). `hud.safeMode = {text, color}`. The HUD also draws the activity bar.
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
