import type { Game } from './game';
import type { Item } from './item';
import { useActions } from './inventory';
import { bodyLight, itemLight } from './vision';

// Portable light: the renderer's flashlight follows the player's shining item. Turning a
// flashlight on/off is CDDA's `transform` use_action (flashlight ↔ flashlight_on), handled
// by inv.use(); battery drain is Inventory.update (power_draw / turns_per_charge), which
// reverts the item when the charge runs out. Here we only
//   - pick the item the `F` key toggles
//   - report what should shine (directional flashlight vs an all-round lantern glow)

/** The item's `light` once turned on (via its transform target), for off-state items. */
export function lightWhenOn(game: Game, it: Item): number {
  const own = Number(it.def.light ?? 0);
  if (own > 0) return own;
  for (const ua of useActions(it.def)) {
    if (ua.type !== 'transform' || typeof ua.target !== 'string') continue;
    const t = game.data.items[ua.target];
    const l = Number(t?.light ?? 0);
    if (l > 0) return l;
  }
  return 0;
}

/** Carried items that give light when on (flashlights, lanterns, headlamps…), best first. */
export function lightItems(game: Game): Item[] {
  return game.player.inv.allItems()
    .filter((it) => lightWhenOn(game, it) > 0 && useActions(it.def).some((u) => u.type === 'transform'))
    .sort((a, b) => lightWhenOn(game, b) - lightWhenOn(game, a));
}

/** What the player's light looks like right now. */
export function playerLightState(game: Game): { on: boolean; lum: number; directional: boolean; item: Item | null } {
  let best: Item | null = null, lum = 0;
  for (const it of game.player.inv.allItems()) {
    const l = itemLight(it);
    if (l > lum) (lum = l), (best = it);
  }
  // Flashlights/headlamps throw a beam; lamps, lanterns and candles glow all round.
  const directional = !!best && !best.hasFlag('FIRE') && !/lamp|lantern|candle|torch/.test(best.typeId);
  // A bionic light (Cranial Flashlight) competes with carried ones.
  const body = bodyLight(game);
  if (body && body.lum > lum) return { on: true, lum: body.lum, directional: body.directional, item: null };
  return { on: lum > 0, lum, directional, item: best };
}

/** `F`: toggle the best light item via its transform use_action. */
export function toggleLight(game: Game): boolean {
  const items = lightItems(game);
  const lit = items.find((it) => itemLight(it) > 0);
  const target = lit ?? items[0];
  if (!target) {
    game.message("You don't have a light source.", 'c_light_gray');
    return false;
  }
  // A smartphone's first use_action is the e-book reader; the light is its `transform`
  // ("Turn on flashlight"), so aim for that action explicitly.
  const idx = useActions(target.def).findIndex((u) => u.type === 'transform');
  return game.player.inv.use(target, undefined, Math.max(0, idx)).ok;
}
