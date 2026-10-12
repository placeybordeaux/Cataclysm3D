import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { setModelIconSource } from '../ui2/icons';
import { registerOption } from '../ui/options';
import { buildHeld } from './chars/held';
import { analyseSprite } from './chars/paint';
import { groundHeldClass } from './furniture/groundHeld';
import { framePixels } from './framePixels';
import { heldIconPixels, itemIconState, ITEM_ICON_STYLES, type ItemIconStyle } from './heldIcon';
import type { Renderer } from './renderer';
import { storeVisualPreference } from './visualPreference';

// Wires heldIcon.ts (pure) into ui2's icon lookup, Options and the automation API:
//   cdda.setItemIcons('glyph')   switch live (not persisted; Options persists)
//   cdda.itemIconStats()         icons drawn and their cost
//   cdda.heldIcon(id)            data URL of an item's modelled icon, drawn fresh

/** Cost of the icons drawn so far (cdda.itemIconStats()). */
export const heldIconStats = { built: 0, ms: 0, maxMs: 0 };

/**
 * Feed ui2's icon lookup with held-mesh icons once the world renderer's sprite source is up
 * (the palette comes from the item's own frame, a coloured glyph for these items, exactly as
 * in the hands). ui2 caches per item id, so each icon is drawn once per session (or switch).
 */
export function installHeldIcons(game: Game, renderer: Renderer, api: DebugApi): void {
  const grey = { w: 1, h: 1, data: new Uint8ClampedArray([128, 128, 128, 255]) };
  const draw = (typeId: string): HTMLCanvasElement | null => {
    if (itemIconState.style !== 'model') return null;
    const d = game.data.items[typeId];
    const hc = d ? groundHeldClass(d) : null;
    if (!d || !hc) return null;
    const t0 = performance.now();
    const pal = analyseSprite(framePixels(renderer.source.item(typeId)) ?? grey).pal;
    const img = heldIconPixels(buildHeld(hc.cls, pal, d.volume, hc.variant));
    const c = document.createElement('canvas');
    c.width = img.w;
    c.height = img.h;
    c.getContext('2d')!.putImageData(new ImageData(img.data, img.w, img.h), 0, 0);
    const dt = performance.now() - t0;
    heldIconStats.built++;
    heldIconStats.ms += dt;
    heldIconStats.maxMs = Math.max(heldIconStats.maxMs, dt);
    return c;
  };
  void renderer.ready.then(() => setModelIconSource(draw));
  const set = (s: ItemIconStyle, persist: boolean) => {
    if (!ITEM_ICON_STYLES.includes(s)) throw new Error(`unknown item icon style ${s}: ${ITEM_ICON_STYLES.join('|')}`);
    itemIconState.style = s;
    if (persist) storeVisualPreference('itemicons', s);
    // drop ui2's cached icons; lists opened from now on redraw
    setModelIconSource(draw);
  };
  registerOption({
    category: 'Interface',
    name: 'Icons without art',
    value: () => (itemIconState.style === 'model' ? 'Modelled' : 'Glyph'),
    change: () => set(itemIconState.style === 'model' ? 'glyph' : 'model', true),
    desc: 'Weapons and tools the tileset never drew (the Marlin 1894C, AR-15s...).\nModelled: a pixel picture of the 3D model you hold.\nGlyph: the older look, the item\'s ASCII symbol.',
  });
  const a = api as DebugApi & Record<string, unknown>;
  a.setItemIcons = (s: string) => {
    set(s as ItemIconStyle, false);
    return s;
  };
  a.itemIconStats = () => ({ ...heldIconStats, style: itemIconState.style });
  /** Data URL of an item's modelled icon (null when it doesn't qualify), drawn fresh. */
  a.heldIcon = (typeId: string) => draw(typeId)?.toDataURL() ?? null;
}
