# UX review: input, mouse capture and screens (2026-09-29)

Scope: a first-time player who knows a bit of CDDA and plays FPS games. Everything a player
does was exercised with **real OS-level input**: a windowed Chromium on a private Xvfb display,
keys and mouse sent through xdotool (`tools/lib/realinput.ts`). `cdda.*` was used only for
setup (giving items, teleporting, killing the character) and for reading state.

Why that matters: puppeteer's `page.keyboard` is trusted by the page but bypasses the
browser's own shortcut handling, so its Escape never released pointer lock. Measured here:
with the pointer locked, a real Esc is **not delivered to the page at all** (only
`pointerlockchange`), Esc is not a user-activation key (it can't re-lock), and Chrome refuses
a re-lock for ~1.25 s after an Esc unlock ("cannot be acquired immediately after the user has
exited the lock"). In fullscreen with `navigator.keyboard.lock(['Escape'])` Esc *is*
delivered and the lock survives; holding Esc ~2 s leaves fullscreen.

How to repeat: `nix-shell --run '~/claude-stuff/bin/heavy --mem 2.5 -- npx tsx tools/realinput.ts'`
(161 checks, 14 scenarios, `--shots dir`, `--size 1920x1080`, `--only a,b`), or interactively
`tools/drive.ts serve --headful --params "seed=1&realinput=1"` + `xkey`/`xmove`/`xclick`/`state`.
`?realinput=1` turns the pointer policy on under automation (it is off when `navigator.webdriver`).

Last run: 161/161 at 960×540; title/menus/rebind/death also at 1920×1080.

Severity: **S1** blocks or loses progress · **S2** confusing / wrong · **S3** polish.

## Input model

| # | Issue | Sev | Status | Fix |
|---|---|---|---|---|
| 1 | CapsLock on turned `i` into `I` (nothing) and `e` into `E` (eat) — every letter command changed meaning | S1 | fixed | `keymap.normalizeKey` undoes CapsLock for letters before bindings and menu hotkeys see the key |
| 2 | AZERTY: movement is physical (ZQSD, fine) but `z` wield and `q` drop sit on physical W/A, so they were unreachable; help said "WASD" | S2 | fixed | layout learned from `getLayoutMap()` or the first movement press; stand-ins `w` wield / `a` drop (the free QWERTY-position letters); help, hints, overmap and vehicle legends name ZQSD; one-time message if an action has no usable key (e.g. Dvorak's `e`) |
| 3 | AltGr characters (`@ [ \|` on DE/FR layouts) arrive as Ctrl+Alt on Windows and were dropped as shortcuts | S2 | fixed | AltGraph modifier state is honoured |
| 4 | Non-Latin layouts (Russian…) had no letter commands | S3 | fixed | letter from `e.code` when `e.key` is a non-Latin letter |
| 5 | Held keys re-fired: holding `i` flickered the inventory open/shut; a letter held while a menu opened also picked in the new menu (inventory `a` → item menu `a`ctivate) | S2 | fixed | repeats never fire actions, close windows or pick menu entries (they still scroll) |
| 6 | Stuck keys: `held` was cleared when a menu opened; releases were fine but a key still held after closing a menu was forgotten | S3 | fixed | keys tracked through menus (gameplay ignores them while captured); blur/hidden clears keys *and* mouse buttons; tested "release W inside a menu → not walking" |
| 7 | Mouse buttons held when a menu opened or the lock was lost could keep swinging | S3 | fixed | cleared on capture and lock loss |
| 8 | Shift+W / Shift+A/S/D / Space opened nothing in all states tested | — | verified | (fixed in ad1ee99; now also enforced for rebinding) |
| 9 | Ctrl+W (FPS players hold Ctrl) or Ctrl+R closed/reloaded the tab without warning | S1 | fixed | "Leave site?" guard while a game runs (`src/core/unload.ts`); deliberate reloads (quit, load, death) bypass it |
| 10 | No way to rebind keys | S2 | fixed | Options > Key bindings: Enter rebinds, `+` adds, `-` unbinds, `R` resets; refuses movement keys (by code *and* layout character), Esc/Bksp/Enter/Tab/arrows, browser shortcuts; a key taken from another action asks first; persisted as a diff in localStorage; `menu` stays on Esc |
| 11 | Messages/hints hard-coded keys ("Press $", "Press ?", "[W/S]") | S3 | fixed | `<keybind:id>` in `game.message()`, `keys.label()`, `keys.movementKeys()`; grep found no other hard-coded key letters in prompts (HUD prompts already used `keyFor`) |
| 12 | `j`/`k` scroll lists except where they are hotkeys (wait menu `k` = until dusk) | S3 | kept | CDDA behaviour; documented in help ("j k where they are not hotkeys"); arrows always work |
| 13 | Dead keys (`^` on FR/DE) can't trigger vehicle controls | S3 | not fixed | rebind in Options; detected layouts don't report dead keys |

## Mouse capture lifecycle

| # | Issue | Sev | Status | Fix |
|---|---|---|---|---|
| 14 | Esc inside a menu: menu closed but the mouse was dead until a *click* (only a click re-locked) | S1 | fixed | any key resumes mouse-look; a key pressed inside Chrome's 1.25 s cooldown is retried when it ends (transient activation lasts ~5 s). "Paused — click or press a key to resume", plus how to avoid it (F11) |
| 15 | Lock loss closed the top window outright, skipping its own Esc behaviour (dialogue "leave", chargen "back a tab", crafting "leave group") | S2 | fixed | lock loss replays Esc into the top window's handler |
| 16 | Alt-tab / switching tabs closed the open menu (lock loss treated as Esc) | S2 | fixed | `lockLostAction` checks focus a moment later: focus loss only pauses (unit-tested state machine in `pointer.ts`) |
| 17 | Pause menu under a resting cursor: the entry under the cursor stole the highlight, so Enter opened **Help** instead of Resume | S2 | fixed | hover needs real mouse motion (`movementX/Y`) in menus, title screen and dialogue |
| 18 | A click on the paused view could attack | S2 | verified fixed | a click without the lock only resumes |
| 18b | …regressed: closing a menu with Esc asked for the lock inside the Esc key; Chrome refused (cooldown) and the retry grabbed the mouse 1.3 s later by itself, so the click meant to resume swung (whiffs print nothing, so the old log-based check missed it) | S2 | fixed | `Input.tryLock` never retries a request made inside an Esc keydown (tests/input.test.ts); realinput checks for a `playerAttack` event, not a log line |
| 19 | No fullscreen; outside it every Esc costs the mouse | S2 | fixed | F11 / Options > Fullscreen: Fullscreen API + `keyboard.lock(['Escape'])`; Esc opens/closes menus with the lock kept; holding Esc leaves (menu opens once, repeats ignored) |
| 20 | Menus are keyboard-only while captured; FPS players may expect a cursor | S3 | option | Options > Menu cursor = `free`: menus release the lock for pointing/clicking, closing the last one re-captures. Default stays `captured` (the ad1ee99 design). Both tested |
| 21 | Clicks reached windows *under* the top one (a second click on the inventory opened a second item menu) | S2 | fixed | only the top window takes pointer events |
| 22 | Look mode (`x`) ignored the mouse (menus freeze mouse-look) | S2 | fixed | windows can opt into mouse-look (`mouseLook: true`) |
| 23 | Death with a menu open left it over the tombstone; dying at the wheel left the dashboard on it | S2 | fixed | windows close before the death screen; dashboard hides when dead |
| 24 | Death screen: last words needed a click first; a held W would have typed "wwww" | S3 | fixed | input focused after the fade, key repeats ignored |
| 25 | Window resize | — | not driven | windows are sized in vw/vh/ch and centred; checked at 960×540 and 1920×1080 but not resized live |

## Screens

All of `i z O T E u R & * ( @ m P ? ) p [ _ M x q \| $ C` were opened and closed with their own
key with the mouse staying captured, footers checked for the close legend, and window bounds
checked at 960×540 (`B` with no corpse prints a message instead — every key gives a window or a message). Also by hand: title, chargen, hints, pause menu, Options, Key bindings,
dialogue, trade, vehicle controls, death, Load menu.

| # | Issue | Sev | Status | Fix |
|---|---|---|---|---|
| 26 | `&` didn't close crafting (its key handler swallowed every key) | S2 | fixed | unhandled keys fall through |
| 27 | Same for `*` construction — and Backspace/Esc-with-filter; it trapped the old test harness | S2 | fixed | same |
| 28 | Hints popup ignored Esc and Backspace (swallowed every key) though its footer said Esc | S1 | fixed | only Enter/Space/d/arrows handled |
| 29 | Footers said "Esc close" everywhere (and nothing on several screens) | S3 | fixed | framework appends the real legend, e.g. `i/Esc/Bksp close`, `C`-opened dialogue shows `Esc/Bksp leave` (its letters answer) |
| 30 | Chargen: new players didn't know how to start (only `F` on the last tab); Backspace discarded the whole character without asking | S1 | fixed | `F finish & play` from any tab, clickable tabs, Bksp = Esc (back a tab), leaving to the menu asks and warns |
| 31 | Destructive confirms took Enter as yes (quit without saving, delete save, surgery, attack a neutral) | S2 | fixed | `confirm(q, {destructive: true})`: y only; all confirms have clickable Yes/No |
| 32 | Item action menu used CDDA letters (`W` wear, `a` activate) that differ from the game keys (`O`, `u`) | S3 | fixed | uses the bound keys (falls back to CDDA's letter if unbound) |
| 33 | Multi-select (pickup/drop): Backspace only edited the count | S3 | fixed | closes when no count is being typed |
| 34 | Overmap WASD scrolled by letter (wrong on AZERTY) | S3 | fixed | physical keys; hjkl by letter |
| 35 | Character sheet overflows at 960×540 (body panel, skills) with no way to scroll by keyboard | S3 | fixed | unhandled ↑↓/PgUp/PgDn scroll any window body; footer says so |
| 36 | Hints overflowed 960×540 | S3 | fixed | shortened; checked by realinput |
| 37 | Crafting list showed "%s in jar" / "%s from shotgun" | S3 | fixed | `recipeName` fills `%s` with the result (test) |
| 38 | Activity bar didn't say how to stop | S3 | fixed | "(move to stop)" |
| 39 | Vehicle controls menu uses CDDA letters (`s` engine) while the in-game key is `k` | S3 | not fixed | CDDA-faithful inside the menu; the dashboard lists the in-game keys |
| 40 | Tip of the day can mention CDDA features this port lacks ("the action menu") | S3 | not fixed | tips come from CDDA's data; needs a curated filter |
| 41 | Window text is a fixed 16 px (HUD scales with height): small but readable at 1920×1080 | S3 | not fixed | a `--ui-size` scale option would need every screen re-checked at 540 p |
| 42 | Trade window's right pane shows a horizontal scrollbar at 960×540 | S3 | not fixed | cosmetic |
| 43 | "Nothing to eat/apply" feedback goes only to the message log (bottom-left) | S3 | kept | CDDA-style; confirmed every key gives a message |
| 44 | Clock shows 00:00 at the start of a new game | S3 | not investigated | outside the input/UI scope |

## Onboarding (first 3 minutes)

Title → click New Game → `F` → `y` `y` → the confirming key press captures the mouse → Hints:
where the gear is (`e` on lockers), WASD/mouse/Shift/crouch, LMB/wield/inventory/craft, noise,
first weapon, how menus close and what Esc does, `?` for all keys and rebinding. All key names
come from the live bindings and layout. The in-world prompt under the crosshair (`[e] Look in
the locker`) uses the bound key. The `?` help's first topic lists movement, mouse, menu keys,
the Esc/fullscreen behaviour and every action (unbound ones in red).

## Please re-check by hand

1. **Esc in a normal (non-fullscreen) window on your desktop Chrome**: Esc in a menu closes it
   and shows the resume hint; pressing W right away should resume mouse-look about a second
   later without a click. The cooldown behaviour was measured on Chromium under Xvfb.
2. **F11 on a real desktop**: here F11 reached the page and the game's fullscreen +
   keyboard lock worked. On a desktop Chrome with a window manager, check that the browser
   doesn't *also* toggle its own F11 fullscreen (if it does, use Options > Fullscreen).
3. **Firefox**: no keyboard lock (Esc leaves fullscreen) and no `getLayoutMap` (layout is
   learned from the first movement press). Pointer lock + Esc delivery differ; not tested.
4. **Real AZERTY / Dvorak keyboards** (tested with `setxkbmap fr`).
5. **Ctrl+W** mid-game should now ask "Leave site?" (verified via reload; the tab-close path
   wasn't driven, to avoid closing the test browser).
6. **Options > Menu cursor = free**: whether it feels better than the default for you.
