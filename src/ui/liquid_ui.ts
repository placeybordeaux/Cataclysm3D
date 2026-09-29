import type { Game } from '../game/game';
import type { Item } from '../game/item';
import { liquidHooks } from '../game/crafting';
import { drinkable, drinkLiquid, liquidTargets, pourInto, pourOnGround, type LiquidHost } from '../game/liquid';
import { c, openMenu } from './framework';

// CDDA's liquid handler menu ("What to do with the clean water?"): pour it into a container
// you choose, drink it from your hands, or pour it out. Used when a craft makes a liquid no
// carried bottle took (boiled water in a pot), and by Unload on a container of liquid.

type Choice = { kind: 'container'; item: Item } | { kind: 'drink' } | { kind: 'ground' };

export interface LiquidMenuOpts {
  /** Container the liquid came out of (not offered as a target). */
  source?: Item;
  /** Esc: default pours it out (a crafted liquid can't stay in limbo). */
  onCancel?: (liquid: Item) => void;
  /** Called once the liquid is fully dealt with. */
  onDone?: () => void;
}

export function openLiquidMenu(host: LiquidHost, liquid: Item, opts: LiquidMenuOpts = {}): void {
  const targets = liquidTargets(host, liquid, opts.source);
  const entries = [
    ...targets.map((t) => ({
      label: `Pour into ${c('c_white', t.item.name())} ${c('c_dark_gray', `(${t.where === 'ground' ? 'nearby' : 'carried'}${t.open ? ', open' : ''}; ${t.room < liquid.charges ? `${t.room} fit` : 'fits'})`)}`,
      value: { kind: 'container', item: t.item } as Choice,
    })),
    ...(drinkable(liquid) ? [{ label: 'Drink from your hands', value: { kind: 'drink' } as Choice }] : []),
    { label: 'Pour onto the ground', value: { kind: 'ground' } as Choice },
  ];
  let chosen = false;
  openMenu<Choice>({
    title: `What to do with the ${liquid.name()}?`,
    width: 'min(70ch, 92vw)',
    entries,
    onSelect: (ch) => {
      chosen = true;
      let left: Item | null = liquid;
      if (ch.kind === 'container') left = pourInto(host, liquid, ch.item);
      else if (ch.kind === 'drink') left = drinkLiquid(host, liquid);
      else {
        pourOnGround(host, liquid);
        left = null;
      }
      // Whatever is left over asks again, like CDDA's handle_all_liquid loop. Deferred so
      // this window is gone before the next opens.
      if (left) setTimeout(() => openLiquidMenu(host, left!, opts), 0);
      else opts.onDone?.();
    },
    onClose: () => {
      if (chosen) return;
      if (opts.onCancel) opts.onCancel(liquid);
      else pourOnGround(host, liquid);
      opts.onDone?.();
    },
  });
}

/**
 * CDDA Unload on a container: liquid goes through the liquid menu (Esc puts it back);
 * solid contents move to your pockets, or the ground when they don't fit.
 */
export function unloadContainer(game: Game, it: Item): boolean {
  const pockets = it.containerPockets().filter((p) => p.contents.length);
  if (!pockets.length) {
    game.message(`The ${it.baseName()} is empty.`);
    return false;
  }
  const p = game.player;
  for (const pk of pockets) {
    for (const inner of [...pk.contents]) {
      pk.remove(inner);
      if (inner.isLiquid()) {
        openLiquidMenu(game, inner, { source: it, onCancel: (l) => void it.put(l) });
        continue;
      }
      const left = p.inv.stash(inner);
      if (left) {
        game.map.addItem(p.tileX, p.tileY, p.z, left);
        game.message(`You put the ${left.name()} on the ground.`);
      } else game.message(`You take the ${inner.name()} out of the ${it.baseName()}.`);
    }
  }
  return true;
}

export function installLiquidUi(): void {
  liquidHooks.handle = (host, liquid) => openLiquidMenu(host, liquid);
}
