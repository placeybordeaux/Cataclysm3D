import type { Game } from './game/game';
import type { DebugApi } from './debug';
import { tacticalPauseOf, type TacticalPause } from './game/pause';
import { Keys } from './ui/keys';

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

  if (typeof document !== 'undefined') {
    const el = document.createElement('div');
    el.className = 'tactical-pause-banner';
    Object.assign(el.style, {
      position: 'fixed', left: '50%', top: '9vh', transform: 'translateX(-50%)', zIndex: '40', pointerEvents: 'none',
      font: '600 22px/1.2 var(--font, monospace)', letterSpacing: '0.35em', color: '#ffe066', textAlign: 'center',
      padding: '6px 18px 7px 24px', background: 'rgba(0,0,0,0.62)', border: '1px solid rgba(255,224,102,0.55)',
      textShadow: '1px 1px 0 #000', display: 'none',
    } as Partial<CSSStyleDeclaration>);
    const sub = document.createElement('div');
    Object.assign(sub.style, { font: '400 13px/1.3 var(--font, monospace)', letterSpacing: '0.05em', color: '#d8d8d8', marginTop: '2px' });
    const title = document.createElement('div');
    el.append(title, sub);
    document.body.appendChild(el);
    const draw = () => {
      el.style.display = tp.paused && !game.player.dead ? '' : 'none';
      if (!tp.paused) return;
      const key = game.keys.label('tactical_pause');
      title.textContent = 'PAUSED';
      // A menu's own pause is small (the window says so itself); the player's pause is big.
      sub.textContent = tp.manual ? `${key} to resume · look around, open any menu` : '';
      sub.style.display = tp.manual ? '' : 'none';
      title.style.fontSize = tp.manual ? '' : '13px';
      el.style.top = tp.manual ? '9vh' : '1.2vh';
    };
    tp.onChange(draw);
    const prevChange = game.keys.onChange;
    game.keys.onChange = () => {
      prevChange?.();
      draw();
    };
    draw();
  }

  if (api)
    Object.assign(api, {
      tacticalPause: () => ({ paused: tp.paused, manual: tp.manual, reasons: tp.reasons(), gamePaused: game.tacticalPause }),
      toggleTacticalPause: () => tp.toggle(),
    });
  return tp;
}
