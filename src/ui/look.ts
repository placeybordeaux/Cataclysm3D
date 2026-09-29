import * as THREE from 'three';
import type { Item } from '../game/item';
import type { LookCreature } from '../game/game';
import { raycastTiles, type RayHit } from '../game/raycast';
import { cddaText } from '../game/units';
import { c, colorize, openWindow, type UiWindow } from './framework';
import { spriteImg, omtLabel, type UiContext } from './context';
import { CHUNK } from '../world/coords';

// Look mode ('x', CDDA "look around"): the simulation freezes (the window captures input,
// which pauses the game) and a panel describes whatever is under the crosshair — creature,
// furniture, terrain, items, fields, signs. Arrow keys / hjkl turn the view so you can look
// around without resuming.

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
    { maxDist, creatureAt: (x, y, z) => ctx.game.creatureAt(x, y, z), skipOrigin: ctx.renderer.cameraMode === 'first' },
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
  const fields = ctx.game.map.fieldsAt(tx, hit.y, tz);
  for (const f of fields) {
    const def = ctx.game.data.misc?.field_type?.[f.type];
    const names = def?.intensity_levels?.map((l: any) => cddaText(l.name)) ?? [];
    L.push(c('c_light_red', names[f.intensity - 1] || names[0] || f.type));
  }
  const items = ctx.game.map.itemsAt(tx, hit.y, tz) as Item[];
  if (items.length) {
    L.push('', c('c_light_gray', items.length === 1 ? 'There is an item here:' : `There are ${items.length} items here:`));
    for (const it of items.slice(0, 10)) L.push(`  ${spriteImg(ctx.renderer, it.typeId)}${c('c_white', it.name())}`);
    if (items.length > 10) L.push(c('c_dark_gray', `  … and ${items.length - 10} more`));
  }
  const chunk = ctx.game.map.chunk(Math.floor(tx / CHUNK), Math.floor(hit.y / CHUNK), tz);
  const li = ((hit.y % CHUNK) + CHUNK) % CHUNK * CHUNK + (((tx % CHUNK) + CHUNK) % CHUNK);
  const sign = chunk?.signs.get(li);
  if (sign) L.push('', `${c('c_light_gray', 'The sign reads:')} ${c('c_white', sign)}`);
  const graf = chunk?.graffiti.get(li);
  if (graf) L.push('', `${c('c_light_gray', 'Written here:')} ${c('c_white', graf)}`);
  L.push('', c('c_dark_gray', `${dist} tile${dist === 1 ? '' : 's'} away  (${hit.x}, ${hit.y}, ${hit.z})`));
  const om = omtLabel(ctx, Math.floor(hit.x / CHUNK), Math.floor(hit.y / CHUNK), hit.z);
  if (om) L.push(c('c_dark_gray', `in: ${om.name}${om.city ? `, ${om.city}` : ''}`));
  return L.join('\n');
}

export function openLookMode(ctx: UiContext): UiWindow {
  const p = ctx.game.player;
  const STEP = (4 * Math.PI) / 180;
  let raf = 0;
  const w = openWindow({
    title: 'Look Around',
    anchor: 'left',
    width: 'min(56ch, 44vw)',
    footer: `${c('c_light_green', '←→↑↓')}/${c('c_light_green', 'hjkl')} turn  ${c('c_light_green', 'Esc')}/${c('c_light_green', 'x')} done`,
    onKey: (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'h') p.yaw -= STEP;
      else if (k === 'ArrowRight' || k === 'l') p.yaw += STEP;
      else if (k === 'ArrowUp' || k === 'k') p.pitch = Math.min(1.5, p.pitch + STEP);
      else if (k === 'ArrowDown' || k === 'j') p.pitch = Math.max(-1.5, p.pitch - STEP);
      else if (k === 'x') w.close();
      else return false;
      return true;
    },
    onClose: () => cancelAnimationFrame(raf),
  });
  w.el.style.top = '8vh';
  w.el.classList.add('look-panel');
  let last = '';
  const tick = () => {
    raf = requestAnimationFrame(tick);
    const html = describeHit(ctx, ctx.game.lookAt());
    if (html !== last) w.body.innerHTML = last = html;
  };
  tick();
  return w;
}
