# The inventory model

How items live in CDDA-3D v2: Cataclysm: Bright Nights' item and carrying rules
(docs/BN_DATA_MODEL.md §3–§4 has the data side), one API for every change of place, and the
tests that prove nothing is ever duplicated or lost.

| file | what |
| --- | --- |
| `src/game/item.ts` | `Item`: one BN item, its charges and what it holds; creation (`createItem`, `fromSpawned`, `inNewContainer`, `loadAmmo`) |
| `src/game/moves.ts` | locations (`Loc`, `L.*`), `moveItem`, `spawnItem`, `consumeItem`, `unloadItem`, `transaction`, `census` |
| `src/game/inventory.ts` | `character.inv`: capacity, encumbrance, armor, and the BN actions (pick up, drop, wield, wear, take off, eat, use, reload, unload) built on moves |
| `src/game/inventory_view.ts` | UI-free data for inventory screens: `inventoryView`, keys, `verdict`, `itemActions` |
| `tests/conservation.test.ts` | the property test; `tests/v1_regressions.test.ts`, `tests/moves_lint.test.ts` |

## Items (BN item.cpp)

An `Item` is an `ItemDef` plus state:

- `charges`: the stack size of a *count_by_charges* item (ammo, every comestible, liquids,
  `stackable` things), or the rounds in a gun/tool's **integral magazine**, with `ammoId` (BN
  `curammo`) naming the ammo type. A revolver, a shotgun tube and a lighter hold charges; they
  have no ammo item inside.
- `contents`: what it holds. A **container** (`container_data`) holds one load of one type
  ("You can't mix loads"): a stack of charges, or a few identical items up to its volume. A
  **holster** holds up to `multi` items it accepts (`holster_actor::can_holster`); a
  **bandolier** or **magazine** one stack of rounds. Item groups can put anything anywhere
  (BN `put_in`), and old saves keep what they had, so `contents` is a list.
- `magazine`: the detachable magazine inserted into a gun or tool (a slot of its own, so "what
  is loaded" is never ambiguous). Speedloaders and stripper clips are not magazines for the
  slot: their rounds are loose ammo to the gun they refill.
- `gunmods`.

Weight and volume follow `item::weight` / `item::volume`: a stack is `ceil(volume × charges /
stack_size)`; a soft (non-rigid) item grows by what it holds; an inserted magazine adds only
what sticks out past `magazine_well`; guns add their mods. A container that `preserves`
keeps its contents from rotting; one with `unseals_into` (a can) becomes that item as soon as
its contents change.

## Where an item is

Every item is in exactly one place (`Loc`):

| `L.hands(c)` | the wielded item |
| --- | --- |
| `L.worn(c)` | clothes, sorted by BN layer (innermost first) |
| `L.inv(c)` | the carried inventory: a flat list (BN `inv`), not inside the clothes |
| `L.in(item)` | a container's / holster's / bandolier's / magazine's contents, or the rounds of an integral magazine |
| `L.mag(item)` | a gun's or tool's magazine slot |
| `L.mod(item)` | a gun's installed mods |
| `L.ground(map, x, y, z)` | a map tile (storage furniture is the tile; its `max_volume` limits it) |
| `L.cargo(part, vehicle)` | a vehicle CARGO part (its `size` limits it) |
| `L.stock(npc)` | a shopkeeper's goods |

There is no `item.location` field to keep in sync: the place is the list the item is in, and
every API that moves an item takes the place it is *from*. `locate(item, scope)` and
`character.inv.locOf(item)` find it when you don't know.

### Carrying (BN character.cpp)

- **Volume**: worn items with `storage` (backpacks, jeans, vests) pool into one carrying volume
  (× mutation `packmule_modifier`, + `CARRY_STORAGE`). The inventory's volume must fit it.
  Worn and wielded items don't count. A backpack itself holds nothing.
- **Weight**: 13 kg + 4 kg × Str, × mutation `weight_capacity_modifier`, + `CARRY_WEIGHT`, ×
  every worn item's `weight_capacity_modifier`, + worn `weight_capacity_bonus`. Everything
  carried counts (worn, wielded, inventory). Over 1× you are overburdened; nothing may be
  picked up past 4×.
- **Liquids** need a watertight container. Carried, it must seal. A *bucket* (watertight, can't
  seal: pots, buckets) holds liquid only on the ground or in your hands, and a bucket with
  liquid can't go into the inventory. A soft container you carry can only grow into your free
  carrying volume.
- **Encumbrance** (item::get_encumber, Character::item_encumb): a portion's encumbrance; a worn
  soft storage item grows toward `max_encumbrance` with its share of the carried volume; BN
  layering penalty per layer (every piece but the most encumbering one, 2..10 each; COMPACT and
  fitted light items exempt).

## Moving things: `moveItem`

```ts
moveItem(item, from: Loc | null, to: Loc, opts?: {
  count?,      // charges of a stack to move (default: all)
  partial?,    // move what fits instead of failing (pouring, loading rounds, picking up part)
  actor?,      // whose rules, capacity and messages
  quiet?, dryRun?,
  force?,      // system moves (a mutation pushes clothes off): skip unwield/take-off rules and capacity
}): { ok, msg, moves, code?, moved, item? }
```

1. `item` must really be at `from` — else `code: 'stale'`, "The X is no longer there." (a UI
   list older than the world can't clone anything). `from = null` means *new* (use
   `spawnItem`); passing something that is already carried throws.
2. Rules for leaving `from` (NO_UNWIELD / bionic weapons, INTEGRATED / NO_TAKEOFF clothes,
   removable gunmods) and for arriving at `to` (can wield / can wear, liquids, container load and
   room, holster, bandolier/magazine ammo type and room, magazine fits, gunmod compatible,
   storage furniture and cargo volume). Refusals carry BN's wording and a `WhyNot` code.
3. Exactly the moved quantity is detached (a stack split) and attached (merged into an
   identical stack, into a container's load, or into an integral magazine's charges), with an
   undo log. Then the carried volume/weight of everyone involved is checked; a move that made
   them worse past the limits is undone.
4. The result says what happened, BN's move cost (`item_handling_cost`, wear cost, 250 to take
   off, 100 to pick up / drop, holster `draw_cost`) and the item as it now is.

`canMove` is the dry run (same rules, nothing changes). `transaction(fn)` makes several moves
all-or-nothing (the wield swap, reload's magazine swap, a trade). `unloadItem(host, [to…])` empties
a container / holster / bandolier, ejects a magazine, or turns an integral magazine's charges back
into rounds; each thing goes to the first destination that takes it. Liquids are left in their
container and reported for the liquid menu.

Quantity appears only through **`spawnItem` / `spawnOnGround` / `spawnSome`** (item groups,
crafting results, harvests, loot, debug) and disappears only through **`consumeItem`**
(eating, crafting components, keycards, fire, butchered corpses) and `Item.ammoConsume`
(firing, tools using charges). A crafting job holds its components between consume and
finish (they are given back, i.e. spawned again, if it's cancelled).

### The character's actions

`character.inv.pickUp(item, from, count?)`, `drop(item, to?, count?)`, `wield(item, from?)`,
`unwield()`, `wear(item, from?)`, `takeOff(item)`, `consume(item, from?)`, `use(item, bp?, i,
from?)`, `reload(item)`, `unload(item)`, `stashNew(newItem)`, `giveNew(newItem)`. `from`
defaults to wherever the item is on the character; pass `null` for a new item. They return
`{ ok, msg, moves, code? }` and message the character. What they do, BN-style:

- **pick up**: into the inventory; if it doesn't fit and your hands are free, into your hands.
- **wield**: the old weapon goes to the inventory, else is dropped; drawing from a worn holster
  costs its `draw_cost`.
- **take off**: into the inventory if it still fits without the item's own storage, else into
  your hands, else dropped.
- **eat/drink**: one portion out of the stack or the container; drinks quench by `quench`.
- **reload**: a magazine-fed gun takes the fullest compatible magazine you carry (an empty one
  gets filled from loose rounds first) and the old one goes back; integral magazines,
  magazines and bandoliers load loose rounds (and speedloaders' rounds).
- **unload**: into the inventory, else at your feet; liquids go to the liquid menu.

## Invariants and how they are enforced

1. *Every item is in exactly one place*: the only code that edits item lists is moves.ts
   (TypeScript: `Inventory` exposes read-only lists and `Item` read-only slots;
   `tests/moves_lint.test.ts` fails on raw slot access, direct map item edits and hand-edited
   cargo/stock lists anywhere else).
2. *Nothing is duplicated or lost*: `census(locs)` counts quantity per type (charges-aware,
   integral rounds counted as their ammo, an opened can as the can it was) and lists any item
   object reachable twice. `tests/conservation.test.ts` builds a world of two survivors, ground
   tiles (one a locker), a vehicle trunk and a shop from real BN items and runs thousands of
   seeded random operations — raw moves between any two places (valid or not), pick up, drop,
   wield, wear, take off, unload bags/containers/guns/magazines onto the ground and into the
   inventory, reload, eat, operations on stale locations, transactions that fail halfway, dry
   runs, save/load round trips — checking after each that the census is unchanged except for the
   portion eaten, nothing is aliased, no empty stack is left. `CONSERVATION_SEEDS=2000
   CONSERVATION_STEPS=300 npx vitest run tests/conservation.test.ts` is the long soak.
3. *A failed action changes nothing*: every failure path undoes exactly (the property test
   compares the whole world's JSON before and after a failing transaction and a dry run).

## Why v1 duplicated items

Found by fuzzing the `v1-dda` build (census over the survivor and the map after every UI action)
and replayed in `tests/v1_regressions.test.ts` and the trade test in `tests/npcs.test.ts`:

- **Nothing checked that an item was where the UI said.** `Inventory.wield/wear/pickUp` called
  `this.remove(it)` (a silent `false` when the item wasn't in the inventory) and attached the item
  anyway; for ground entries the UI removed it from the map *afterwards*, again ignoring failure.
  Any entry that was no longer true — the `i` list after an unload whose liquid menu was answered
  later, a pick-up list after something moved — put the same object in two places, and saving
  wrote it twice. The fuzzer produced it within a few dozen actions once lists could be stale.
- **The wielded bag was listed twice.** `carriedEntries` listed "everything in the pockets of the
  wielded and worn items" as the inventory *and* the wielded item's contents under WIELDED. Pick up
  a bag with no backpack on (it goes to your hands) and every item in it appears twice — most
  likely what the playtester saw around unloading a bag (the exact session wasn't recorded);
  acting on the lines of a list that an unload had just made stale then hit the bug above.
- **Trade sold a wielded bag's contents twice** (the bag and, separately, each thing in it: the
  second detach silently failed), and **vehicle "put items" pushed an item into the trunk even when
  dropping it failed**.

The new model can't do any of these: moves verify the source, the inventory is a flat list with
contents nested once, trade moves inside a transaction from explicit places.

## For the UI (`src/game/inventory_view.ts`)

The v2 inventory screens (`src/ui2/bn/model.ts` is the ui2 `InventoryModel` adapter; docs/UI2.md
"The inventory screens") sit on these calls:

- **Data**: `inventoryView(scope)` with `scope = { who, map, at?, reach?, cargo?, stock? }`
  returns `hands`, `worn` (layer, storage capacity and its share of what's carried), `bodyParts`
  (encumbrance, warmth, what covers each part), `carried` grouped by category, `nearby` places
  (ground tiles by direction, storage furniture with a fill bar, cargo, a shop) and `totals`
  (volume, weight, 4× limit). Each `ItemNode` has `key`, `loc`, `locKey`, name, count, weight,
  volume, charges bar, condition, badges (W, E, rotten, sealed…), `covers`, and `inside` (a place
  with its fill: ml for containers, rounds for magazines/bandoliers, items for holsters) and
  `magazine` (the slot).
- **Keys**: ui2 locations are strings: `locKey(loc, scope)` ("hands", "worn", "inv",
  "in:<itemKey>", "mag:…", "mod:…", "ground:x,y,z", "cargo:<n>", "stock") and
  `resolveLocKey(key, scope)`; items by `itemKey(item)` / `findItemLoc(key, scope)`.
- **Drag hover**: `verdict(who, item, from, to, count)` → `{kind: 'ok'|'partial'|'reject'|'noop',
  count, moves, reason}` — the ui2 `DropVerdict` shape, from a dry run of the real move.
- **Drop**: `moveItem(item, from, to, { count, actor: who, partial: true })` — or, for body places,
  the character actions (wield/wear/take off do BN's swaps and costs).
- **Right-click**: `itemActions(who, item, loc)` → `{id, label, moves, disabled?, primary?,
  run()}` (eat/drink, wear, take off, wield / put away, activate, reload, unload/empty, pick up,
  drop), greyed with the BN reason. `primary` is the double-click action.
- **Time**: `moves` are BN moves (100 = one second of game time at normal speed).
- **Liquids**: `inv.unload(item)` returns `liquids`; open the liquid menu for them
  (`src/ui/liquid_ui.ts openLiquidMenu(host, liquid, { from: L.in(container) })` shows the choices;
  `liquidTargets`, `pourInto`, `drinkLiquid`, `pourOnGround` in src/game/liquid.ts are UI-free).
- **Staleness**: after any change re-read the view (or check `stillAt(node)`); a stale drop fails
  with `code: 'stale'` rather than doing anything.
