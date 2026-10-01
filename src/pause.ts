import type { Game } from './game/game';
import type { DebugApi } from './debug';
import { tacticalPauseOf, type TacticalPause } from './game/pause';
import { Keys } from './ui/keys';
import { hud } from './ui/hud';

// Tactical pause wiring (state machine in src/game/pause.ts): the `tactical_pause` key
// (default ` and Pause/Break; Space is the side-step), which also works inside menus and ui2
// windows, and the PAUSED banner. While paused the world is frozen but you can look around
// (mouse-look keeps working) and open any window.

export function installTacticalPause(game: Game, api?: DebugApi): TacticalPause {
  const tp = tacticalPauseOf(game);
  const toggle = () => {
    if (game.player.dead || game.paused) return;
    tp.toggle();
  };
  game.keys.register('tactical_pause', 'Tactical pause (freeze time; look around, use menus)', toggle);
  // In gameplay the binding above runs; inside a menu (legacy or ui2) keys go to the menu, so
  // the same keys are caught first here. Not while a key-binding screen waits for a key.
  game.input.onPriorityPress?.((e) => {
    if (!game.input.captured || Keys.rebinding > 0 || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
    if (!game.keys.keysFor('tactical_pause').includes(e.key)) return false;
    toggle();
    return true;
  });
  game.events.on('playerDied', () => tp.clear());

  // The PAUSED banner lives in the HUD's status banner slot (top centre, under the compass).
  // A menu's own pause is a small note (the window says so itself); the player's pause is big.
  const draw = () => {
    // (the load gate's hold shows its own loading screen / note: src/loadgate/install.ts)
    const onlyLoading = !tp.manual && tp.reasons().every((r) => r === 'loading');
    if (!tp.paused || game.player.dead || onlyLoading) return hud.setBanner('pause', null);
    const key = game.keys.label('tactical_pause');
    hud.setBanner('pause', tp.manual
      ? { text: 'PAUSED', sub: `${key} to resume · look around, open any menu`, tone: 'warn' }
      : { text: 'Paused', tone: 'info', small: true });
  };
  tp.onChange(draw);
  const prevChange = game.keys.onChange;
  game.keys.onChange = () => {
    prevChange?.();
    draw();
  };
  draw();

  if (api)
    Object.assign(api, {
      tacticalPause: () => ({ paused: tp.paused, manual: tp.manual, reasons: tp.reasons(), gamePaused: game.tacticalPause }),
      toggleTacticalPause: () => tp.toggle(),
    });
  return tp;
}
