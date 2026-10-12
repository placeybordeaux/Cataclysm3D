# Activity minigames: crafting, construction, disassembly (TODO)

Follow-ups to the reading minigame (`docs/ADAPTATION.md` "Reading: field notes"). Same
contract as reading: **optional**, ignoring it costs nothing, a good result saves time
(and gives practice), it pauses under fast-forward and ends when the activity is
interrupted, and every variant sits behind an Options row + URL param with `off` = plain BN.

Direction from the user (2026-10-01): these should be **toys first, not quizzes**. The
reading cards lean on teaching the game; for these, the feel of doing the job is the point.

## Construction: optional timing strip implemented

A rhythm/timing game while a construction runs. Leading idea: marks appear on the
half-built tile in the world (nail heads, stakes, the line to saw along) and you hit them
on the beat with the crosshair, reusing the free-aim system. Beats could follow the
construction's tool qualities (hammering, digging, sawing each get their own pattern),
which is data we already have per construction (`src/game/construction.ts`).

Open: in-world marks vs. a HUD strip (cheaper, and it works in third person); how much
time a perfect run saves; how it scales with construction skill (a wider window?).

## Crafting: Minecraft-style assembly — TODO, mock first

The recipe's ingredients sit in a pile and you drag them into their places on an
assembly layout. Ghost outlines show where each part goes, and they fill in by themselves
over the craft's duration, so dragging is a speed-up, never required.

This is a lot of work (a layout per recipe, or a generator that makes one from a recipe's
components and tools), so **build a throwaway mock before committing to it**: a
standalone page with 3–4 hand-picked recipes, to feel the drag/ghost loop and decide:

- generated layouts (grid like Minecraft, or a loose "exploded view" diagram) vs. a few
  hand-made templates per recipe category (clothing, weapons, electronics, food…)
- what to do with alternatives (any of rag / cotton patch …): accept any of them in the slot
- tools: a slot of their own, or just "in reach"
- batch crafts and very long crafts (tailoring, hours of game time)

## Disassembly: calm teardown implementation; alternatives remain exploratory

Disassembly is an order-of-operations problem, so puzzles where the order of
removing things is the challenge fit best. Candidates (to mock and compare):

| Genre | Example | How it maps to disassembly |
|---|---|---|
| Sliding-block "unjam" | Rush Hour / Traffic Jam | Parts block each other inside the casing; slide them aside to get the one you want out |
| Screw/pin order | "Screw Jam", pin-pull puzzles | Plates held by screws; pull screws in an order that frees plates without jamming |
| Burr / interlocking | Wooden burr puzzles | Literally a take-apart puzzle: find the one piece that moves first |
| Pick-up sticks / Jenga | Mikado | Remove a part without disturbing the stack around it |
| Careful cutting | Hardspace: Shipbreaker | Cut at the right seams; hitting a battery/fuel line ruins that part |
| Steady hand | Operation | Lift the part out without touching the edges |
| Untangle | Planarity | Unhook wiring before you can lift a board out |
| Repair/teardown toy | Assemble with Care | Open, look at, take out, in a calm handmade way |

Generation: the pieces are the item's real disassembly products (its `uncraft`
components), so the puzzle shows what you'll get. The layout and blocking come from a
generator that makes solvable puzzles, with difficulty scaled by item complexity and
the player's skill.

Open: whether a mistake can cost anything (a damaged part, Shipbreaker style). That
would be a balance change from BN, so it needs a switch and a default of "no cost".

## Current prototypes (2026-10-04)

[Careful-hands toys](../ACTIVITY_TOYS.md) implements an optional construction timing
strip and generated calm teardown. The ordinary work runs without input, and both
have an off setting. The guide distinguishes passing controller/input evidence from
browser verification that remains pending. Other proposed disassembly genres are
still design alternatives, not implemented modes.

The standalone crafting assembly mock is `/activity-assembly-mock.html` (served from
`public/`). It loads four real recipes: bandages, primitive knife, flashlight and fish
sandwich. Alternatives share a slot, tools stay in reach, and ingredients auto-fill
without interaction. Compare generated grid and exploded-view spacing; batch sizes
1/3/10 and 20-second/two-minute work exercise longer sessions. Drag/drop and click-then-
slot support pointer and keyboard use. Restart, pause, cancel and off are explicit.
The standalone mock never changes game items/saves. Its assessment selected the generated grid as the default for live optional assembly.
Its JS syntax, real drag/keyboard controls, inspected layouts, pause and automatic off
completion pass verification. Final player feel assessment remains open.
The assessed design is now integrated through the optional crafting assembly controller and card. Actual committed alternatives, ordinary ignored/Off work, per-batch bonus ledgers, explicit hand pace and save/cancel behavior are documented in [CRAFT_ASSEMBLY.md](../CRAFT_ASSEMBLY.md). Bespoke item-specific exploded models remain a later art task.
