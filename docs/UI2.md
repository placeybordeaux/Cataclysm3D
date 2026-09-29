# ui2: the mouse-first pixel UI toolkit

`src/ui2/` is the UI foundation for v2 (docs/DESIGN_V2.md, "Modern game UI"): windows, drag &
drop, context menus, tooltips, toasts, hotbar, paper doll — plain TypeScript + DOM, no framework
(screens are small, the bundle stays lean, Vite hot reload stays instant). The legacy curses UI in
`src/ui/` still runs everything else; screens move over one at a time.

- **Try it:** `npm run dev`, open `/?debug=ui2` (showcase with mock items), or press **Tab** in the
  game (the same placeholder inventory, labelled "UI2 PREVIEW: mock items").
- **Import from `src/ui2/index.ts`** only.
- **Tests:** `tests/ui2.test.ts` (layout math, scale, palette contrast, drop validation, stack
  splitting, toast rate limiting, item conservation over 4000 random moves).
  Real input: `tools/realinput.ts --only ui2`; interactive: `tools/drive.ts serve --headful` with
  `xmoveto` / `xmdown` / `xmup` for drags (see its header).

Screenshots: `docs/screenshots/ui2/`.

## Interaction rules (every screen follows these)

| Input | Meaning |
|---|---|
| Left-click | Select (in lists/grids); on the world: the object's primary action |
| Double-click / Enter | Use: the obvious action (eat, wear, wield, open) — the menu entry marked `primary` |
| Drag | Move to wherever you release: a container, a slot, the hotbar (binds), the world (drops) |
| Mouse wheel while dragging | Change the amount (Ctrl: by 1) |
| Shift + drag (at start or drop) | Ask for the exact amount |
| Shift-click | Quick move (ground → your bag, carried → ground) |
| Ctrl-click | Split the stack (amount prompt) |
| Right-click | Context menu: every action with its time cost; impossible ones stay visible, greyed, with the reason ("Need: a screwdriver") |
| Hover | Tooltip after 350 ms; neighbours show instantly while scanning |
| Esc | Closes the topmost thing: menu → dialog → drag → window group |
| Right-click while dragging / Esc | Cancel the drag |
| Menu key / Shift+F10 | Context menu for the keyboard-selected item |
| Tab | Toggle the inventory (game action `inventory2`) |
| 1…0 | Hotbar slots (while the inventory is open; game binding TBD) |
| `o` (game action `world_menu`) | Context menu for what the crosshair points at, while the mouse is captured |

Keyboard is an accelerator, never the only way: every action is reachable by mouse. Menus take
arrows / Enter / → ← / letters; grids and lists take arrows / Home / End / Enter.

### Mouse capture, pause and the world

- **Opening any ui2 surface frees the cursor on purpose** (window, context menu, dialog). ui2
  releases pointer lock as an *expected* unlock (`input.releaseForMenu()`), so `src/ui/pointer.ts`
  neither pauses nor shows "click to resume". ui2 owns the keyboard (`input.capture(..., {
  timeFlows: true })`). **Closing the last surface re-captures the mouse** inside the closing
  click/key. Exception, by browser rule: Esc is not a "user activation" key, so closing the last
  window *with Esc* (outside F11 fullscreen) leaves the usual resume hint; Tab, a click on ×, or
  Enter re-capture directly.
- **Time**: ui2 captures don't pause the game by themselves. Inventory-type windows open with
  `pauses: true` and add the `'menus'` tactical-pause hold (src/game/pause.ts) while
  `settings.pauseInInventory` is on. The difficulty preset sets it (Options > Difficulty > Pause in
  menus: Accessible on, Classic off; docs/BALANCE.md). The player's own pause key (`` ` ``) works
  inside ui2 too. While ui2 is open the survivor doesn't walk either way.
- **World while the cursor is free**: the object under the cursor gets a 3D pixel outline (a
  `LineSegments` box in `renderer.scene`, so it goes through the post pass and looks like the
  world) plus its name next to the cursor. Right-click → `worldMenu(target)`; left-click → its
  `primary` entry. Dragging an item onto the 3D view drops it on the ground.
- **World while captured**: RMB is guard/aim (combat), Space side-steps. `e` keeps doing the
  default interaction immediately; the context menu for the crosshair target is the separate
  action `world_menu` (default `o`, rebindable). A hold-`e` variant was rejected: it would have to
  delay every `e` press to tell tap from hold.

Contributing world actions (any system, no coordination needed):

```ts
import { worldContextProviders } from './ui2';
worldContextProviders.push((t) => t.furniture === 'f_locker'
  ? [{ label: 'Open', time: 2, primary: true, action: () => openLocker(t.x, t.y, t.z) },
     { label: 'Pry open', time: 45, disabled: 'Need: a prying tool (prying 1)' }]
  : []);
```

`t` is a `WorldTarget` `{kind, name, x, y, z, terrain?, furniture?, creature?, dist?, hit?}`
(`hit` = the tile `RayHit`). Entries from different providers are separated; "Look at" is built in.

## Visual rules

- **Pixel art stays pixel art.** Borders, bevels, wells and icons are integer multiples of the
  *UI pixel* `--u`; icons are UltiCa 32 px sprites × an integer (`--icon`, `--row-icon`), drawn
  with nearest filtering. Everything is snapped to *device* pixels, so browser zoom / desktop
  scaling (dpr 1.04 under Xvfb) stays crisp.
- **Scale:** auto 1×/2×/3× by viewport (height decides, width only lowers it): 960×540 → 1×,
  1920×1080 → 2×, 3440×1304 → 2×, 3840×2160 → 3×. Options > "UI scale" overrides. Text uses
  Terminus at a ladder of sizes (`--fs` 16/22/32, `--fs-s` 12/16/24, `--fs-l` 16/24/36) — a vector
  font doesn't need to snap, and 2×16 px text would waste half the screen.
- **Palette:** colours come from the renderer's grading palette (`src/render/grading.ts`) via
  `logic/palette.ts` → CSS vars `--p-bg`, `--p-text`, `--p-accent` (lamplight ochre: titles, focus,
  selection), `--p-good` / `--p-warn` / `--p-bad` (text-safe) / `--p-danger` (bars, outlines only),
  `--p-info`, `--p-magic` (discovery). Contrast is unit-tested (text ≥ 7:1, dim ≥ 4.5:1).
- **Skins:** procedural 9-slice images (`theme.ts SKINS`): `panel`, `inset` (+ `-hover`, `-sel`,
  `-ok`, `-partial`, `-bad`), `btn` (+ `-hover`, `-down`, `-off`), `tip`, `menu`, `bar`. Use them as
  `border: var(--b3) solid transparent; border-image: var(--skin-panel)`. Add a skin by adding a
  `SkinSpec` (ring colours from the outside in).
- **States:** hover = lighter fill + accent ring; pressed = inverted bevel, 1 u down; selected =
  accent ring; disabled = flat, dim text, reason in the tooltip; drop ok/partial/bad = green /
  amber / red ring with the reason on the drag ghost.
- **Motion** uses `steps()` so things move in whole pixels (toasts slide in, shakes, presses).
- Only `#ui2 …` selectors in `ui2.css`; the legacy `#ui` is untouched.

## How to build a screen

1. **Adapt the data**: implement `InventoryModel` (`src/ui2/model.ts`) over the game's items.
   Convert each game item to an `ItemView` (`logic/items.ts`: id, typeId, name, count, weight/volume
   per unit, condition 0..1, charges, badges, covers, stats, capacity, contents). Locations are
   opaque strings you define (`'ground'`, `'worn:torso'`, `'in:<itemId>'`). `check()` must be pure and
   cheap (it runs on every pointer move during a drag); put the rules in `ContainerRules` and call
   `checkDrop()` (`logic/dnd.ts`) so reasons read the same everywhere. `move()` does the real
   thing and must **conserve items** — property-test it like `tests/ui2.test.ts` does for the mock.
2. **Compose**: `containerPanel(model, loc, {id, group, pauses})` for a container window,
   `containerView` + `capacityBars` + `sectionLabel` for several containers in one window,
   `paperDollView(model, slots)` for equipment, a `Hotbar`. Give every window of the screen the
   same `group` so Esc closes the screen; give inventory-type windows `pauses: true`.
3. **Actions**: `model.actions(item, loc)` returns `MenuItem[]`: `{label, time?, key?, primary?,
   disabled?: reason, danger?, submenu?, action}`. Keep impossible actions in the list with the
   reason. Mark the double-click action `primary`. Destructive ones: `danger` + `confirmModal`.
4. **Feedback**: `toast()` for things the player should notice (rate-limited; don't bypass it),
   `flashNote(x, y, text)` for "why that didn't work" at the pointer, `startProgress()` for timed
   actions (anchor it over the thing being worked on).
5. `src/ui2/mock/` (store, model, data, setup) + `inventory_screen.ts` are the reference: the
   inventory agent can start by replacing `MockInventoryModel` with a real adapter.

## Component API (all from `src/ui2/index.ts`)

**Setup** — `installTheme(root)`, `setHost(host)` (the game does both in `installUi2`; a standalone
page uses `standaloneHost()`). `acquireSurface({pauses})` → release fn, for anything custom that
should free the cursor. `pushKeys(fn, {overlay})` → remove fn (topmost first; `overlay` for
keyboard-modal things so focused lists don't eat their keys; widgets check `overlayOpen()`).
`shortcut(key, fn)` for global ui2 keys. `settings` / `saveSettings()`.

**Windows** — `openPanel({id, title, icon?, width?, height?, x?, y?, group?, pauses?, closable?,
titleExtras?, footer?, onKey?, onClose?}) → Panel {el, body, setTitle, setFooter, front, moveTo(x,
y, remember?), close}`. Draggable by the title bar, click brings to front, position remembered per
`id` (localStorage `cdda3d.ui2.win`), clamped so the title bar stays reachable. Opening an open `id`
focuses it. `closeGroup(group?)`, `findPanel(id)`, `openPanels()`, `resetWindowPositions()`.
Sizes: use the metric vars, e.g. `'calc(var(--cell) * 6 + var(--gap) * 5 + var(--u) * 18)'`.

**Widgets** — `button(label, onClick, {icon, tone, disabled: reason, small, key})`,
`tabs(defs, active, onChange) → {el, set}`, `scrollList({items, render, onActivate, onSelect}) →
{el, setItems, selected, select}`, `capacityBar(label, fmt) → {el, set(used, max)}` (warn ≥ 80 %,
striped overflow past 100 %), `progressBar(tone) → {el, set(v, label)}`.

**Items** — `itemCell(item, 'grid' | 'row')` (icon, count, condition bar, charge bar, badges,
"holds items" marker), `emptySlot(label)`, `iconEl(iconRef, 'grid' | 'row')` (atlas sprite →
looks_like → glyph; `setLooksLike(fn)` supplies the chain). `itemTooltip(item, {compare, where,
hints, sections})` builds the rich card (▲▼ against `compare` using `ItemStat.better`).

**Drag & drop** — `registerDropTarget({el, id, check(p, n) → DropVerdict, drop(p, n, verdict),
label?(p)})` → unregister; the innermost target under the pointer wins (a bag's cell beats the
list it's in). `makeDraggable(el, {payload() → {item, count, from, meta?}, onClick, onDoubleClick,
onContext, onDropNowhere})`. Verdicts (`logic/dnd.ts`): `ok`, `partial` (only n fit — the rest stays),
`swap` (single slot: the old item goes back to the source), `reject` (reason), `noop`.
`locationTarget(model, loc, el, verb)` and `wireItemCell(model, loc, item, cell)` do this for
models. Helpers: `checkDrop`, `fitCount`, `splitCounts` (throws on nonsense), `canMerge`,
`defaultSplit`, `wheelCount`.

**Menus** — `openContextMenu({x, y}, items, {title?, onClose?}) → close`. `MenuItem` = entry |
`{separator: true}` | `{header}`. Submenus open on hover (140 ms) or →; placement flips at screen
edges (`placePopup`).

**Tooltips** — `attachTooltip(el, () => HTMLElement | string | null)`; `suppressTooltips()` →
undo; `hideTooltip()`.

**Toasts** — `toast({category: 'discovery' | 'achievement' | 'warning' | 'info', title, body?, icon?,
key?})`. At most 3 visible; repeats fold ("×4"); per-category minimum gap (discovery 4 s) and
duration; queue of 6, least important dropped first (`TOAST_RULES` in `logic/toasts.ts`).

**Dialogs** — `confirmModal({title, body, ok, cancel, danger, icon}) → Promise<boolean>` (danger:
Y confirms, Enter doesn't). `countPrompt({title, subtitle, max, initial, icon, ok}) →
Promise<number | null>` (slider, field, 1 / Half / All, wheel, arrows, PgUp/PgDn).
`textPrompt({title, label, initial, placeholder, ok}) → Promise<string | null>` (one-line field: map notes).

**Progress** — `startProgress({label, seconds?, anchor?: () => {x, y} | null, hint?, onDone?}) →
{set(frac, right?), finish(), cancel()}`.

**Hotbar** — `new Hotbar({storageKey, resolve(typeId) → ItemView | null, use(binding, item, slot),
tooltip?}).mount()`; `bind(i, item)`, `handleKey(e)`, `refresh()`. Binds item *types*; shows how
many you carry; drag between slots to swap, drag off to unbind.

**Paper doll** — `paperDollView(model, slots: {id, label, loc, col, row, verb?}[])`; `col/row` are
in cell units (fractions allowed).

**World** — `worldContextProviders`, `worldMenu(target)`, `WorldTarget` (above). In the game
(`src/ui2/install.ts`): `targetFromHit(game, rayHit)`, `worldHoverListeners` (told when the object under
the free cursor changes; the look card uses it).

**Pause** — `openPanel({pauses: 'always'})` / `acquireSurface({pauses: 'always'})` stop game time whatever
"Pause in inventory" says (Esc menu, options, help, look); `pauses: true` follows the setting.

**Layout math** (`logic/layout.ts`, pure) — `clampRect`, `placePopup`, `arrangeRow` (a screen's
windows side by side, wrapping), `cascade`, `gridColumns`, `paperDollLayout`.

## Automation

- Game: `cdda.ui2.state()` (panels, surfaces, tacticalPause, lock, toasts, hovered object, open
  menus), `cdda.ui2.toggleInventory()`, `cdda.ui2.rect(sel)`, `cdda.ui2.textRect(text)` (centre of a
  button / menu row, for `xclick`), `cdda.ui2.mock()`.
- Showcase: `cdda.ui2.{state, rect, textRect, itemRect(typeId), model, hotbar}`.

## Not done yet / for the next agents

- Real inventory (BN item model) — replace `MockInventoryModel`; the Tab key and hotbar are
  ready for it. Game-wide hotbar keys (1…0 outside the inventory) aren't bound yet.
- A hold-to-free-cursor mode (e.g. hold Alt) for pointing at the world without opening a window.
- Pixel outline in the post pass instead of the line box (the box is cheap and reads well).
- Terminus is the only font; no bold (synthetic bold smears pixel fonts) — use colour.
- Gamepad: out of scope (keyboard + mouse only, per the brief).
