# CDDA-3D — status and handoff (end of wave 2, 2026-09-29)

Branch **`bn`** is the live game (Cataclysm: Bright Nights content and rules, modern UI).
`master` is still v1 (DDA data, curses-style UI), tagged `v1-dda`. `bn` is ~170 commits ahead;
merge it to `master` once wave 3 settles.

Health at handoff: `npm run typecheck` clean, `npm test` 990 passed / 24 skipped,
`npm run build` green (66 MB `dist/`, static, deployable to Cloudflare Pages).
Real-input suite (`tools/realinput.ts`, 33+ scenarios) last passed fully on the GPU at
960×540 and 1920×1080.

## Working on it

- `nix-shell --run 'npm run dev'` → http://localhost:5173. Hot reload keeps the running game
  (snapshot in IndexedDB on Vite reloads and dev-server restarts).
- **Live bridge** (dev only): the visible game tab reports to the terminal.
  `tsx tools/live.ts state` (position, HP, log, open windows, errors), `shot [out.png]`
  (3D canvas; HUD is DOM so read it from `state`), `eval "<js>"` (`cdda`, `game` in scope).
  Only the *visible* tab answers — if two tabs are open, the one in front wins.
- The human plays in **Firefox** on a **3440×1304** ultrawide. Check both.
- Heavy jobs (browsers, builds) go through `~/claude-stuff/bin/heavy`; GPU work
  `--kind gpu --mem 2`. The default "full" look runs at 1–3 fps under SwiftShader, so
  real-input runs need `--gpu` (or `--params look=classic`).
- Tools: `npm run shot` (headless screenshots / `--print`), `tsx tools/drive.ts` (persistent
  session; `--headful` = real xdotool input under Xvfb; `--gpu`; `--dist`),
  `tsx tools/realinput.ts [--only a,b] [--gpu] [--browser firefox] [--hmr]`,
  `tsx tools/look-shots.ts`, `tsx tools/bench-stream.ts` (per-section frame spikes),
  `npm run sim` (headless balance sim), `npm run data:all` (re-extract BN data).

## Rules that paid off (keep them)

1. **Real input for anything a player does.** Debug helpers only for setup. Every major UX
   bug in wave 1/2 (Shift+W → wear, Esc killing mouse-look, controls you couldn't find) was
   invisible to QA that drove the game through `cdda.*`.
2. **Item conservation is an invariant.** Every item move goes through `src/game/moves.ts`;
   `tests/conservation.test.ts`, `tests/inventory_ui2.test.ts`, `tests/loot.test.ts` fuzz it.
   `tests/moves_lint.test.ts` fails if anything bypasses it.
3. **Units come from BN's C++, not guesses.** Two big wave-2 bugs were unit mistakes:
   `power_draw` is mW (flashlights died in a second), wheel sizes are cm (1.4 m tyres).
4. **Parallel agents in worktrees, small additive edits to hot files, lead merges.** When
   two branches rewrite the same flow, send the merge back to the agent that knows it.

## Documentation map

| Doc | What |
|---|---|
| `docs/DESIGN_V2.md` | Product direction for v2 (BN, new audience, modern UI, progression) |
| `ARCHITECTURE.md` | Code map, APIs, extension points (long; search it) |
| `docs/BN_DATA_MODEL.md` | Normalized BN data, DDA→BN differences |
| `docs/INVENTORY_MODEL.md` | Item locations, the moves API, `inventoryView`, verdicts |
| `docs/UI2.md` | UI toolkit, screen patterns, inventory screens, looting styles, hotbar |
| `docs/COMBAT_FEEL.md` | Melee phases, telegraphs, guard/side-step, archery, miss reasons |
| `docs/BALANCE.md` | Difficulty presets, tactical pause, sim tables |
| `docs/LOOKS.md` | Visual styles (classic/crisp/voxel/terrain/full), perf, screenshots |
| `docs/UX_REVIEW.md` | Input/pointer-lock model, key rules |
| `docs/QA_V2.md` | Latest full playtest: issues and statuses |
| `docs/QA_WAVE3.md` | Wave-3 integration QA at 3440x1304 (Chromium + Firefox): issues, realinput per scenario, perf |

## Controls (current defaults; all rebindable in Options → Key bindings)

Move WASD (Shift run, `c` crouch, Space side-step) · mouse look · LMB attack/fire/loose ·
RMB guard (melee) / aim (guns) / draw (bows) · `e` interact (drive a car from beside it,
get out when stopped) · `o` world action menu · `Tab`/`i` inventory · quick-loot at the
crosshair: wheel select, `e` take, `r` take all · `g` pick up / Area loot · `1`–`0` hotbar ·
`` ` `` tactical pause · `&` craft · `*` construct · `@` character · `m` map · `J` journal ·
`M` missions · `C` chat · `p` bionics · `[` mutations · `_` martial arts · `)` achievements ·
`F` flashlight · `r` reload · `b` fire mode · `X` smash (or just hit things) · `F5` save ·
`F11` fullscreen · `?` help · Esc menu.

## What v2 delivered

BN data/rules throughout (items, monsters, recipes, mapgen, NPCs, vehicles, mutations,
bionics, achievements); inventory rebuilt (BN containers, one location per item,
drag-and-drop screens, hotbar); looting (quick-loot at the crosshair, Area loot, pile markers,
searched memory, smart take-all); crafting/construction screens (search, queue, ghost
placement, in-progress items); modern HUD, character sheet, pan/zoom map, look cards;
dialogue/trade/missions/vehicle/body-mod screens; combat feel (phased swings, telegraphs,
guard/parry/side-step, hit reactions, miss reasons) and archery (draw/loose, visible arrows,
recovery); driving (chase cam, direct throttle, run-overs incl. NPCs, headlights);
progression (quick start, unlock ladder, discovery tips, journal); difficulty presets and
tactical pause; visual depth ("full" look: crisp render, voxel furniture, 3D trees, roofs,
terrain relief, grass, skyline) with time-sliced meshing.

## Open backlog (starting point for wave 3)

From playtests and agent reports, roughly by value for the new-audience goal:

**Feel & clarity**
- Combat: no dodge animation, no aim assist at arm's length; first fight should be re-checked
  by a human (sim says 6–9 s on Accessible).
- Archery at skill 0 hits ~1 in 5 at 8 m (BN-faithful). Consider a gentler Accessible curve.
- Title screen: pixel logo done, but the menu is still a terminal-style row — big buttons.
- Tip-of-the-day and messages still contain CDDA-isms / features this port lacks (style pass).
- HUD shows contradictory needs ("Bloated" + "Famished") — explain or merge.
- Weather vs visuals mismatch ("Snowstorm" on a green spring morning; BN weather seeds).
- Activities: consider a visible "stand still" hint / progress bar near the crosshair for
  every timed action (the fire-lighting confusion).

**Systems gaps**
- NPC archers shoot instantly; arrows ignore NPCs. Monsters don't fight each other or change
  z-levels deliberately (they do fall now).
- NPCs don't eat/sleep/keep schedules; recruiting followers is hard early.
- Vehicle construction/repair, siphoning/refuelling, towing, turrets not built.
- Mapgen: mutable specials simplified; no subways/sewers/railroads near the start; lab escape
  cells / train depots missing.
- Mutation special attacks, bionic guns, frostbite/blisters not modelled.
- Achievements that need untracked events never unlock (listed in the achievements screen).

**Tech**
- Voxel/tree meshing is time-sliced, not threaded; a Web Worker pool would remove the last
  17 ms spikes when driving fast.
- Atlas: DDA UltiCa source + no BN fill (63% item coverage with looks_like). A union build
  (DDA primary, BN compiled as fill) would cover more BN-only content.
- 24 skipped tests are marked `TODO(BN)` (nature/farming seed data, some e-file/weather
  cases) — `grep -rn "TODO(BN)" tests`.

**Release**
- Deploy: static `dist/` → Cloudflare Pages works (`npx wrangler pages deploy dist`).
  Before a public deploy: decide on the CO.AG music (informal permission only — or ship with
  `npm run audio -- --music-tracks 0`), add a CC-BY-SA credits line in-game, consider dropping
  the 12 MB Unifont fallback font, and merge `bn` → `master`.
