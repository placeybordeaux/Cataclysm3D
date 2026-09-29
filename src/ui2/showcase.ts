// ?debug=ui2 — every ui2 component with mock items (real names, stats and UltiCa icons from
// public/data/items.json), for trying the feel directly under `npm run dev` hot reload:
// drag between backpack / pockets / hands / ground / the world, right-click items and world
// objects, hover for tooltips, fire toasts, try modals, switch the UI scale.
//
// The "world" is a 2D pixel backdrop drawn from the atlas; its objects answer right-clicks
// through the same worldContextProviders API the 3D game uses.

import { loadAtlas, type Atlas } from '../render/atlas';
import { DATA_BASE } from '../core/assets';
import { h, ui2Layers } from './dom';
import { installTheme, palette, currentMetrics, onScaleChange, scalePref, setScalePref } from './theme';
import { setHost, shortcut, standaloneHost, settings, saveSettings, surfacesOpen } from './host';
import { iconsReady, iconEl } from './icons';
import { findPanel, openPanel, openPanels, resetWindowPositions, closeGroup } from './window';
import { button, capacityBar, progressBar, scrollList, tabs } from './widgets';
import { itemCell, emptySlot } from './itemcell';
import { attachTooltip, itemTooltip } from './tooltip';
import { toast, toastState } from './toast';
import { confirmModal, countPrompt } from './modal';
import { startProgress } from './progress';
import { openContextMenu } from './menu';
import { HOTBAR_KEYS } from './hotbar';
import { worldContextProviders, worldMenu, type WorldTarget } from './world';
import { INVENTORY_GROUP, openInventoryScreen, toggleInventoryScreen } from './inventory_screen';
import { setupMockInventory } from './mock/setup';
import { mockItem, type RawItems } from './mock/data';
import type { ItemView } from './logic/items';
import type { UiScalePref } from './logic/scale';

interface WorldObject {
  name: string;
  kind: WorldTarget['kind'];
  id: string;
  /** Tile rect on the backdrop grid. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function runUi2Showcase(canvas: HTMLCanvasElement): Promise<void> {
  const L = ui2Layers();
  installTheme(L.root);
  setHost(standaloneHost());
  const res = await fetch(`${DATA_BASE}items.json`);
  if (!res.ok) throw new Error(`items.json: HTTP ${res.status}`);
  const raw = (await res.json()) as RawItems;
  await iconsReady();
  const atlas = await loadAtlas();

  const world = drawWorld(canvas, atlas);
  const { model, hotbar } = setupMockInventory(raw, 'cdda3d.ui2.hotbar.showcase');
  hotbar.mount();
  for (const k of HOTBAR_KEYS) shortcut(k, (e) => hotbar.handleKey(e));
  const invOpts = { worldEl: canvas };
  shortcut('Tab', () => toggleInventoryScreen(model, invOpts));
  shortcut('i', () => toggleInventoryScreen(model, invOpts));

  installWorldMenus(canvas, world);
  openControls(model, invOpts, raw);
  openInventoryScreen(model, invOpts);
  toast({ category: 'info', title: 'UI2 showcase', body: 'Drag items, right-click things, hover for details. Tab toggles the inventory.' });

  // Automation (tools/drive.ts): where things are, what's open.
  (window as unknown as { cdda: unknown }).cdda = {
    ready: true,
    ui2: {
      model,
      hotbar,
      rect(sel: string) {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
      },
      /** Centre of the cell showing an item type inside a location's panel/section. */
      itemRect(typeId: string, within = 'body') {
        const found = [...document.querySelectorAll<HTMLElement>(`${within} .ui2-cell[data-item]`)].find((c) => model.store.find(c.dataset.item!)?.item.typeId === typeId);
        if (!found) return null;
        const r = found.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      },
      state: () => ({
        panels: openPanels().map((p) => p.id),
        surfaces: surfacesOpen(),
        toasts: toastState(),
        scale: currentMetrics().scale,
        totals: Object.fromEntries(model.store.totals()),
        where: (typeId: string) => {
          const out: string[] = [];
          model.store.walk((it, loc) => it.typeId === typeId && out.push(`${loc}:${it.count}`));
          return out;
        },
        menu: [...document.querySelectorAll('.ui2-menu')].map((m) => [...m.querySelectorAll('.ui2-menu-row')].map((r) => r.textContent)),
        tip: (document.querySelector('.ui2-tip') as HTMLElement | null)?.style.display === 'none' ? null : document.querySelector('.ui2-tip')?.textContent ?? null,
        modal: document.querySelector('.ui2-dialog-title')?.textContent ?? null,
      }),
    },
  };
}

// --- controls ---------------------------------------------------------------------------------

function openControls(model: Parameters<typeof openInventoryScreen>[0], invOpts: Parameters<typeof openInventoryScreen>[1], raw: RawItems): void {
  const p = openPanel({ id: 'showcase.controls', title: 'UI2 showcase', x: 8, y: 8, closable: false, width: 'calc(var(--fs) * 17)' });
  const scaleRow = h('div', { class: 'sc-row' });
  const drawScale = () =>
    scaleRow.replaceChildren(
      h('span', { class: 'ui2-dim', text: 'Scale' }),
      ...(['auto', 1, 2, 3] as UiScalePref[]).map((s) =>
        button(s === 'auto' ? `Auto (${currentMetrics().scale}×)` : `${s}×`, () => (setScalePref(s), drawScale()), { small: true, tone: scalePref() === s ? 'accent' : undefined }),
      ),
    );
  drawScale();
  onScaleChange(drawScale);
  const pause = h('label', { class: 'sc-check' }, h('input', { attrs: { type: 'checkbox' } }), h('span', { text: 'Tactical pause in inventory' }));
  const box = pause.querySelector('input')!;
  box.checked = settings.pauseInInventory;
  box.addEventListener('change', () => ((settings.pauseInInventory = box.checked), saveSettings()));
  p.body.append(
    scaleRow,
    h('div', { class: 'sc-row' }, button('Inventory', () => toggleInventoryScreen(model, invOpts), { key: 'Tab' }), button('Style guide', () => openStyleGuide(raw)), button('Reset layout', () => {
      resetWindowPositions();
      closeGroup(INVENTORY_GROUP);
      openInventoryScreen(model, invOpts);
    })),
    pause,
    h('div', { class: 'ui2-section', text: 'Toasts' }),
    h(
      'div',
      { class: 'sc-row wrap' },
      button('Discovery', () => toast({ category: 'discovery', title: 'New recipe: makeshift splint', body: 'You have all the parts.', icon: { typeId: 'bandages' } }), { small: true }),
      button('Achievement', () => toast({ category: 'achievement', title: 'Survived the first night', icon: { typeId: 'lighter' } }), { small: true }),
      button('Warning', () => toast({ category: 'warning', title: "You're overloaded", body: 'Moving is slower and tiring.' }), { small: true }),
      button('Spam ×12', () => {
        for (let i = 0; i < 12; i++) toast({ category: i % 3 ? 'info' : 'discovery', title: i % 3 ? `Picked up nail` : `New recipe: #${i}` });
      }, { small: true, title: 'Rate limiting: repeats fold, discoveries space out, overflow drops info' }),
    ),
    h('div', { class: 'ui2-section', text: 'Dialogs & actions' }),
    h(
      'div',
      { class: 'sc-row wrap' },
      button('Confirm', () => void confirmModal({ title: 'Eat the canned beans?', body: 'It will take about 30 seconds.', ok: 'Eat' }).then((v) => toast({ category: 'info', title: v ? 'Yum.' : 'Maybe later.' })), { small: true }),
      button('Danger', () => void confirmModal({ title: 'Disassemble the smartphone?', body: 'This cannot be undone. Press Y to confirm (Enter does nothing here).', ok: 'Disassemble', danger: true }), { small: true }),
      button('How many?', () => void countPrompt({ title: 'Drop how many?', subtitle: 'nail', max: 40, initial: 20, icon: { typeId: 'nail' } }).then((n) => toast({ category: 'info', title: n === null ? 'Cancelled' : `Chose ${n}` })), { small: true }),
      button('Progress', () => {
        startProgress({ label: 'Prying the window open', seconds: 3, hint: 'move to stop', onDone: () => toast({ category: 'info', title: 'The window pops open.' }) });
      }, { small: true }),
    ),
    h('div', { class: 'ui2-small ui2-dim sc-help', text: 'Drag = move · Shift-click = quick move · Ctrl-click = split · double-click = use · right-click = actions · wheel while dragging = amount · Esc closes/cancels · Tab inventory · 1–0 hotbar' }),
  );
}

// --- style guide -----------------------------------------------------------------------------

function openStyleGuide(raw: RawItems): void {
  if (findPanel('showcase.style')) return void findPanel('showcase.style')!.front();
  const p = openPanel({ id: 'showcase.style', title: 'Style guide', x: window.innerWidth - 40, y: 40, width: 'calc(var(--fs) * 22)', height: 'min(80vh, calc(var(--fs) * 40))' });
  const content = h('div', { class: 'sc-tabbody' });
  const make = (id: string, n: number, over: Partial<ItemView> = {}): ItemView | null => (raw[id] ? { ...mockItem(raw[id], n, `sg-${id}`), ...over } : null);
  const pages: Record<string, () => HTMLElement[]> = {
    Palette: () => [
      h(
        'div',
        { class: 'sc-swatches' },
        ...Object.entries(palette).map(([k, v]) => h('div', { class: 'sc-swatch' }, h('span', { style: { background: v } }), h('span', { class: 'ui2-small', text: k }), h('span', { class: 'ui2-small ui2-dim', text: v }))),
      ),
      h('div', { class: 'ui2-section', text: 'Text' }),
      h('div', { style: { fontSize: 'var(--fs-l)', color: 'var(--p-text-bright)' }, text: 'Large / titles (--fs-l)' }),
      h('div', { text: 'Body text (--fs): The quick brown fox jumps over 13 zombies.' }),
      h('div', { class: 'ui2-small', text: 'Small (--fs-s): counts, badges, hints.' }),
      h('div', null, ...(['accent', 'good', 'warn', 'bad', 'info', 'magic', 'dim'] as const).map((t) => h('span', { class: `tone-${t}`, text: `${t} ` }))),
    ],
    Controls: () => {
      const list = scrollList<ItemView>({
        items: ['hammer', 'crowbar', 'lighter', 'flashlight', 'duct_tape', 'smart_phone', 'matches', 'pipe', 'rock', 'stick', '2x4', 'nail', 'apple', 'chips', 'cola'].map((id) => make(id, 1)).filter((x): x is ItemView => !!x),
        render: (it) => itemCell(it, 'row'),
        onActivate: (it) => toast({ category: 'info', title: `Activated ${it.name}` }),
      });
      list.el.style.maxHeight = 'calc(var(--row-icon) * 5)';
      const over = capacityBar('Weight', (n) => `${(n / 1000).toFixed(1)} kg`);
      over.set(21400, 18000);
      const high = capacityBar('Volume', (n) => `${(n / 1000).toFixed(1)} L`);
      high.set(21, 25);
      const ok = capacityBar('Pocket', (n) => `${n} ml`);
      ok.set(300, 1250);
      const pb = progressBar('accent');
      pb.set(0.4, 'Reading 40%');
      const t = tabs([{ id: 'a', label: 'Tools' }, { id: 'b', label: 'Food', badge: '3' }, { id: 'c', label: 'Clothing' }], 'a', (id) => toast({ category: 'info', title: `Tab ${id}` }));
      return [
        h('div', { class: 'sc-row wrap' }, button('Normal', () => {}), button('Accent', () => {}, { tone: 'accent' }), button('Danger', () => {}, { tone: 'bad' }), button('Disabled', () => {}, { disabled: 'Need a key' }), button('Small', () => {}, { small: true, key: 'S' })),
        t.el,
        h('div', { class: 'ui2-section', text: 'Scroll list (↑↓ Enter, double-click)' }),
        list.el,
        h('div', { class: 'ui2-section', text: 'Capacity bars' }),
        ok.el, high.el, over.el,
        h('div', { class: 'ui2-section', text: 'Progress' }),
        pb.el,
      ];
    },
    Cells: () => {
      const cells: HTMLElement[] = [];
      const add = (it: ItemView | null, label: string, cls?: string) => {
        if (!it) return;
        const c = itemCell(it, 'grid');
        if (cls) c.classList.add(cls);
        attachTooltip(c, () => itemTooltip(it));
        cells.push(h('div', { class: 'sc-cellbox' }, c, h('span', { class: 'ui2-small ui2-dim', text: label })));
      };
      add(make('machete', 1, { condition: 1 }), 'pristine');
      add(make('machete', 1, { condition: 0.6 }), 'worn');
      add(make('machete', 1, { condition: 0.15 }), 'damaged');
      add(make('9mm', 50), 'stack');
      add(make('flashlight', 1, { charges: { cur: 30, max: 100, label: 'Battery' } }), 'charges');
      add(make('apple', 3, { badges: [{ text: '!', tone: 'bad', title: 'Rotten soon' }] }), 'badge');
      add(make('glasses_eye', 1), 'fragile');
      add(make('backpack', 1, { contents: [make('rock', 2)!].filter(Boolean) }), 'holds items');
      add(make('hammer', 1), 'selected', 'selected');
      cells.push(h('div', { class: 'sc-cellbox' }, emptySlot('Head'), h('span', { class: 'ui2-small ui2-dim', text: 'empty slot' })));
      const rows = ['bat', 'water_clean', '9mm'].map((id) => make(id, id === '9mm' ? 23 : 1)).filter((x): x is ItemView => !!x).map((it) => {
        const c = itemCell(it, 'row');
        attachTooltip(c, () => itemTooltip(it));
        return c;
      });
      return [h('div', { class: 'sc-cells' }, ...cells), h('div', { class: 'ui2-section', text: 'List rows' }), ...rows];
    },
  };
  const t = tabs(Object.keys(pages).map((k) => ({ id: k, label: k })), 'Palette', (id) => content.replaceChildren(...pages[id]()));
  content.replaceChildren(...pages.Palette());
  p.body.append(t.el, content);
}

// --- the pretend world -------------------------------------------------------------------------

interface World {
  objects: WorldObject[];
  tile: number;
  at(x: number, y: number): WorldObject | null;
}

function drawWorld(canvas: HTMLCanvasElement, atlas: Atlas): World {
  const objects: WorldObject[] = [
    { name: 'locker', kind: 'furniture', id: 'f_locker', x: 14, y: 3, w: 1, h: 1 },
    { name: 'wooden table', kind: 'furniture', id: 'f_table', x: 11, y: 6, w: 1, h: 1 },
    { name: 'wooden door', kind: 'terrain', id: 't_door_c', x: 12, y: 9, w: 1, h: 1 },
    { name: 'zombie', kind: 'creature', id: 'mon_zombie', x: 19, y: 11, w: 1, h: 1 },
    { name: 'pile of 3 items', kind: 'items', id: 'can_beans', x: 9, y: 4, w: 1, h: 1 },
    { name: 'young tree', kind: 'terrain', id: 't_tree_young', x: 20, y: 4, w: 1, h: 1 },
  ];
  const world: World = { objects, tile: 64, at: () => null };
  const draw = () => {
    const W = (canvas.width = window.innerWidth), H = (canvas.height = window.innerHeight);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const k = Math.max(1, Math.round(H / 400));
    const T = 32 * k;
    world.tile = T;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    const put = (id: string, tx: number, ty: number) => {
      const hit = atlas.lookup(id);
      if (!hit) return;
      g.drawImage(atlas.spriteCanvas(hit, k), tx * T, ty * T);
    };
    for (let y = 0; y * T < H; y++) for (let x = 0; x * T < W; x++) put((x * 7 + y * 3) % 11 === 0 ? 't_dirt' : 't_grass', x, y);
    for (let y = 2; y <= 9; y++)
      for (let x = 8; x <= 16; x++) put(y === 2 || y === 9 || x === 8 || x === 16 ? (x === 12 && y === 9 ? 't_floor' : 't_wall') : 't_floor', x, y);
    for (const o of objects) put(o.id, o.x, o.y);
    put('can_beans', 9, 4);
    // Night-ish grade so windows read as "over the game".
    g.fillStyle = 'rgba(8,10,20,.35)';
    g.fillRect(0, 0, W, H);
  };
  draw();
  window.addEventListener('resize', draw);
  world.at = (px, py) => {
    const tx = Math.floor(px / world.tile), ty = Math.floor(py / world.tile);
    return objects.find((o) => tx >= o.x && tx < o.x + o.w && ty >= o.y && ty < o.y + o.h) ?? null;
  };
  return world;
}

function installWorldMenus(canvas: HTMLCanvasElement, world: World): void {
  // Hover highlight: a pixel frame around the object under the cursor, plus its name.
  const frame = h('div', { class: 'sc-hover' });
  const label = h('div', { class: 'ui2-hover-label' });
  frame.style.display = label.style.display = 'none';
  ui2Layers().world.append(frame, label);
  let hovered: WorldObject | null = null;
  canvas.addEventListener('pointermove', (e) => {
    hovered = world.at(e.clientX, e.clientY);
    frame.style.display = label.style.display = hovered ? '' : 'none';
    if (!hovered) return;
    const T = world.tile;
    Object.assign(frame.style, { left: `${hovered.x * T}px`, top: `${hovered.y * T}px`, width: `${hovered.w * T}px`, height: `${hovered.h * T}px` });
    label.textContent = hovered.name;
    Object.assign(label.style, { left: `${e.clientX}px`, top: `${e.clientY}px` });
  });
  canvas.addEventListener('pointerleave', () => (frame.style.display = label.style.display = 'none'));
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const o = world.at(e.clientX, e.clientY);
    const t: WorldTarget = o ? { kind: o.kind, name: o.name, x: o.x, y: o.y, z: 0, furniture: o.kind === 'furniture' ? o.id : undefined, terrain: o.kind === 'terrain' ? o.id : undefined } : { kind: 'floor', name: 'grass', x: 0, y: 0, z: 0, terrain: 't_grass' };
    const items = worldMenu(t);
    if (items.length) openContextMenu({ x: e.clientX, y: e.clientY }, items, { title: t.name });
  });
  canvas.addEventListener('click', (e) => {
    const o = world.at(e.clientX, e.clientY);
    if (!o) return;
    // Left-click = the primary world action.
    const primary = worldMenu({ kind: o.kind, name: o.name, x: o.x, y: o.y, z: 0 }).find((m) => 'primary' in m && m.primary && !m.disabled);
    if (primary && 'action' in primary) primary.action?.();
  });

  // Mock providers, the way game systems will contribute (doors, furniture, creatures…).
  const say = (title: string) => void toast({ category: 'info', title });
  worldContextProviders.push((t) =>
    t.furniture === 'f_locker'
      ? [
          { label: 'Open', key: 'O', time: 2, primary: true, action: () => say('The locker is empty.') },
          { label: 'Pry open', time: 45, disabled: 'Need: a prying tool (prying 1)' },
          { label: 'Hide inside', time: 3, action: () => say("You can't fit with the backpack on.") },
        ]
      : [],
  );
  worldContextProviders.push((t) =>
    t.terrain === 't_door_c'
      ? [
          { label: 'Open door', key: 'O', time: 1, primary: true, action: () => say('The door creaks open.') },
          { label: 'Lock', disabled: 'Need: the key' },
          {
            label: 'Smash', key: 'S', danger: true,
            submenu: [
              { label: 'with baseball bat', icon: { typeId: 'bat' }, time: 4, action: () => startProgress({ label: 'Smashing the door', seconds: 2.5, onDone: () => say('Crash!') }) },
              { label: 'with fists', time: 8, action: () => say('Ow.') },
            ],
          },
        ]
      : [],
  );
  worldContextProviders.push((t) =>
    t.kind === 'creature'
      ? [
          { label: 'Attack', key: 'A', time: 1.2, primary: true, danger: true, action: () => say('You swing at the zombie!') },
          { label: 'Throw ▸', submenu: [{ label: 'rock', icon: { typeId: 'rock' }, time: 1, action: () => say('Thunk.') }] },
        ]
      : [],
  );
  worldContextProviders.push((t) =>
    t.kind === 'items'
      ? [
          { label: 'Pick up all', key: 'G', time: 2, primary: true, action: () => say('(mock) You pick up everything.') },
          { label: 'Look through…', time: 1, action: () => say('(mock) Opens the ground panel for that tile.') },
        ]
      : [],
  );
  // Everyone gets "Look at", like the x key.
  worldContextProviders.push((t) => [{ label: 'Look at', key: 'L', time: 0, action: () => say(`That's a ${t.name}.`) }]);
}
