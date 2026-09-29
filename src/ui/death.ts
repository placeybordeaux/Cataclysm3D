import { sfx } from '../audio/sfx';
import { reloadPage } from '../core/unload';
import { c, colorize, getUiRoot } from './framework';
import { durationText, logLine } from './format';
import type { Hud } from './hud';
import type { UiContext } from './context';
import { achievementsOf } from '../achievements';
import { GameClock } from '../core/time';
import { saveHandle } from '../save/install';

// Death: CDDA's end screen (end_screen.json "death_tombstone" over the ascii_tombstone
// picture, with name / time survived / kills stamped onto the stone), then the memorial
// summary (cause of death, kills by monster, distance, last messages) and a way back to the
// main menu.

/** Stamp CDDA's added_info lines onto the tombstone picture at their [x, y] positions. */
export function stampTombstone(picture: string[], info: [[number, number], string][], vars: Record<string, string>): string[] {
  // The picture's color tags only occur near the bottom (grass), below the stamped rows, so
  // splicing by column is safe on untagged rows; tagged rows are left alone.
  const rows = [...picture];
  for (const [[x, y], tmpl] of info) {
    const text = tmpl.replace(/<([a-z_]+)>/g, (m, k: string) => vars[k] ?? m);
    const row = rows[y];
    if (row === undefined || /<color_/.test(row)) continue;
    const plain = text.replace(/<\/?color[^>]*>/g, '');
    let stamp = text;
    let at = x;
    // Keep long untagged values ("Survived: 1 hour and 57 minutes") inside the stone: slide
    // left to end before the right border, and clip only if even that doesn't fit.
    const border = row.trimEnd().length - 1;
    if (plain === text && border > x && x + plain.length > border - 1) {
      at = Math.max(1, border - 1 - plain.length);
      stamp = plain.slice(0, border - 1 - at);
    }
    const len = stamp === text ? plain.length : stamp.length;
    const padded = row.padEnd(at + len);
    rows[y] = padded.slice(0, at) + stamp + padded.slice(at + len);
  }
  return rows;
}

export function showDeathScreen(ctx: UiContext, hud: Hud, cause: string, diedAt = ctx.game.clock.seconds): void {
  const { game } = ctx;
  const p = game.player;
  sfx.playerDeath(!p.male);
  const survived = durationText(diedAt - game.stats.startSeconds);
  const deathClock = Object.assign(new GameClock(), { seconds: diedAt });
  const kills = game.stats.totalKills();
  const vars = { u_name: p.name, time_survived: survived, total_kills: String(kills) };
  const art = stampTombstone(ctx.data.tombstone.picture, ctx.data.tombstone.added_info, vars);

  const root = getUiRoot();
  const el = document.createElement('div');
  el.className = 'screen black death-screen';
  el.style.opacity = '0';
  el.style.transition = 'opacity 1.5s';
  const killRows = Object.entries(game.stats.kills).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([id, n]) => `  ${c('c_white', String(n).padStart(3))} ${c('c_light_gray', ctx.game.data.monsters[id]?.name ?? id)}`);
  const lastMsgs = hud.log.recent(10).map((e) => `  ${colorize(`<color_${(e.color ?? 'c_light_gray').replace(/^c_/, '')}>${logLine(e)}</color>`)}`);
  const summary = [
    c('c_light_red', 'In memory of ') + c('c_white', p.name),
    '',
    `${c('c_light_gray', 'Cause of death:')} ${c('c_red', cause)}`,
    `${c('c_light_gray', 'Survived:')} ${c('c_white', survived)}  ${c('c_dark_gray', `(${deathClock.format()})`)}`,
    ctx.build ? `${c('c_light_gray', 'Profession:')} ${c('c_white', ctx.build.profession)}   ${c('c_light_gray', 'Scenario:')} ${c('c_white', ctx.build.scenario)}` : '',
    '',
    `${c('c_light_gray', 'Kills:')} ${c('c_white', String(kills))}`,
    ...(killRows.length ? killRows : [c('c_dark_gray', '  You were a pacifist.')]),
    '',
    `${c('c_light_gray', 'Distance walked:')} ${c('c_white', `${(game.stats.distanceWalked / 1000).toFixed(2)} km`)}`,
    `${c('c_light_gray', 'Items crafted:')} ${c('c_white', String(game.stats.itemsCrafted))}`,
    '',
    ...achievementLines(ctx),
    c('c_light_gray', 'Last messages:'),
    ...lastMsgs,
  ].join('\n');
  el.innerHTML = `<div style="display:flex;gap:4ch;justify-content:center;align-items:flex-start;padding:4vh 2vw;height:100%;box-sizing:border-box;overflow:auto">
      <div class="pre">${colorize(art.join('\n'))}\n\n${c('c_light_gray', ctx.data.tombstone.last_words_label ?? 'Last Words:')} <input class="last-words" maxlength="60" style="background:#000;color:var(--c-white);border:0;border-bottom:1px solid var(--c-dark_gray);font:inherit;width:30ch"></div>
      <div class="pre">${summary}\n\n\n${c('c_yellow', 'Type your last words if you like, then press Enter to return to the main menu.')}</div>
    </div>`;
  root.appendChild(el);
  requestAnimationFrame(() => (el.style.opacity = '1'));
  hud.setVisible(false);
  const input = el.querySelector('.last-words') as HTMLInputElement;
  // Typing goes straight into the last words (they used to need a click first).
  setTimeout(() => input.focus(), 1600);
  const release = game.input.capture((e) => {
    if (e.key === 'Enter') {
      release();
      // CDDA returns to the main menu; a fresh page load is our main menu with a new world.
      reloadPage();
    }
    return true;
  });
  input.onkeydown = (e) => {
    e.stopPropagation();
    // A movement key still held from the fight would auto-repeat into the field.
    if (e.repeat) return e.preventDefault();
    if (e.key === 'Enter') {
      release();
      const words = input.value.trim();
      const saved = words ? saveHandle(game)?.manager.setLastWords(words) : undefined;
      // Reload once the memorial entry has them (or right away if saving isn't available).
      void Promise.resolve(saved).catch(() => {}).finally(() => reloadPage());
    }
  };
  (window as any).cdda && ((window as any).cdda.deathScreen = el);
}

/** Achievements completed during this life (CDDA lists them in the memorial file). */
function achievementLines(ctx: UiContext): string[] {
  const done = achievementsOf(ctx.game)?.completedThisRun() ?? [];
  if (!done.length) return [];
  return [c('c_light_gray', 'Achievements:'), ...done.slice(0, 10).map((a) => `  ${c('c_light_green', a.name)}`), ...(done.length > 10 ? [c('c_dark_gray', `  and ${done.length - 10} more`)] : []), ''];
}
