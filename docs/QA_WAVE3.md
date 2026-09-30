# QA wave 3: the merged `bn` branch, as the user plays it (2026-09-30)

Scope: integration QA after six areas reworked the game overnight (characters, furniture,
vehicles, readability, flora, combat, adaptation). Everything is played as the user plays it:
**3440x1304**, default settings, **real OS input** (xdotool into a windowed browser on Xvfb),
`cdda.*` only for setup (teleport to a street/house/forest, the hour, a zombie, a car on a
road) and to read state. Branch tested: `bn` at `b0dec39`, then again after merging
`f75aba3` (adaptation round 6).

Status: ✔ fixed here · ✘ open (owner named) · ◐ partly · — not a bug / no action.

## How to repeat

```
# the first evening at the user's size (title → shelter → street → house loot → zombie →
# car → dusk/night + flashlight → forest → F5 / reload / load), screenshots + frame times
nix-shell --run '~/claude-stuff/bin/heavy --kind gpu --mem 2.5 -- npx tsx tools/qa-playthrough.ts --gpu'
nix-shell --run '~/claude-stuff/bin/heavy --mem 3 -- npx tsx tools/qa-playthrough.ts --browser firefox'
# every Options row cycles by arrow keys (new scenario)
nix-shell --run '~/claude-stuff/bin/heavy --kind gpu --mem 2.5 -- npx tsx tools/realinput.ts --gpu --only options'
```

New tools on this branch: `tools/qa-playthrough.ts` (the holistic run above; `--only`,
`--size`, `--browser`, writes `report.json` with per-step notes, perf and console output) and
the realinput scenario **`options`** (`tools/realinput_qa.ts`): every Options row must change
with → and cycle back (sliders: move and walk back), no page error, no duplicate row, every
wave-3 switch present, the game still drawing afterwards.

## Results

| Run | Result |
|---|---|
| `npm run typecheck` | clean (before and after merging `f75aba3`) |
| `npm test` | green: 1186 passed / 19 skipped; after the merge **1198 passed / 19 skipped** |
| realinput, **Chromium GPU, 960x540, full suite** (48 scenarios) | **431/434**; the 3 failures were `firstfight` (test setup, fixed ✔ #3) and one `aimzones` shot (dog side-on hit a limb; 9/9 on rerun) |
| realinput, Chromium GPU, **3440x1304**: title, move, menus, esc, firstfight, ui2, inv, invloot, screens, lootquick, getin, vehicle, aimwide, combat3, options, quit | **253/255**; `menus` "E says why" (1.2 s timeout) and `inv` (null rect) are timing flakes at the ~12 fps of a headful 3440 window under Xvfb; both pass on rerun (119/119) |
| realinput, **Firefox + HMR, 960x540**: title, move, menus, esc, keys, focus, firstfight, ui2, inv, invloot, lootquick, getin, save, options, quit | **236/241**; `inv` and `getin` were timing flakes under Firefox's software GL (rerun 75/75); 3 were my new `options` scenario mis-handling sliders (fixed) |
| realinput after merging `f75aba3`, Chromium GPU: title, onboarding, move, esc, craft, firstfight, ui2, inv, save, getin, options, quit | 137/138, then `inv` 28/28 with the harness fix (#9) |
| `qa-playthrough.ts`, Chromium GPU, 3440x1304 | 9/9 steps, 0 page errors |
| `qa-playthrough.ts`, **Firefox** (llvmpipe), 3440x1304 | 9/9 steps, 0 page errors (slow: software WebGL under Xvfb, see perf) |
| Hot reload | ✔ `quit --hmr` in Firefox: touching `src/main.ts` resumes the same survivor; Esc and Quit work after it |
| Save / load with the new content | ✔ F5 in the forest, page reload, title `l` + Enter: same position (852.5, 1006.5), same 11 items, clock carried (both browsers) |

### Per-scenario, Chromium GPU 960x540 full suite

title 8/8 · onboarding 12/12 · newgame 9/9 · move 5/5 · menus 96/96 · esc 12/12 · keys 4/4 ·
focus 3/3 · fullscreen 5/5 · freecursor 4/4 · azerty 5/5 · craft 9/9 · rebind 8/8 · mouse 4/4 ·
**firstfight 1/3 → 3/3 after #3** · ui2 11/11 · ui2kit 5/5 · inv 7/7 · invbag 8/8 · invloot 3/3 ·
inve 1/1 · invliquid 6/6 · invkeys 11/11 · pause 7/7 · save 4/4 · screens 17/17 · lootquick 12/12 ·
lootarea 9/9 · lootsweep 8/8 · talk 6/6 · trade 6/6 · missions 4/4 · vehicle 7/7 · getin 5/5 ·
carside 5/5 · cardoors 7/7 · body 5/5 · autodoc 6/6 · scores 3/3 · archery 13/13 · aim 26/26 ·
**aimzones 8/9 → 9/9 rerun** · aimwide 2/2 · combat3 10/10 · aimdebug (diagnostic) · aimtiming 6/6 ·
death 5/5 · quit 13/13 · **options 56/56** (new, run separately; 56 checks after `f75aba3`).

### Firefox (the user's browser), 960x540 + HMR

title 8/8 · move 5/5 · menus 96/96 · esc 12/12 · keys 4/4 · focus 3/3 · firstfight 3/3 · ui2 11/11 ·
inv 0/1 → 1/1 rerun · invloot 3/3 · save 4/4 · lootquick 12/12 · getin 4/5 → 5/5 rerun ·
options 51/54 → 54/54 (scenario fix) · quit 20/20.

## Issues

| # | Issue | Sev | Repro | Owner | Status |
|---|---|---|---|---|---|
| 1 | **Options listed "Draw distance" twice** with different steps and labels: the readability row (96 / 120 / 168 m, `cdda3d.drawRadius`) and the pre-wave-3 row in `options.ts` (radius×24 m = "144 m" for the same radius, steps 4-10, `cdda3d.options.radius`). The old one was re-applied at boot *after* the new one, so a player who had ever touched the old row got that radius back whatever the new row said. | S2 | Esc → o, scroll: two "Draw distance" rows showing 120 m and 144 m | readability / UI | ✔ `755a12c`: one row; a stored legacy radius migrates once to the nearest new step; changing it keeps world prefetch one ring ahead (the old row did, the new one didn't). The `options` scenario now fails on any duplicated row. |
| 2 | **Dandelions (and sunflowers, mustard, cattails) were solid ~1 m yellow crates** in every forest, field and front yard. UltiCa draws these only as `_season_<s>` tiles; the voxel and card furniture paths looked up the plain id without the season, missed the atlas and inflated the procedural fallback block. Pre-existing (it is in `docs/screenshots/looks/full_forest.jpg`), but it reads as a missing-model bug next to the new modelled world. | S2 | Forest view (`look-shots --views forest`): two yellow blocks; crosshair on one says "Examine the dandelion" | furniture / flora | ✔ `403cef9`: `src.furniture(id, 'sprite', { season })` in `voxel.ts` and the card path in `chunkMesh.ts` (1-line additive edit). Shots: `dandelion_before/after.jpg`, `08_forest_before_fix` / `09_forest_after_fix`. |
| 3 | `firstfight` failed in the full suite: the zombie spawned 4 tiles north of wherever `craft` left the survivor, which was by the shelter wall, so it stood outside a window for 45 s (0 blows). Test setup, not the game. | S3 (test) | full realinput suite | QA | ✔ `1ec1cc8`: the scenario first moves to open ground (7 clear tiles north) |
| 4 | Frame times at 3440x1304 in a **headful** window under Xvfb are ~12 fps (interval p50 83 ms) with the GPU nearly idle (render 2-3 ms). Same for the `classic` look; headless at the same size runs 60 fps. It is Xvfb presenting a 4.5 Mpx window, not the game — but it is what makes time-based realinput checks flaky at that size. | — | `qa-playthrough.ts --gpu` vs `look-shots --gpu --bench --size 3440x1304` | — | — noted; use the headless numbers below for perf |
| 5 | Streaming frame work at 1080p is a little higher than LOOKS.md's pre-wave-3 numbers: loop p99 13.0 ms sprinting (was 10.5) and 14.4 ms driving 40 mph (was 10.6); `chunks` is the biggest section while driving (3.3 ms/frame mean: modelled trees, furniture, dressing). Frame interval stays at 16.7 ms p50/p95; no frame over 33 ms sprinting, 15/1185 driving. Machine load average was 12-15 during the runs. | S3 | `tools/bench-stream.ts --seconds 20` | readability / flora / furniture | ✘ watch: re-measure on a quiet machine before chasing; nothing over budget |
| 6 | After a teleport or a **load**, the first 1-3 s show the far ground ring (a flat pale plane) where near chunks will be, with grass cards already standing on it (`03_street` in the playthrough; bottom-left of the after-load shot). Only visible when the world appears at once, not while walking or driving. | S3 | F5, reload, `l` Enter; look at the ground | readability (far ground) / chunk streaming | ✘ open: e.g. hold the load screen until the near ring is meshed, or hide grass cards on unbuilt chunks |
| 7 | Ceiling lamps paint **hard concentric rings** on shelter walls and ceiling (toon form lighting + palette grade on a point light) — the brightest thing in the first room the player sees (`02_shelter_first_view.jpg`). Style call, but it reads as banding rather than a lamp. | S3 | new game, look at the shelter's back wall | readability | ✘ open (try `form=soft` / smooth grading on point-light falloff only) |
| 8 | The Discovery tip card appears at the screen's far left edge on the very first frame of play, then moves in to the 16:9 HUD column (compare `02_shelter_first_view` with later shots). | S4 | quick start at 3440x1304 | UI / progression | ✔ adaptation round 7: the toast slide-in animation, not the column: its first stepped frame was translated -110% of the card, which on ultrawide lands at the screen edge. Now a short slide + fade (`ui2.css`). |
| 9 | realinput timing flakes on slow pages (Firefox llvmpipe, headful 3440): `inv` (Nearby row not yet listed → TypeError), `menus` "E: a message says why" (1.2 s), `getin` prompt (0.4 s). All pass on rerun. | S4 (test) | Firefox or `--size 3440x1304` | QA | ◐ `d49ad15`: `inv` waits for the row (and fails with a message, not a TypeError); the other two left as is |
| 10 | Wielded baseball bat (3D hands, default) is held upright across the centre of the view at rest; at 21:9 it covers a lot of the crosshair's surroundings (`12_variants_default.jpg`). | S3 | wield a bat, stand still | characters | ✘ opinion for the owner (CHARACTERS.md round 4 already calls held weapons the weak spot) |
| 11 | Console warnings on every start: `[cdda-data] unknown itemgroup id` (camera_pro, UPS_off, v29, laser_rifle, plasma, plasma_gun, recipe_atomic_battery), `unknown monstergroup id "GROUP_ZOMBIE_HORDE"`, `monsterView: no sprite for mon_zombie_nurse`. No page errors anywhere. | S4 | any load | data extraction | ✘ pre-existing |
| 12 | Set dressing has no Options entry (only `?dressing=off` / `cdda.setDressing`). | S4 | Options | furniture | — by design per FURNITURE.md; mention only because the brief listed it with the switches |

Things checked and fine: the Options screen (every row after `f75aba3`, every wave-3 switch present
and cycling: Creatures, First-person hands, Furniture, Surfaces, Trees, Vehicle look, Vehicle
width, Distance haze, Draw distance, Form lighting, Aim model, Aim trail, Title screen, Title
logo, Activity progress, Route guide, Rest menus, Tips, Map, Climate, Weather messages, Crafting
list, …); each alternate variant renders without errors or holes in the same street
(`12_variants_default` vs `13_variants_all_alternates`: sprites, 2D hands, voxel furniture,
tileset surfaces, clump trees, part-block cars, heavy haze, soft light). First-person hands never
clipped walls, doors or car interiors in these runs. The quick start, looting, the first fight on
the default aim model (killed in ~10 s, 16 clicks), driving with run-overs, the flashlight and the
forest all worked by real input in Chromium and Firefox. The sun setting around 18:00 on spring
day 1 while the weather is mid-spring is deliberate (the climate runs 45 days ahead, the calendar
doesn't: `weather.ts`).

## Performance (RTX 5080, shared machine, load average 12-17)

Standing still, 3440x1304, `full` look, headless Chromium (`look-shots --gpu --bench` for the
first two columns, the same scenes in a `drive.ts --gpu` session with the HUD visible for the rest).
`render` = renderer-only ms/frame (`cdda.benchRender`); LOOKS.md/READABILITY.md had 3440x1304
full street 2.5-3.4 ms, forest 1.6-2.1 ms before wave 3.

| view | interval p50 / p99 ms | render ms | tris | draw calls | HUD visible: interval p50 / work p50 / render |
|---|---|---|---|---|---|
| shelter | 13.7 / 32.6 | 2.2 | 2.69 M | 496 | 16.7 / 17.3 / 6.8 |
| town street | 14.2 / 33.8 | 2.1 | 0.55 M | 442 | 16.7 / 5.7 / 2.4 |
| house interior | 14.9 / 32.3 | 4.1 | 0.83 M | 609 | 16.7 / 5.8 / 2.8 |
| forest | 13.9 / 30.3 | 2.3 | 0.73 M | 339 | 16.7 / 14.6 / 2.4 |
| night, flashlight | | | 0.98 M | 677 | 16.7 / 15.9 / 3.2 |

The GPU is never the limit (2-4 ms at 3440x1304, 7 ms worst in the shelter's 2.6 M triangles,
mostly the grass around it). Hiding HUD layers one by one changed nothing measurable.

Streaming (`tools/bench-stream.ts`, 20 s runs, main-loop ms):

| run | work p50 / p99 | loop p50 / p99 / max | interval p50 / p95 | frames > 33 ms |
|---|---|---|---|---|
| 1080p sprint 7 t/s, full | 5.9 / 15.5 | 5.1 / 13.0 / 17.7 | 16.7 / 16.7 | 1 / 1200 |
| 1080p drive 40 mph, full | 9.6 / 24.4 | 7.8 / 14.4 / 19.2 | 16.7 / 16.8 | 15 / 1185 |
| 3440x1304 sprint, full | 14.6 / 28.4 | 5.9 / 13.6 / 19.1 | 16.7 / 33.4 | 213 / 988 |
| 3440x1304 forest sprint, full | 9.0 / 25.8 | 5.3 / 12.2 / 21.9 | 16.7 / 33.3 | 109 / 1092 |
| 3440x1304 drive 40 mph, full | 19.5 / 31.4 | 9.5 / 17.4 / 21.1 | 16.7 / 33.4 | 304 / 897 |
| 3440x1304 drive 40 mph, **classic** | 8.1 / 42.0 | 4.2 / 30.3 / 65.9 | 16.7 / 33.4 | 179 / 958 |

At 3440x1304 the 33 ms intervals come with `wait` (GPU/present) as the largest section and
happen in `classic` too: headless Chromium presenting the big canvas, as LOOKS.md already noted.
The game's own loop stays at p99 12-17 ms in `full`.

Headful (real window under Xvfb, `qa-playthrough.ts`): Chromium GPU ~12 fps, Firefox (llvmpipe,
software) 7-10 fps with render 80-135 ms; neither is representative of the user's desktop, but
both ran every step without an error.

## Screenshots (`docs/screenshots/wave3/qa/`, half-size JPEG of 3440x1304)

| file | what |
|---|---|
| `01_title.jpg` | title screen (big buttons) at 21:9 |
| `02_shelter_first_view.jpg` | first frame in the shelter: 3D hands, lamp rings (#7), tip at the far left (#8) |
| `03_house_room.jpg` | a house room: modelled furniture, painted surfaces, set dressing |
| `04_house_area_loot.jpg` | `g` area loot on a cupboard and rack |
| `05_zombie_fight.jpg` | first fight, default free aim, HEAD ×1.5 readout |
| `06_driving_dusk.jpg` | chase cam at 36 mph through zombies at dusk, modelled cars |
| `07_night_flashlight.jpg` | 23:13, flashlight on a corpse pile |
| `08_forest_before_fix.jpg` / `09_forest_after_fix.jpg` | the yellow "crates" (#2) and without them |
| `dandelion_before.jpg` / `dandelion_after.jpg` | f_dandelion next to dahlia, bluebell, chamomile, poppy |
| `10_firefox_house_room.jpg`, `11_firefox_driving.jpg` | the same scenes in Firefox |
| `12_variants_default.jpg` / `13_variants_all_alternates.jpg` | default look vs every wave-3 switch on its alternate |

## Commits on this branch

- `755a12c` Options: one Draw distance entry (#1) — `src/ui/options.ts`, `src/render/lookInstall.ts`
- `403cef9` Furniture sprites look up the season (#2) — `src/render/voxel.ts`, `src/render/chunkMesh.ts` (hot file, +2 lines)
- `1ec1cc8` QA tools: `tools/qa-playthrough.ts`, `tools/realinput_qa.ts` (`options`), firstfight setup (#3)
- `d49ad15` realinput `inv` waits for its row (#9)
