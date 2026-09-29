import type { CraftHost } from '../game/crafting';
import { formatDuration } from '../game/crafting';
import { canDisassemble, disassemblables, disassemblyYield, startDisassembly, uncraftRecipe } from '../game/disassembly';
import type { Item } from '../game/item';
import { bookData, bookMastery, cantRead, efileDevice, readableBooks, startReading, timeToRead } from '../game/reading';
import { itemDisplayName, requirementLines } from '../game/requirements';
import { cddaText } from '../game/units';
import { c, colorize, openMenu } from './framework';
import type { Game } from '../game/game';
import './crafting.css';

// Smaller CDDA menus: `R` read (pick a book) and `(` disassemble (pick an item). The
// activity progress bar is the HUD's (src/ui/hud.ts).

export function openReadMenu(game: CraftHost): void {
  const books = readableBooks(game);
  if (!books.length) {
    game.message("You have nothing to read.", 'c_light_gray');
    return;
  }
  const p = game.player;
  openMenu<Item>({
    title: 'Read what?',
    detailPane: true,
    width: 'min(96ch, 94vw)',
    entries: books.map((b) => {
      const why = cantRead(game, b);
      const d = bookData(b)!;
      const ident = p.identifiedBooks.has(b.typeId);
      const dev = efileDevice(game, b);
      const tag = (!ident ? c('c_yellow', ' (unread)') : d.skill ? c('c_cyan', ` (${p.skillName(d.skill)} ${d.req}-${d.level})`) : '') + (dev ? c('c_light_blue', ` [on ${dev.baseName()}]`) : '');
      return {
        label: c(why ? 'c_dark_gray' : 'c_white', b.name()) + tag,
        value: b,
        detail: () => {
          const lines = [`<color_white>${cddaText(b.def.name)}</color>`, cddaText(b.def.description), ''];
          if (!ident) lines.push("You haven't read this yet; the first read is a quick skim.");
          else {
            if (d.skill) {
              const m = bookMastery(p, b);
              lines.push(`Can bring your <color_cyan>${p.skillName(d.skill)}</color> skill to <color_cyan>${d.level}</color>.`);
              if (d.req) lines.push(`Requires <color_cyan>${p.skillName(d.skill)} ${d.req}</color> to understand.`);
              lines.push(`Your skill: <color_cyan>${p.getSkill(d.skill)}</color> (${m.replace('_', ' ')})`);
            }
            if (d.intel) lines.push(`Requires intelligence of <color_cyan>${d.intel}</color> to easily read.`);
            if (d.fun) lines.push(`Reading this book affects your morale by <color_${d.fun > 0 ? 'green' : 'red'}>${d.fun}</color>.`);
          }
          lines.push(`Time to read: <color_cyan>${formatDuration(timeToRead(p, b))}</color>`);
          if (why) lines.push('', `<color_red>${why}</color>`);
          return colorize(lines.join('\n'));
        },
      };
    }),
    onSelect: (b) => {
      startReading(game, b);
    },
  });
}

export function openDisassembleMenu(game: CraftHost): void {
  const list = disassemblables(game);
  if (!list.length) {
    game.message("You don't have anything you could disassemble.", 'c_light_gray');
    return;
  }
  const data = game.data;
  openMenu({
    title: 'Disassemble item:',
    detailPane: true,
    width: 'min(96ch, 94vw)',
    entries: list.map(({ item, where }) => {
      const ch = canDisassemble(game, item);
      return {
        label: c(ch.ok ? 'c_white' : 'c_dark_gray', item.name()) + (where === 'inv' ? '' : c('c_light_gray', ' (nearby)')),
        header: where === 'inv' ? 'INVENTORY' : 'NEARBY',
        value: item,
        detail: () => {
          const r = uncraftRecipe(data, item.typeId)!;
          const lines = [`<color_white>${item.name()}</color>`, '', `Time to disassemble: <color_cyan>${formatDuration(r.time)}</color>`, ''];
          lines.push(...requirementLines(ch.req).filter((l) => !l.includes('Components required')));
          lines.push('<color_white>Yields:</color>');
          for (const y of disassemblyYield(data, r)) lines.push(`> ${y.count} ${itemDisplayName(data, y.id, y.count)}`);
          if (!ch.ok) lines.push('', `<color_red>${ch.missing.join('\n')}</color>`);
          return colorize(lines.join('\n'));
        },
      };
    }),
    onSelect: (it) => {
      startDisassembly(game, it);
    },
  });
}

