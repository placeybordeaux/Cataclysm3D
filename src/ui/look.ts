import * as THREE from 'three';
import type { Item } from '../game/item';
import type { LookCreature } from '../game/game';
import { raycastTiles, type RayHit } from '../game/raycast';
import { cddaText } from '../game/units';
import { c, colorize, isCloseKey } from './framework';
import { spriteImg, omtLabel, type UiContext } from './context';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { describeVehicleAt, vehicleSolidHeight } from './vehicle_ui';
import { acquireSurface, h, iconEl, pushKeys, ui2Layers, worldMenu, closeMenu, type MenuItem, type WorldTarget } from '../ui2';
import { targetFromHit, worldHoverListeners } from '../ui2/install';
import { meter } from './screen2';
import './screens2.css';

// Looking at things, v2: a card anchored to the object in the world (a diamond on it and a
// leader line to the card) with its name, description, condition, what's there, and the
// actions you can take (the same entries as its right-click menu, primary first).
//
//  - Hover: with the cursor free (any ui2 window, the context menu…), resting on an object
//    shows its card after a moment; moving off hides it.
//  - `x` (look): the card for what the crosshair points at, with the cursor freed so you can
//    click an action or hover other things; arrows still turn the view, x / Space / Bksp close (Esc too).
//    Time stops while you look (CDDA's look mode is free).
//
// describeHit() (the old text description) stays for automation (cdda.ui.lookText).

const tmpDir = new THREE.Vector3();

/** game.lookAt implementation: ray from the active camera through the screen centre. */
export function cameraLookAt(ctx: UiContext, maxDist = 60): RayHit<LookCreature> | null {
  const cam = ctx.renderer.camera;
  cam.updateMatrixWorld();
  cam.getWorldDirection(tmpDir);
  const o = cam.position;
  return raycastTiles<LookCreature>(
    ctx.game.map,
    { x: o.x, y: o.z, h: o.y },
    { x: tmpDir.x, y: tmpDir.z, h: tmpDir.y },
    {
      maxDist, creatureAt: (x, y, z) => ctx.game.creatureAt(x, y, z), skipOrigin: ctx.renderer.cameraMode === 'first',
      vehicleAt: (x, y, z) => vehicleSolidHeight(ctx.game, x, y, z),
    },
  );
}

export function describeHit(ctx: UiContext, hit: RayHit<LookCreature> | null): string {
  if (!hit) return c('c_light_gray', 'You see nothing there but sky.');
  const p = ctx.game.player;
  const L: string[] = [];
  const dist = Math.max(Math.abs(hit.x - p.tileX), Math.abs(hit.y - p.tileY));
  if (hit.kind === 'creature' && hit.creature) {
    const cr = hit.creature;
    L.push(`${c(cr.color ?? 'c_white', cr.symbol ?? '')} ${c('c_white', cr.name)}`);
    if (cr.describe) L.push(colorize(cr.describe()));
    L.push('');
  }
  const veh = describeVehicleAt(ctx.game, hit.x, hit.y, hit.z);
  if (veh) L.push(veh, '');
  const tx = hit.x, tz = hit.z;
  const ter = hit.terrain, furn = hit.furniture;
  const fName = furn.id !== 'f_null' ? furn.name : '';
  L.push(`${spriteImg(ctx.renderer, ter.id)}${c('c_light_gray', 'Terrain:')} ${c(ter.color ?? 'c_white', ter.name)}${ter.move_cost > 0 ? c('c_dark_gray', `  (move cost ${ter.move_cost})`) : c('c_dark_gray', '  (impassable)')}`);
  if (hit.kind === 'ceiling') L.push(c('c_dark_gray', '(the ceiling above you)'));
  if (ter.description) L.push(c('c_dark_gray', cddaText(ter.description)));
  if (fName) {
    L.push(`${spriteImg(ctx.renderer, furn.id)}${c('c_light_gray', 'Furniture:')} ${c(furn.color ?? 'c_white', fName)}`);
    if (furn.description) L.push(c('c_dark_gray', cddaText(furn.description)));
  }
  for (const f of fieldNames(ctx, tx, hit.y, tz)) L.push(c('c_light_red', f));
  const items = ctx.game.map.itemsAt(tx, hit.y, tz) as Item[];
  if (items.length) {
    L.push('', c('c_light_gray', items.length === 1 ? 'There is an item here:' : `There are ${items.length} items here:`));
    for (const it of items.slice(0, 10)) L.push(`  ${spriteImg(ctx.renderer, it.typeId)}${c('c_white', it.name())}`);
    if (items.length > 10) L.push(c('c_dark_gray', `  … and ${items.length - 10} more`));
  }
  const { sign, graf } = writing(ctx, tx, hit.y, tz);
  if (sign) L.push('', `${c('c_light_gray', 'The sign reads:')} ${c('c_white', sign)}`);
  if (graf) L.push('', `${c('c_light_gray', 'Written here:')} ${c('c_white', graf)}`);
  L.push('', c('c_dark_gray', `${dist} tile${dist === 1 ? '' : 's'} away  (${hit.x}, ${hit.y}, ${hit.z})`));
  const om = omtLabel(ctx, Math.floor(hit.x / CHUNK), Math.floor(hit.y / CHUNK), hit.z);
  if (om) L.push(c('c_dark_gray', `in: ${om.name}${om.city ? `, ${om.city}` : ''}`));
  return L.join('\n');
}

function fieldNames(ctx: UiContext, x: number, y: number, z: number): string[] {
  return ctx.game.map.fieldsAt(x, y, z).map((f) => {
    const def = ctx.game.data.misc?.field_type?.[f.type];
    const names = def?.intensity_levels?.map((l: { name?: string }) => cddaText(l.name ?? '')) ?? [];
    return names[f.intensity - 1] || names[0] || f.type;
  });
}

function writing(ctx: UiContext, x: number, y: number, z: number): { sign?: string; graf?: string } {
  const chunk = ctx.game.map.chunk(Math.floor(x / CHUNK), Math.floor(y / CHUNK), z);
  const li = (((y % CHUNK) + CHUNK) % CHUNK) * CHUNK + (((x % CHUNK) + CHUNK) % CHUNK);
  return { sign: chunk?.signs.get(li), graf: chunk?.graffiti.get(li) };
}

// ------------------------------------------------------------------ the card

interface CardState {
  el: HTMLElement;
  anchor: HTMLElement;
  leader: HTMLElement;
  target: WorldTarget;
  /** Height above the floor (m) the card points at. */
  lift: number;
}

/** Build the card body for a target. `actions` adds the clickable action row. */
export function lookCardContent(ctx: UiContext, t: WorldTarget, actions: boolean, onAction?: () => void): HTMLElement[] {
  const g = ctx.game;
  const hit = t.hit as RayHit<LookCreature> | undefined;
  const out: HTMLElement[] = [];
  const cr = t.kind === 'creature' ? (t.creature as (LookCreature & { monster?: { hp: number; hpMax: number; type: { id: string } }; npc?: { hp?: unknown } }) | undefined) : undefined;
  const items = (g.map.itemsAt(t.x, t.y, t.z) as Item[]) ?? [];
  const furn = hit && hit.furniture.id !== 'f_null' ? hit.furniture : null;
  const ter = hit?.terrain;

  // Head: icon + name + what kind of thing it is.
  const iconId = cr?.monster?.type.id ?? (t.kind === 'items' && items[0] ? items[0].typeId : furn?.id ?? ter?.id);
  const kind = cr ? (cr.npc ? 'Person' : 'Creature') : t.kind === 'items' ? (items.length === 1 ? 'Item' : 'Items') : furn ? 'Furniture' : t.kind === 'vehicle' ? 'Vehicle' : t.kind === 'ceiling' ? 'Ceiling' : 'Terrain';
  out.push(h('div', { class: 'lk-head' },
    iconId ? iconEl({ typeId: iconId, symbol: cr?.symbol, color: cr?.color }, 'row') : null,
    h('div', null, h('div', { class: 'lk-name', text: t.name.replace(/^./, (x) => x.toUpperCase()) }), h('div', { class: 'lk-kind', text: kind })),
  ));

  if (cr) {
    const m = cr.monster;
    if (m) {
      const f = Math.max(0, m.hp / m.hpMax);
      const [label, tone] = f >= 1 ? ['Uninjured', 'good'] : f > 0.75 ? ['Lightly injured', 'good'] : f > 0.5 ? ['Injured', 'warn'] : f > 0.25 ? ['Badly injured', 'bad'] : ['Nearly dead', 'bad'];
      out.push(h('div', { class: 'lk-row' }, h('span', { class: 'ui2-dim', text: 'Condition' }), meter(f, tone, label)));
    }
    if (cr.describe) out.push(h('div', { class: 'lk-desc', html: colorize(cr.describe()) }));
  } else if (t.kind === 'items') {
    const list = h('div', { class: 'lk-items' });
    for (const it of items.slice(0, 6)) list.append(h('div', { class: 'lk-item' }, iconEl({ typeId: it.typeId, symbol: it.def.symbol, color: it.def.color, looksLike: it.def.looks_like }, 'row'), h('span', { text: it.name() })));
    if (items.length > 6) list.append(h('div', { class: 'ui2-dim', text: `… and ${items.length - 6} more` }));
    out.push(list);
    if (items.length === 1 && items[0].def.description) out.push(h('div', { class: 'lk-desc', text: cddaText(items[0].def.description as string) }));
  } else if (furn) {
    if (furn.description) out.push(h('div', { class: 'lk-desc', text: cddaText(furn.description) }));
    if (items.length) out.push(h('div', { class: 'ui2-small tone-info', text: `${items.length} item${items.length > 1 ? 's' : ''} here` }));
  } else if (ter) {
    if (ter.description) out.push(h('div', { class: 'lk-desc', text: cddaText(ter.description) }));
  }
  const veh = describeVehicleAt(g, t.x, t.y, t.z);
  if (veh) out.push(h('div', { class: 'lk-desc', html: veh }));
  if (ter && !cr && t.kind !== 'items') {
    // Furniture adds to the floor's cost (a cupboard is not "easy to walk on"); < 0 blocks.
    const fm = furn?.move_cost_mod ?? 0;
    const mc = fm < 0 ? 0 : ter.move_cost + fm;
    out.push(h('div', { class: 'ui2-small ui2-dim', text: mc <= 0 ? 'Impassable' : mc > 2 ? `Slow going (move cost ${mc})` : 'Easy to walk on' }));
  }
  for (const f of fieldNames(ctx, t.x, t.y, t.z)) out.push(h('div', { class: 'ui2-small tone-bad', text: f }));
  const { sign, graf } = writing(ctx, t.x, t.y, t.z);
  if (sign) out.push(h('div', { class: 'ui2-small', text: `The sign reads: “${sign}”` }));
  if (graf) out.push(h('div', { class: 'ui2-small', text: `Written here: “${graf}”` }));
  const p = g.player;
  const d = Math.round(Math.hypot(t.x + 0.5 - p.x, t.y + 0.5 - p.y));
  out.push(h('div', { class: 'lk-hint', text: `${d} m away${t.z !== p.z ? ` · ${t.z > p.z ? 'above' : 'below'}` : ''}` }));

  if (actions) {
    const acts = worldMenu(t).filter((m): m is Extract<MenuItem, { label: string }> => 'label' in m && !('header' in m) && !m.submenu && m.label !== 'Look at');
    const row = h('div', { class: 'lk-actions', attrs: { 'data-testid': 'look-actions' } });
    acts.sort((a, b) => Number(!!('primary' in b && b.primary)) - Number(!!('primary' in a && a.primary)));
    acts.slice(0, 6).forEach((a, i) => {
      const btn = h('button', { class: `ui2-btn small lk-act${a.primary ? ' tone-accent' : ''}`, title: a.disabled && typeof a.disabled === 'string' ? a.disabled : '' },
        h('span', { class: 'scr-key', text: String(i + 1) }), h('span', { text: a.label }), a.time ? h('kbd', { text: `${a.time}s` }) : null);
      if (a.disabled) (btn as HTMLButtonElement).disabled = true;
      btn.addEventListener('click', () => {
        onAction?.();
        a.action?.();
      });
      row.append(btn);
    });
    if (acts.length) out.push(row);
    out.push(h('div', { class: 'lk-hint', text: `${acts.length ? '1–' + Math.min(6, acts.length) + ' or click: act · ' : ''}right-click it for every action` }));
  }
  return out;
}

function makeCard(cls: string): Omit<CardState, 'target' | 'lift'> {
  const L = ui2Layers();
  const leader = L.world.appendChild(h('div', { class: 'lk-leader' }));
  const anchor = L.world.appendChild(h('div', { class: 'lk-anchor' }));
  const el = L.world.appendChild(h('div', { class: `lk-card ui2-cdda ${cls}`, attrs: { 'data-testid': 'look-card' } }));
  return { el, anchor, leader };
}

const tmpV = new THREE.Vector3();

/** Place a card next to its target's projected position; false if the target is off-screen. */
function placeCard(ctx: UiContext, s: CardState): boolean {
  const cam = ctx.renderer.camera;
  const canvas = ctx.renderer.three.domElement as HTMLCanvasElement;
  const r = canvas.getBoundingClientRect();
  const t = s.target;
  tmpV.set(t.x + 0.5, t.z * LEVEL_HEIGHT + s.lift, t.y + 0.5).project(cam);
  const on = tmpV.z < 1 && Math.abs(tmpV.x) < 1.1 && Math.abs(tmpV.y) < 1.1;
  const ax = r.left + ((tmpV.x + 1) / 2) * r.width, ay = r.top + ((1 - tmpV.y) / 2) * r.height;
  const cw = s.el.offsetWidth, ch = s.el.offsetHeight;
  const gap = 48;
  // Right of the object unless that runs off screen, vertically centred on it, clamped.
  let x = ax + gap;
  if (x + cw > innerWidth - 8) x = ax - gap - cw;
  x = Math.max(8, Math.min(innerWidth - cw - 8, x));
  const y = Math.max(8, Math.min(innerHeight - ch - 8, ay - ch / 2));
  s.el.style.left = `${Math.round(x)}px`;
  s.el.style.top = `${Math.round(y)}px`;
  s.anchor.style.display = s.leader.style.display = on ? '' : 'none';
  if (on) {
    s.anchor.style.left = `${Math.round(ax)}px`;
    s.anchor.style.top = `${Math.round(ay)}px`;
    const ex = x > ax ? x : x + cw, ey = Math.max(y + 12, Math.min(y + ch - 12, ay));
    const len = Math.hypot(ex - ax, ey - ay);
    s.leader.style.left = `${Math.round(ax)}px`;
    s.leader.style.top = `${Math.round(ay)}px`;
    s.leader.style.width = `${Math.round(len)}px`;
    s.leader.style.transform = `rotate(${Math.atan2(ey - ay, ex - ax)}rad)`;
  }
  return on;
}

const liftFor = (t: WorldTarget) => (t.kind === 'creature' ? 1.2 : t.kind === 'furniture' ? 0.6 : t.kind === 'terrain' || t.kind === 'vehicle' ? 1.2 : t.kind === 'ceiling' ? LEVEL_HEIGHT - 0.2 : 0.1);

let lookOpen: (() => void) | null = null;

/** Open the look card for a target (x, or "Look at" in a context menu). */
export function openLookCard(ctx: UiContext, target: WorldTarget | null): { close(): void } {
  lookOpen?.();
  const g = ctx.game;
  const release = acquireSurface({ pauses: 'always' });
  const parts = makeCard('mode-look');
  let cur: CardState = { ...parts, target: target ?? { kind: 'terrain', name: 'Nothing', x: g.player.tileX, y: g.player.tileY, z: g.player.z }, lift: 0 };
  let raf = 0;
  let closed = false;
  const fill = () => {
    cur.lift = liftFor(cur.target);
    if (!target) cur.el.replaceChildren(h('div', { class: 'lk-name', text: 'Nothing there' }), h('div', { class: 'lk-hint', text: 'You see nothing there but sky.' }));
    else cur.el.replaceChildren(...lookCardContent(ctx, cur.target, true, () => close()));
  };
  const STEP = (4 * Math.PI) / 180;
  const removeKeys = pushKeys((e) => {
    const k = e.key;
    const p = g.player;
    if (k === 'ArrowLeft' || k === 'h') p.yaw -= STEP;
    else if (k === 'ArrowRight' || k === 'l') p.yaw += STEP;
    else if (k === 'ArrowUp' || k === 'k') p.pitch = Math.min(1.5, p.pitch + STEP);
    else if (k === 'ArrowDown' || k === 'j') p.pitch = Math.max(-1.5, p.pitch - STEP);
    else if (/^[1-6]$/.test(k)) {
      const btn = cur.el.querySelectorAll<HTMLButtonElement>('.lk-act')[Number(k) - 1];
      if (btn && !btn.disabled) btn.click();
    } else if (!e.repeat && (k === 'Escape' || k === 'Backspace' || k === g.keys.keyFor('look') || isCloseKey(e))) close();
    else return true; // look is modal: other gameplay keys do nothing while it's up
    if (k.startsWith('Arrow') || 'hjkl'.includes(k)) {
      // Turning re-aims at whatever the crosshair now points at.
      const t = targetFromHit(g, g.lookAt());
      if (t) (target = t), (cur.target = t), fill();
    }
    return true;
  }, { overlay: true });
  // Hovering other things while looking retargets the card.
  const opened = performance.now();
  const onHover = (t: WorldTarget | null) => {
    // Freeing the cursor leaves it wherever it was and the browser reports a move there: only
    // a real move after opening retargets, or `x` would describe what the cursor rests on.
    if (!t || closed || performance.now() - opened < 400) return;
    const tt = cur.target;
    if (t.kind === tt.kind && t.x === tt.x && t.y === tt.y && t.z === tt.z) return;
    target = t;
    cur.target = t;
    fill();
  };
  worldHoverListeners.push(onHover);
  fill();
  const tick = () => {
    raf = requestAnimationFrame(tick);
    placeCard(ctx, cur);
  };
  tick();
  function close(): void {
    if (closed) return;
    closed = true;
    lookOpen = null;
    cancelAnimationFrame(raf);
    removeKeys();
    worldHoverListeners.splice(worldHoverListeners.indexOf(onHover), 1);
    cur.el.remove();
    cur.anchor.remove();
    cur.leader.remove();
    closeMenu();
    release();
  }
  lookOpen = close;
  (window as unknown as { cdda?: { lookCard?: unknown } }).cdda && ((window as unknown as { cdda: { lookCard?: unknown } }).cdda.lookCard = { target: () => cur.target, close });
  return { close };
}

/** `x`: the card for what the crosshair points at. */
export function openLookMode(ctx: UiContext): { close(): void } {
  return openLookCard(ctx, targetFromHit(ctx.game, ctx.game.lookAt()));
}

export function lookCardOpen(): boolean {
  return !!lookOpen;
}

/**
 * Hover inspection while the cursor is free: after resting ~0.4 s on an object, its card
 * (without the action row; right-click has them) appears anchored to it.
 */
export function installLookHover(ctx: UiContext): void {
  let parts: Omit<CardState, 'target' | 'lift'> | null = null;
  let cur: CardState | null = null;
  let timer = 0;
  let raf = 0;
  let last: WorldTarget | null = null;
  const hide = () => {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    if (parts) for (const e of [parts.el, parts.anchor, parts.leader]) e.style.display = 'none';
    cur = null;
    document.body.classList.remove('lk-hovering');
  };
  worldHoverListeners.push((t, x, y) => {
    if (lookOpen) return hide();
    if (!t) return (last = null), hide();
    if (last && t.kind === last.kind && t.x === last.x && t.y === last.y && t.z === last.z) return;
    last = t;
    hide();
    timer = window.setTimeout(() => {
      // Only while the pointer is still on the world (not on a window that opened over it).
      if (document.elementFromPoint(x, y) !== ctx.renderer.three.domElement) return;
      parts ??= makeCard('mode-hover');
      cur = { ...parts, target: t, lift: liftFor(t) };
      parts.el.replaceChildren(...lookCardContent(ctx, t, false), h('div', { class: 'lk-hint', text: 'Right-click: actions · left-click: default action' }));
      for (const e of [parts.el, parts.anchor, parts.leader]) e.style.display = '';
      // The name label next to the cursor would repeat the card's title.
      document.body.classList.add('lk-hovering');
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (cur) placeCard(ctx, cur);
      };
      tick();
    }, 400);
  });
}
