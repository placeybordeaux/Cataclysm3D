# CDDA-3D — status and handoff (end of wave 3, 2026-09-30)

Branch **`bn`** is the live game (Cataclysm: Bright Nights content and rules, modern UI).
`master` is still v1 (DDA data, curses-style UI), tagged `v1-dda`. Merge `bn` → `master` once
you're happy with wave 3.

## Wave 3 in one screen (overnight, 2026-09-29/30)

Direction from the user: stop mixing camera-facing 2D sprites with voxels — do what *Project
Shadowglass* does (real low-poly 3D geometry, fixed-density nearest-filtered pixel textures,
stepped lighting and animation, near/far asset versions); make every look readable at
distance; replace hidden to-hit dice with visible skill; fix the boxy cars; adapt the source
"like a TV adaptation of a book" for newcomers. Six parallel agents + a QA agent, ~30 merges.

| Area | Doc | What changed | Switch (old behaviour stays one click away) |
|---|---|---|---|
| Characters | `docs/CHARACTERS.md` | Monsters, NPCs, corpses, player body = procedural low-poly rigs painted from the UltiCa sprite palette (faces, clothes, blood), stepped 10 fps animation, per-zombie quirks, 10+ body plans (humanoid variants, quadruped, bugs, birds, bats, blobs, plants, machines), far figures to 130 m. 3D first-person arms and per-weapon held models. Remaining billboards (fire, arrows, mannequins, statues, loot) made world-fixed. | Options → Creatures / First-person hands; `?chars=billboard`, `?viewmodel=sprite`, `?props=billboard` |
| Furniture & surfaces | `docs/FURNITURE.md` | 75 modelled furniture archetypes (neighbours join up), doors, windows (broken-glass fix), ground items as shapes; procedurally painted walls/floors/ceilings/roofs at real scale; fences/gates; rooms with per-room finishes; set dressing (pictures, grime, blood, rugs, lamps, house numbers); wrecked-house clutter. | Options → Furniture / Surfaces; `?dressing=off` |
| Vehicles | `docs/VEHICLES.md` | One modelled body per vehicle (11 styles + liveries), damage/wreck states, collision follows the drawn body, cockpit with live gauges, wipers, hands on the wheel, trunk lids, LOD. Fill up at gas pumps. | Options → Vehicle look / width; `?vehicles=parts` |
| Readability & image | `docs/READABILITY.md` | Sky-tinted light haze instead of the grey fog wall, far ground ring to the horizon, weather-driven sky, toon-stepped form lighting with a world-fixed fill light, cutout mips (less shimmer), round sun. | Options → Distance haze / Draw distance / Form lighting |
| Flora | `docs/FLORA.md` | Species-family 3D trees (round, willow, conifer, birch, fruit, sapling, dead) and bushes, seasonal colours, 3 LOD rings with no billboard pop, stepped wind. | Options → Trees |
| Combat | `docs/COMBAT_FEEL.md` (Aim models, rounds 2–3) | Shots/swings go where the crosshair is. Skill = sway, recoil recovery, damage, crit/stagger; hit zones read the 3D model (head ×2); optional timing minigame; melee on model parts; visible enemy fire with near-miss cues; first-fight hints. | Options → Aim model (`sway` default, `timing`, `dice` = BN) |
| Adaptation | `docs/ADAPTATION.md` | Principles + 69 playtest findings. Big fixes: BN weather was always a snowstorm; BN item light ignored (flashlights dark); shelter paved over on some seeds; nothing buildable on grass/dirt; fires died unburnt when time sped up. New: big-button title, crosshair activity ring, Rest window, route guide + road atlas, crafting "Almost" tab, credits screen, first beds / boil water / fire safety / freshness. | Several Options rows (listed in the doc) |
| QA | `docs/QA_WAVE3.md` | Integrated playtest at 3440x1304 in Chromium + Firefox, every Options switch cycled, save/load, per-scenario real-input results. | — |

Health at handoff: `npm run typecheck` clean, `npm test` 1198 passed / 19 skipped, `npm run build` green;
real-input smoke on the final `bn` (title, move, firstfight, getin, aim, options, quit) 116/116 on the GPU.
Full-suite and Firefox results: `docs/QA_WAVE3.md`.

Screenshots for every area: `docs/screenshots/wave3/<area>/` (before/after pairs; half-size JPEG).

### Decisions waiting for you

1. **Ammo economy under free aim.** A skill-0 pistol now needs ~3 shots per kill instead of ~5
   (BN dice). Ammo spawns are unchanged. Lever if you want it tighter: `FEEL.aimSkillDmg0`
   (`docs/BALANCE.md`).
2. **Licence for this project's own code.** None in the repo; the in-game credits only claim
   CC BY-SA for the derived content (BN data, UltiCa tileset).
3. **Defaults you may want to flip** after playing: first-person hands (3D vs sprite; bows use
   the 2D art), Form lighting (`toon` vs `bold`), Distance haze (`clear` vs `light`), Aim model.

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
5. **Advertise Space (the `close_menu` key) or the opening key for closing, never Esc** — outside
   fullscreen Esc also frees the mouse; Esc still works, it just never appears in a hint (docs/UX_REVIEW.md).

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
| `docs/CHARACTERS.md` | Wave 3: 3D characters, first-person view, remaining billboards |
| `docs/FURNITURE.md` | Wave 3: modelled furniture, painted surfaces, rooms, set dressing |
| `docs/VEHICLES.md` | Wave 3: vehicle bodies, collision, cockpit, refuelling |
| `docs/READABILITY.md` | Wave 3: haze, far ground, form lighting, shimmer |
| `docs/FLORA.md` | Wave 3: 3D trees and bushes |
| `docs/ADAPTATION.md` | Wave 3: adaptation principles, playtest findings, switches |
| `docs/GALLERY.md` | Style gallery (`/?gallery`): every wave-3 switch on fixed scenes, live / A/B / Matrix compare, copy as defaults |
| `docs/QA_WAVE3.md` | Wave-3 integration QA at 3440x1304 (Chromium + Firefox): issues, realinput per scenario, perf |
| `docs/PERF.md` | Performance: F3 overlay / Shift+F3 dump, `tools/perf-report.ts`, streaming fixes (build order by need, stand-ins), `npm run perf` budgets |

## Controls (current defaults; all rebindable in Options → Key bindings)

Move WASD (Shift run, `c` crouch, Space side-step) · mouse look · LMB attack/fire/loose ·
RMB guard (melee) / aim (guns) / draw (bows) · `e` interact (drive a car from beside it,
get out when stopped) · `o` world action menu · `Tab`/`i` inventory · quick-loot at the
crosshair: wheel select, `e` take, `r` take all · `g` pick up / Area loot · `1`–`0` hotbar ·
`` ` `` tactical pause · `&` craft · `*` construct · `@` character · `m` map · `J` journal ·
`M` missions · `C` chat · `p` bionics · `[` mutations · `_` martial arts · `)` achievements ·
`F` flashlight · `r` reload · `b` fire mode · `X` smash (or just hit things) · `F5` save ·
`F11` fullscreen · `?` help · Esc pause menu · **Space closes any menu** (so does the key that
opened it; rebindable as `close_menu`) and keeps the mouse captured.

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

## Open backlog (from wave 2; see the wave-3 docs' "Known gaps" for newer items)

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
