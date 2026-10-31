# Cataclysm3D v2 — "Bright Nights for a new audience"

Branch `bn` (v1 is tagged `v1-dda` on master). This document is the brief for every agent in
the second push. ARCHITECTURE.md still describes the code; this describes where it's going.

## Goal

Bring what makes Cataclysm special — a dense, systemic, simulated post-apocalypse where
everything is a real object, every building is lootable, and survival emerges from many
interacting systems — to players who bounce off the tiles/curses presentation. We keep the
depth and the world, and we change the *interface* and the *on-ramp*.

## Decisions (from the product owner)

1. **Content & mechanics track Cataclysm: Bright Nights** (`~/code/Cataclysm-BN`, read-only,
   refresh with `git -C ~/code/Cataclysm-BN pull`). BN is the design authority wherever it
   differs from DDA; DDA-only systems (pockets, proficiencies, vitamin-driven mutagen, …) go.
   BN ships UltiCa compiled for its own ids in `gfx/UltimateCataclysm`.
2. **Modern game UI.** Mouse-first: drag & drop between inventory, containers, equipment
   slots and the ground; right-click context menus on items and world objects; tooltips;
   hotbar; toasts. Keep the pixel-art/palette identity (it's a look, not curses). Keyboard
   shortcuts remain as accelerators. No more letter-hotkey lists as the primary interface.
3. **Accessible by default, hardcore available.** Difficulty presets: *Accessible* (default:
   gentler early spawns, forgiving needs, clear warnings), *Classic* (BN numbers adapted only
   where real time breaks them), *Custom*. A **tactical pause** is always available.
4. **Browser, keyboard + mouse** only.
5. **First person** stays the default camera (third-person/top-down one key away).
6. **Progression & discovery instead of an up-front character creator.** First launch drops
   you straight into a quick start (named Evacuee with a sensible kit). Achievements unlock
   new starts/scenarios/professions and eventually the full custom creator. Unlocks persist
   across deaths but are **sidegrades only** — no run is stronger because of a previous run.
   In-run discovery: "new recipe available" when you pick up the last missing component,
   first-time explanations of mechanics as you meet them, a survival journal. Rate-limited,
   never naggy. A "Classic" toggle unlocks everything for veterans.

## Quality bar (lessons from v1)

- **Real input only** for anything a player does (see `tools/realinput.ts`, `tools/drive.ts
  --headful`). Debug helpers only for setup. v1 shipped Shift+W opening the wear menu and Esc
  killing mouse-look because QA drove the game through `cdda.*`.
- **Invariants over anecdotes**: item conservation (no duplication/loss across any move,
  unload, drop, craft, trade, save/load) must be property-tested. v1 duplicated items when
  unloading a bag.
- **Feel is a feature**: combat must read clearly in first person (telegraphed enemy attacks,
  unmistakable hit/miss, weight, recovery). Inventory must be understandable at a glance
  (where is this item: hands, worn, which container, ground?).
- A human is playtesting live via the dev bridge (`tsx tools/live.ts state|shot|eval`) — keep
  `npm run dev` hot reload working and never break the running game for long.

## Pillars for UX

- **Everything is an object you can see and touch**: items on the ground/in furniture are
  visible and clickable in the world; containers open into panels; drag between panels.
- **Show, don't list**: equipment paper-doll with slots by body part; containers as panels
  with capacity bars; weight/volume as bars, not numbers only; encumbrance visualised.
- **Context over modes**: right-click anything (world or UI) for what you can do with it,
  with the time it will take. The action you probably want is the default left-click.
- **Time is visible**: actions show progress bars in-world; tactical pause freezes time while
  you manage inventory (Accessible default: inventory pauses; Classic: time flows).
- **Never lose the player**: clear feedback for every action, including why something can't
  be done and what's missing ("Need: a cutting tool (level 1)").
