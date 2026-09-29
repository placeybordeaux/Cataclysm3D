import type { Game } from '../game/game';
import type { Item } from '../game/item';
import { liquidHooks } from '../game/crafting';
import { drinkable, drinkLiquid, liquidTargets, pourInto, pourOnGround, type LiquidHost } from '../game/liquid';
import { isAt, L, type Loc } from '../game/moves';
import { c, openMenu } from './framework';

// BN's liquid handler menu ("What to do with the clean water?"): pour it into a container
// you choose, drink it from your hands, or pour it out. Used when a craft makes a liquid no
// carried bottle took (boiled water in a pot), and by Unload on a container of liquid.
//
// The liquid is either new (a crafting result, `from` null) or still sitting in its container
// (`from` = L.in(container)): nothing leaves it until a choice moves it, so closing the menu
// leaves it where it was — there is no limbo in which it could be lost or duplicated.

type Choice = { kind: 'container'; item: Item } | { kind: 'drink' } | { kind: 'ground' };

export interface LiquidMenuOpts {
  /** Where the liquid is (null: a new liquid that must end up somewhere). */
  from?: Loc | null;
  /** Container the liquid came out of (not offered as a target). */
  source?: Item;
  /** Called once the liquid is fully dealt with (or left where it was). */
  onDone?: () => void;
}

export function openLiquidMenu(host: LiquidHost, liquid: Item, opts: LiquidMenuOpts = {}): void {
  const from = opts.from ?? null;
  const targets = liquidTargets(host, liquid, opts.source, from);
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
      // A stale menu (the liquid moved meanwhile) must not act on it again.
      if (from && !isAt(liquid, from)) return opts.onDone?.();
      let left: Item | null = liquid;
      if (ch.kind === 'container') left = pourInto(host, liquid, ch.item, from);
      else if (ch.kind === 'drink') left = drinkLiquid(host, liquid, from);
      else {
        pourOnGround(host, liquid, from);
        left = null;
      }
      // Whatever is left over asks again, like BN's handle_all_liquid loop. Deferred so
      // this window is gone before the next opens.
      if (left) setTimeout(() => openLiquidMenu(host, left!, opts), 0);
      else opts.onDone?.();
    },
    onClose: () => {
      if (chosen) return;
      // Esc: a liquid in its container stays there; a new one can't stay in limbo.
      if (!from) pourOnGround(host, liquid, null);
      opts.onDone?.();
    },
  });
}

/**
 * BN Unload on a container: solid contents go to your inventory, else your feet; liquid gets
 * the liquid menu and stays in the container until you choose.
 */
export function unloadContainer(game: Game, it: Item): boolean {
  if (!it.hasContents()) {
    game.message(`The ${it.baseName()} is already empty!`);
    return false;
  }
  const r = game.player.inv.unload(it);
  for (const liquid of r.liquids) openLiquidMenu(game, liquid, { from: L.in(it), source: it });
  return r.ok || r.liquids.length > 0;
}

export function installLiquidUi(): void {
  liquidHooks.handle = (host, liquid) => openLiquidMenu(host, liquid);
}
