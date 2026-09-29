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
tools/
  extract/           CDDA JSON → public/data/*.json
  atlas/             UltiCa PNGs → public/atlas/*
  shot.ts            headless screenshot harness
tests/               vitest unit tests (pure logic, no DOM/WebGL)
```

### Extension points (prefer these over editing someone else's code)

- `game.systems.push({ name, update(game, realDt, gameDt) })` for per-tick simulation.
- `game.events.on('sound' | 'message' | …)` typed bus in `src/core/events.ts` — add event
  types there.
- `map.onChunkGenerated` for spawning things when chunks appear.
- `input.onPress(e => …)` for global keys, `input.capture(handler)` for modal menus.

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
