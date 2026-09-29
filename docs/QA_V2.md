# QA v2: a newcomer's playthrough (2026-09-29)

Scope: CDDA-3D v2 (branch `bn`) played as someone who has never touched Cataclysm, on the
Accessible preset, with parts on Classic. Everything the player did went through **real OS
input** (xdotool into a windowed browser on Xvfb: `tools/drive.ts serve --headful --gpu`,
`tools/realinput.ts`). `cdda.*` was used only for setup (a long stick, a car on a road, the
hour, a zombie to fight) and to read state. Chromium on the real GPU at 1920×1080 for the
playthrough; the real-input suite at 960×540 and 1920×1080; the quit and core flows also
in **Firefox** (the human's browser).

Status: ✔ fixed here (with a test or a real-input check) · ✘ not fixed (owner named) · ◐
partly.

## How to repeat

```
nix-shell --run '~/claude-stuff/bin/heavy --kind gpu --mem 2.5 -- npx tsx tools/realinput.ts --gpu'
nix-shell --run '~/claude-stuff/bin/heavy --kind gpu --mem 2.5 -- npx tsx tools/realinput.ts --gpu --size 1920x1080'
nix-shell --run '~/claude-stuff/bin/heavy --mem 2.5 -- npx tsx tools/realinput.ts --browser firefox --hmr --only title,esc,ui2,inv,save,quit'
```

New in `tools/realinput.ts`: `--browser firefox` (WebDriver BiDi; window fitted with
xdotool), `--hmr` (the dev server as `npm run dev` runs it, so the dev-only hot-reload
snapshot/resume code is live), `--gpu` (Chromium on the RTX through ANGLE/Vulkan; needs
`heavy --kind gpu`), `--params` (extra URL parameters, e.g. `look=classic`), and the `quit`
scenario.

**Why `--gpu` matters now:** the new default "full" look renders at 1–3 fps under
SwiftShader on this (shared, loaded) machine. Time-based checks (walk 700 ms and see you
moved, game time runs with the inventory open) then fail for reasons that have nothing to do
with the game. Run the suite on the GPU, or with `--params look=classic` under SwiftShader.

## Results (final runs, this branch)

| Run | Result |
|---|---|
| `npm run typecheck`, `npm test` (vitest) | green: 936 passed, 24 skipped |
| `npm run build` | green |
| realinput, Chromium on the GPU, 960×540, all 33 scenarios | **315/315** (was 294/302 at the start: 4 inventory checks, the hotbar drag, newgame) |
| realinput, Chromium on the GPU, 1920×1080, all scenarios | **315/315** |
| realinput, Firefox + HMR, 960×540: title, move, esc, keys, focus, ui2, inv, invbag, invloot, invkeys, save, quit | **92/92** (2 failures before the Firefox fix below) |

Firefox under WebDriver BiDi was practical: pointer lock, real Esc, drag & drop and the
"Leave site?" prompt all behave under xdotool, so the suite runs there as-is (not the
`fullscreen`/`azerty` scenarios, untried in Firefox).


## Human reports (verify they stay fixed)

| Report | Status | Evidence |
|---|---|---|
| Shift+W opened Wear | ✔ stays fixed | realinput `move`: Shift+W runs, no menu |
| Esc killed mouse-look | ✔ stays fixed | realinput `esc` (7 checks) in Chromium; `esc` in Firefox |
| Unload-bag duplication | ✔ stays fixed | realinput `invbag` census; unit property tests |
| Confusing inventory | ◐ | 960×540 layout fixed (below); Take-all summary fixed; see "Inventory" |
| Combat felt off | ◐ | readable (telegraph, grab bar, stamina, hit messages); see "Combat" |
| Driving camera / acceleration | ◐ | chase camera and speed feel fine at 20 mph; headlights weak (visual) |
| Couldn't run over NPCs | ✔ stays fixed | ran over zombies and a zombie dog; they're flung and hurt |
| Couldn't exit driving | ✔ **improved** | `e` now also climbs out through the nearest door when stopped (it only let go of the wheel, leaving you inside a closed car) |
| "Take the controls" only on the seat | ✔ stays fixed | `^` from beside the car opens the door and seats you |
| Hot reload lost the game | ✔ stays fixed | realinput `quit --hmr`: touching `src/main.ts` reloads the page and resumes the same survivor (Chromium and Firefox) |
| "Quit to main menu doesn't work" | ✔ **could not reproduce; likely cause fixed** | Quit reaches the title in Chromium and Firefox, with and without HMR, after walking, driving, a load, a hot reload and after death (`quit`, `death`). What *does* fail: the confirm dialog gave the **Quit** button the focus ring, so it looked like Enter's target, but Enter is (deliberately) never "yes" in a destructive dialog, and **nothing happened**. Cancel now takes the focus; Enter shows "Press Y or click Quit to confirm" and shakes the button (realinput `quit`: "Q then Enter … says how to confirm"). |

## Issues found

### Inventory

| # | Issue | Sev | Status | Fix / owner |
|---|---|---|---|---|
| 1 | At 960×540 (1× scale) Equipment + Inventory + Nearby were wider than the screen; Nearby wrapped onto a second row **over the hotbar and the bottom of the Inventory list** | S1 | ✔ | widths shrink with the viewport (unchanged ≥ 1080p), narrow lists drop the volume column (container query), every window ends above the hotbar and its list scrolls |
| 2 | 4 real-input inventory checks failed only in the full run (ui2 right-click menu, ui2 Classic shift-click bar, invbag "pipes on the bag row", invloot Take all message; also invkeys' hotbar drag grabbed the wrong item) | S2 | ✔ | the state that leaked was the **inventory filling up** over earlier scenarios: the item under test ended up at the bottom of the Inventory list, underneath the Nearby window (#1), so clicks hit Nearby. Fixed by #1; all pass in the full run |
| 3 | Take all: "Left emergency jacket: no room in your inventory" ×9 (a cupboard of single jackets), repeated in a toast that ran off the screen; "Took 7 folded emergency blanket" | S2 | ✔ | one line per kind and reason, plural totals |
| 4 | Take all is greedy in list order: 7 blankets (4 kg, 3.5 L) filled a 6.5 L inventory before the jackets | S3 | ✘ inventory | sort by value/volume, or ask "take what fits?" with a preview |
| 5 | Hotbar is pre-bound (slots 1–4) to tiny unlabeled icons; nothing says what they are until you hover with the inventory open | S3 | ✘ inventory | name under each bound slot, or a first-time tip |

### World interaction and HUD

| # | Issue | Sev | Status | Fix / owner |
|---|---|---|---|---|
| 6 | `e` at a cupboard three steps away: "There is nothing to examine there" — reads as "this can't be used" | S2 | ✔ | "The cupboard is out of reach: step closer"; the crosshair shows "Look in the cupboard (step closer)" |
| 7 | "Spotted zombie--safe mode is on!" (CDDA; there is no safe mode here) | S2 | ✔ | "You spot a zombie to the northwest!" |
| 8 | Opening a picker (`z`) with the crosshair on furniture popped that furniture's look card (and outline) over the hotbar before the mouse moved | S3 | ✔ | world hover needs real mouse motion, ignoring the unlock's cursor jump |
| 9 | Look card said a cupboard was "Easy to walk on" | S3 | ✔ | furniture's move cost counts |
| 10 | Progress box wrapped "Crafting long pointy / stick" and "16 / s" | S3 | ✔ | sized to its label |
| 11 | "You hear thump! ×21" while nothing visible happens (zombies bashing somewhere) | S3 | ✘ HUD/sound | direction ("thump! to the north"), or fold unseen repeats |
| 12 | Map: half a town is CDDA letters (M + F n g ^) and the legend explained only six sprites | S2 | ✔ | a second legend lists the letters in view with their names |
| 13 | Death screen said "your last save is kept" for a survivor that was never saved | S2 | ✔ | says so only when a save exists, otherwise how saving works |
| 14 | "Bloated" and "Famished" shown at once (seen after a test setup; reachable by eating a lot while starving) — accurate in BN, confusing on a HUD | S3 | ✘ HUD | one line ("Starving, just ate too much") or explain in the tooltip |

### Crafting

| # | Issue | Sev | Status | Fix / owner |
|---|---|---|---|---|
| 15 | Searching "spear" with a long stick and a knife found only uncraftable recipes; the starter spear is called "long pointy stick" | S2 | ✔ | plain search also matches descriptions, name matches first (unit test) |

### Vehicles

| # | Issue | Sev | Status | Fix / owner |
|---|---|---|---|---|
| 16 | `e` ("get out" on the driving HUD) only let go of the controls: you sat in a closed car and walked into its walls | S1 | ✔ | stopped: opens the nearest door and puts you on free ground (unit test) |
| 17 | A car stopped dead against a bicycle lying on the road, throttle held, 0 mph | S2 | ✔ | vehicles under ⅕ of your mass are shoved aside (then ahead), damaged, your speed shared (unit test) |
| 18 | Taking the controls is `^` (Shift+6): odd for newcomers; `e` on a car examines it | S3 | ✘ vehicles | `e` on the driver's door/seat could take the controls |
| 19 | Running zombies over at ~20 mph flings them but rarely kills: the memorial said "Kills 0 … You were a pacifist" after ramming six | S3 | ✘ balance | BN-faithful numbers; consider a kill credit/feedback for heavy hits |

### Visuals (for the render owner)

| # | Issue | Sev | Status |
|---|---|---|---|
| 20 | Headlights at night light a small spot ~15 m ahead; the road right in front of the car stays black | S2 | ✔ road reads ~35 m ahead (screenshots/polish/drive_*) |
| 21 | Title screen: the ASCII logo is dim blue on a dark backdrop, and the Start window covers it (its top row peeks out) | S3 | ✘ UI |
| 22 | Weather "Snowstorm 2 °C" on a green spring day 1 — the sky shows a few flakes but the scene reads as a mild morning | S3 | ✘ weather/render |
| 23 | Sky: large flat angular cloud slabs with hard edges in the full look | S3 | ✔ sin-hash discontinuities; soft dithered fbm clouds (screenshots/polish/sky_*) |
| 24 | A zombie at arm's length draws with its head below the crosshair (the sprite sits low); newcomers aim at the head and "swing wildly and miss" | S3 | ✔ face on the crosshair inside 1.3 m (monsterView meleeAimLift; screenshots/polish/zombie_*) |
| 25 | A large green "Z" sprite floated beside the road near the start (a sign/graffiti billboard?) | S3 | ✔ a camo zombie soldier without UltiCa art: 72 such monsters get stand-in sprites (screenshots/polish/proxy_after.png) |

### Combat (Accessible)

The first fight (long pointy stick vs one zombie) took ~20 s: 5 hits of 11–12, about as many
misses, grabbed four times (mash `e`, the bar shows the progress), bitten twice through the
jacket. Telegraph + grab bar + stamina bar + messages make it readable; it still feels long
and "swing wildly and miss" twice in a row with no visual reason is the most confusing part.

### Found by the new harness options

| # | Issue | Sev | Status | Fix |
|---|---|---|---|---|
| 26 | **Firefox, `npm run dev`: Ctrl+R mid-game resumed the run instead of reaching the title.** Firefox closes the dev-server socket on every unload and Vite reports it as a disconnect, which took the hot-reload snapshot meant for dev-server restarts. Chromium doesn't report it, which is why it never showed up before | S2 (dev) | ✔ | disconnects while the page is leaving are ignored (realinput `save` in Firefox + `--hmr`) |
| 27 | Under SwiftShader the default "full" look runs at 1–3 fps on this machine and time-based real-input checks fail (walking, clocks) | — | ✔ harness | `--gpu`; or `--params look=classic` |
| 28 | `newgame`'s "fresh profile" setup re-unlocked the Security Guard from the running page's in-memory achievements | — | ✔ harness | wipe storage directly, again on pagehide |
| 29 | The death screen "Kills 0 · You were a pacifist" after a car had rammed six zombies (none died) | S3 | ✘ | see #19 |


## Assessment for the new-audience goal

### The first ten minutes

1. **Title → Start → Enter** puts you in the shelter within seconds, with a name, a body and a
   difficulty on one card. Good. The title's ASCII logo is hard to read and the menu row
   (`[Start] [New Game] [Load]…`) is the one place that still looks like a terminal.
2. **The shelter**: the first tip says what to do (`e` on lockers, `g`, `i`). The voxel
   cupboards read as furniture, but nothing marks them as lootable until you're within
   1.5 m; a newcomer pressing `e` from across the room used to be told "nothing to examine"
   (fixed). The three-window inventory is clear at 1080p: where each item is (hands, worn,
   which bag, the cupboard) is always visible, drag & drop works, Take all explains itself
   (now in one line per kind).
3. **Crafting**: the "You could craft" nudge and the `&` badge are the right idea; the search
   now finds the starter spear by what it is.
4. **The first zombie**: the telegraph, grab bar ("mash e"), stamina bar and hit messages
   make it readable, and it's tense. It is long (~20 s, as many misses as hits, four grabs)
   for a first fight on Accessible, and misses have no visible cause.
5. **Outside / the car**: gorgeous at dawn in the full look; the compass with hostile pips and
   "You spot a zombie to the northwest!" orient you. Driving is fun once moving: chase camera,
   speedometer, running zombies over. Getting in (`^`) and out (`e`, now truly out) are the
   rough edges; the night drive is too dark to see where you're going.

### Readability

- **Strong**: the HUD (paper-doll health figure, needs icons with tooltips, compass, clock,
  weather), the inventory windows, toasts, the map with notes/destination, the death screen.
- **Weak**: CDDA vocabulary still leaks (safe mode — fixed; "You hear thump! ×21" with no
  direction; tip-of-the-day lines about features that don't exist here), unlabeled hotbar
  icons, map letters (legend now), and "swing wildly and miss".

### Fun

The loop — loot a cupboard, craft a pointy stick, stab a zombie, find a car, plough through a
street — is already fun and very "Cataclysm". Tension comes from grabs and bites, not from
UI. The biggest risk to a new audience is not complexity but **dead moments**: pressing a key
and nothing visible happening (Enter in a confirm, `e` too far away, a car against a bike,
sitting in a closed car). Most of those were fixed here; the remaining ones are below.

### Top 10 next improvements

1. **Combat feedback on a miss**: show *why* (a dodge animation, "it ducks", the swing arc
   passing beside it); aim assist toward the torso at arm's length (zombie sprites sit low).
   Owner: combat feel.
2. **Shorter first fight on Accessible**: fewer grabs in the first in-game hour, or a
   weaker first zombie; the grab loop is the moment most likely to lose a newcomer.
   Owner: balance.
3. **Headlights that light the road** in front of the car (cone and range). Owner: render.
4. **`e` gets you into a car** from beside the driver's door (keep `^` for the panel).
   Owner: vehicles.
5. **Directional sound messages** ("thump! to the north", fold unseen repeats) and an
   on-screen sound indicator. Owner: HUD/audio.
6. **Mark lootable furniture at a distance**: a subtle highlight or "(17 items)" when the
   crosshair rests on a container within ~4 m. Owner: world interaction.
7. **Hotbar labels** for bound slots and a first-time tip explaining the pre-bound items.
   Owner: inventory.
8. **Curate tip-of-the-day** to features this port has; drop CDDA-isms from messages
   (a message style pass). Owner: UX.
9. **Title screen**: a proper logo image and big buttons instead of the terminal menu row;
   keep letters as accelerators. Owner: UI.
10. **Take all that thinks**: prefer what fits and what's valuable (food, weapons, bags)
    over 4 kg of blankets, and offer "wear it" for clothing. Owner: inventory.

