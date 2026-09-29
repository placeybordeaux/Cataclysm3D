// Progression on the death screen (src/ui/death.ts): what this life unlocked, and the
// closest next unlocks with progress, so dying reads as "here's what's next" (CDDA-style
// curses markup, like the rest of that screen).

import type { Game } from '../game/game';
import { c } from '../ui/framework';
import { progressionOf } from './registry';
import { nextUp, progressLines, type UnlockDef } from './unlocks';

export function deathLines(game: Game): string[] {
  const prog = progressionOf(game);
  if (!prog) return [];
  const out: string[] = [];
  const got = prog.run.unlocked.map((id) => prog.catalogue.unlocks.find((u) => u.id === id)).filter((u): u is UnlockDef => !!u);
  if (got.length) {
    out.push(c('c_light_gray', 'Unlocked in this life:'));
    for (const u of got) out.push(`  ${c('c_light_green', u.name)}  ${c('c_dark_gray', u.kind === 'cosmetic' ? '(title)' : u.kind === 'scenario' ? '(scenario)' : '(new start)')}`);
    out.push('');
  }
  const next = nextUp(prog.catalogue, prog.env, (id) => prog.profile.isUnlocked(id), 3, prog.achName);
  if (next.length) {
    out.push(c('c_light_gray', 'Next unlocks:'));
    for (const { u } of next) {
      const l = progressLines(u, prog.env, prog.achName).find((x) => !x.done);
      out.push(`  ${c('c_white', u.name)}  ${c('c_dark_gray', `${l?.text ?? ''}${l?.count ? `  ${l.count}` : ''}`)}`);
    }
    out.push('');
  }
  return out;
}

/** "Kendra Smith, the Unlucky" when the run has a title. */
export function titledName(game: Game): string {
  const t = progressionOf(game)?.run.title;
  return t ? `${game.player.name}, ${t}` : game.player.name;
}
