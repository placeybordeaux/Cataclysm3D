// ui2 inside the 3D game. The interaction model:
//
// - Opening any ui2 surface (window, menu, modal) frees the cursor on purpose: the pointer lock
//   is released as an *expected* unlock (src/ui/pointer.ts ignores it: no "click to resume"),
//   ui2 takes the keyboard through input.capture. Closing the last surface re-captures the
//   mouse (the closing click/key is the user gesture Chrome needs).
// - Game time: ui2 captures with timeFlows, so the legacy "menus pause" rule doesn't apply;
//   inventory-type windows ask for game.tacticalPause instead, which the ui2 setting
//   (Accessible default: on) grants. Classic players keep time running.
// - While the cursor is free: hovering the world outlines the object under the cursor (a 3D
//   line box — it goes through the post pass, so it's pixelated and palette-graded like the
//   world) with its name next to the cursor; right-click opens worldMenu(); left-click runs
//   the primary world action.
// - i / Tab toggle the inventory on the real items (src/ui2/bn); the mock one lives on in the
//   showcase (?debug=ui2).

import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { DebugApi } from '../debug';
import type { UiContext } from '../ui/context';
import { raycastTiles, type RayHit } from '../game/raycast';
import type { LookCreature } from '../game/game';
import { LEVEL_HEIGHT } from '../world/coords';
import { describeHit } from '../ui/look';
import { vehicleSolidHeight } from '../ui/vehicle_ui';
import { registerOption } from '../ui/options';
import { h, ui2Layers } from './dom';
import { installTheme, setScalePref, scalePref, currentMetrics } from './theme';
import { setHost, shortcut, settings, saveSettings, surfacesOpen } from './host';
import { closeGroup, openPanels } from './window';
import { openContextMenu, closeMenu, menuOpen } from './menu';
import { dragging } from './dragdrop';
import { worldContextProviders, worldMenu, type WorldTarget } from './world';
import { toast, toastState } from './toast';
import { installBnInventory } from './bn/install';
import { bnInventoryOpen } from './bn/screen';
import { palette } from './theme';
import type { UiScalePref } from './logic/scale';

export interface Ui2Handle {
  toggleInventory(): void;
}

export function installUi2(game: Game, renderer: Renderer, ctx: UiContext, api: DebugApi): Ui2Handle {
  const L = ui2Layers();
  installTheme(L.root);
  const input = game.input;
  const canvas = renderer.three.domElement as HTMLCanvasElement;

  let releaseCapture: (() => void) | null = null;
  setHost({
    activate(route) {
      // Our own unlock: pointer.ts sees expectUnlock and neither pauses nor opens the Esc menu.
      input.releaseForMenu();
      document.body.classList.add('ui2-cursor-free');
      releaseCapture = input.capture((e) => route(e), { timeFlows: true });
    },
    deactivate() {
      releaseCapture?.();
      releaseCapture = null;
      document.body.classList.remove('ui2-cursor-free');
      hover.clear();
      // Inside the key press / click that closed the last window: a valid gesture to re-lock.
      input.tryLock();
    },
    setPaused(p) {
      game.tacticalPause = p;
    },
  });

  // A key that both resumes mouse-look and opens a ui2 window (Tab while the resume hint is
  // up) requests the lock *before* the window opens; it lands afterwards. Give it back.
  document.addEventListener('pointerlockchange', () => {
    if (input.locked && surfacesOpen() > 0) input.releaseForMenu();
  });

  // The inventory on the player's real (BN) items: i / Tab, the action keys, the hotbar.
  const inv = installBnInventory(game, ctx, api, canvas);
  const inventory = () => inv.toggle();
  // Inside ui2 the game's bindings don't run; Tab closes it again from there.
  shortcut('Tab', inventory);
  game.events.on('playerDied', () => {
    closeMenu();
    closeGroup();
  });

  // --- world hover + context menu while the cursor is free
  const hover = worldHover(game, renderer);
  const free = () => surfacesOpen() > 0 && !input.locked;
  let pending: PointerEvent | null = null;
  canvas.addEventListener('pointermove', (e) => {
    if (!free()) return hover.clear();
    if (!pending) requestAnimationFrame(() => {
      if (pending && free()) hover.update(pending.clientX, pending.clientY);
      pending = null;
    });
    pending = e;
  });
  // The context menu opening under the cursor counts as leaving the canvas: keep the outline
  // on the object the menu is about.
  canvas.addEventListener('pointerleave', () => !menuOpen() && hover.clear());
  canvas.addEventListener('contextmenu', (e) => {
    if (!free()) return;
    e.preventDefault();
    const t = hover.pick(e.clientX, e.clientY);
    if (!t) return;
    const items = worldMenu(t);
    if (items.length) openContextMenu({ x: e.clientX, y: e.clientY }, items, { title: t.name });
  });
  canvas.addEventListener('click', (e) => {
    if (!free() || e.button !== 0) return;
    const t = hover.pick(e.clientX, e.clientY);
    const primary = t && worldMenu(t).find((m) => 'primary' in m && m.primary && !m.disabled);
    if (primary && 'action' in primary) primary.action?.();
  });

  // While the mouse is captured RMB is guard/aim, so the crosshair's context menu is a key.
  // It opens at the screen centre; being a ui2 surface it frees the cursor for pointing.
  game.keys.register('world_menu', 'Actions for what you look at (context menu)', () => {
    const t = hover.fromHit(game.lookAt(6));
    if (!t) return game.message('Nothing there to act on.', 'c_light_gray');
    const items = worldMenu(t);
    if (!items.length) return game.message(`Nothing to do with the ${t.name}.`, 'c_light_gray');
    const r = canvas.getBoundingClientRect();
    openContextMenu({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, items, { title: t.name });
  });

  // Built-in world entry: what `x` look mode would say about it.
  worldContextProviders.push((t) => [
    {
      label: 'Look at', key: 'L', time: 0,
      action: () => {
        const text = describeHit(ctx, t.hit as RayHit<LookCreature>).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
        const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
        toast({ category: 'info', title: t.name, body: lines.slice(0, 4).join(' · ') || undefined, key: `look:${t.x},${t.y},${t.z}` });
      },
    },
  ]);

  // --- options
  registerOption({
    name: 'UI scale',
    desc: 'Size of the new (ui2) windows: Auto picks 1×/2×/3× from the window height.',
    value: () => (scalePref() === 'auto' ? `Auto (${currentMetrics().scale}×)` : `${scalePref()}×`),
    change: (dir) => {
      const order: UiScalePref[] = ['auto', 1, 2, 3];
      setScalePref(order[(order.indexOf(scalePref()) + dir + order.length) % order.length]);
    },
  });
  registerOption({
    name: 'Pause in inventory',
    desc: 'Tactical pause while inventory windows are open (Accessible). Off: time keeps running (Classic).',
    value: () => (settings.pauseInInventory ? 'Yes' : 'No'),
    change: () => {
      settings.pauseInInventory = !settings.pauseInInventory;
      saveSettings();
    },
  });

  api.ui2 = {
    toggleInventory: inventory,
    state: () => ({
      panels: openPanels().map((p) => p.id),
      surfaces: surfacesOpen(),
      inventory: bnInventoryOpen(),
      tacticalPause: game.tacticalPause,
      locked: input.locked,
      captured: input.captured,
      toasts: toastState(),
      hover: hover.current()?.name ?? null,
      menu: [...document.querySelectorAll('.ui2-menu')].map((m) => [...m.querySelectorAll('.ui2-menu-row')].map((r) => r.textContent)),
    }),
    /** Centre of the first button/tab/menu row whose text contains `text` (for xclick). */
    textRect(text: string) {
      const el = [...document.querySelectorAll('#ui2 button, #ui2 .ui2-menu-row, #ui2 .ui2-list-row')].find((e) => e.textContent?.includes(text));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    },
    rect(sel: string) {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    },
    /** ui2 settings (pauseInInventory); call saveSettings() after changing. */
    settings,
    saveSettings,
  };
  return { toggleInventory: inventory };
}

// --- picking and highlighting world objects under the cursor ----------------------------------

function worldHover(game: Game, renderer: Renderer) {
  const ndc = new THREE.Vector3();
  const box = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
    new THREE.LineBasicMaterial({ color: new THREE.Color(palette.accent), depthTest: false, transparent: true }),
  );
  box.renderOrder = 999;
  box.visible = false;
  box.frustumCulled = false;
  renderer.scene.add(box);
  const label = h('div', { class: 'ui2-hover-label' });
  label.style.display = 'none';
  ui2Layers().world.appendChild(label);
  let cur: WorldTarget | null = null;

  const pick = (x: number, y: number): WorldTarget | null => {
    const cam = renderer.camera;
    const r = (renderer.three.domElement as HTMLCanvasElement).getBoundingClientRect();
    cam.updateMatrixWorld();
    ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(cam).sub(cam.position).normalize();
    const hit = raycastTiles<LookCreature>(
      game.map,
      { x: cam.position.x, y: cam.position.z, h: cam.position.y },
      { x: ndc.x, y: ndc.z, h: ndc.y },
      { maxDist: 40, creatureAt: (tx, ty, tz) => game.creatureAt(tx, ty, tz), skipOrigin: renderer.cameraMode === 'first', vehicleAt: (tx, ty, tz) => vehicleSolidHeight(game, tx, ty, tz) },
    );
    return fromHit(hit);
  };

  const fromHit = (hit: RayHit<LookCreature> | null): WorldTarget | null => {
    if (!hit) return null;
    const items = hit.kind === 'floor' ? game.map.itemsAt(hit.x, hit.y, hit.z) : [];
    const kind: WorldTarget['kind'] = items.length ? 'items' : (hit.kind as WorldTarget['kind']);
    const name =
      hit.kind === 'creature' && hit.creature ? hit.creature.name
      : items.length ? (items.length === 1 ? itemName(items[0]) : `${items.length} items`)
      : hit.furniture && hit.furniture.id !== 'f_null' ? hit.furniture.name
      : hit.terrain.name;
    return {
      kind, name, x: hit.x, y: hit.y, z: hit.z, dist: hit.dist, hit,
      terrain: hit.terrain.id, furniture: hit.furniture?.id !== 'f_null' ? hit.furniture?.id : undefined, creature: hit.creature,
    };
  };

  return {
    pick,
    fromHit,
    current: () => cur,
    update(x: number, y: number) {
      cur = pick(x, y);
      if (!cur || cur.kind === 'ceiling') return this.clear();
      // A tall box for things you bump into, a flat one for floors and piles.
      const tall = cur.kind === 'creature' ? 1.8 : cur.kind === 'furniture' ? 1.0 : cur.kind === 'terrain' || cur.kind === 'vehicle' ? LEVEL_HEIGHT : 0.06;
      box.scale.set(1.02, tall, 1.02);
      box.position.set(cur.x + 0.5, cur.z * LEVEL_HEIGHT + tall / 2 + 0.005, cur.y + 0.5);
      box.visible = true;
      label.textContent = cur.name;
      // Mid-drag the ghost says what a drop does; the outline alone shows where.
      label.style.display = dragging() ? 'none' : '';
      label.style.left = `${x}px`;
      label.style.top = `${y}px`;
    },
    clear() {
      cur = null;
      box.visible = false;
      label.style.display = 'none';
    },
  };
}

function itemName(it: unknown): string {
  const i = it as { name?: () => string; typeId: string };
  return typeof i.name === 'function' ? i.name() : i.typeId;
}
