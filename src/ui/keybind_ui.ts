import type { Game } from '../game/game';
import { c, confirm, legendKey, openWindow, type UiWindow } from './framework';
import { addBinding, applyBinding, checkBinding, keyLabel } from './keymap';
import { Keys } from './keys';

// Options > Key bindings (CDDA's keybinding screen, reduced): every action with its keys.
// Enter (or a click) waits for a new key and replaces the action's keys with it, + adds an
// extra key, - unbinds, R resets everything. Movement keys, Space/Shift and the keys every
// menu uses are refused with the reason; a key another action has is moved after a yes/no.
// Changes apply at once and persist (src/ui/keys.ts setBindings → localStorage).

export function openKeybindings(game: Game): UiWindow {
  const keys = game.keys;
  const actions = keys.actionList();
  let sel = 0;
  /** Waiting for a key: 'set' replaces, 'add' appends. */
  let capturing: null | 'set' | 'add' = null;
  let flash = '';
  let busy = false;

  const footer = () =>
    capturing
      ? `${c('c_yellow', `Press the new key for "${actions[sel].name}"`)}  ${legendKey('Esc', 'cancel')}`
      : `${legendKey('↑↓', 'move')}  ${legendKey('Enter', 'rebind')}  ${legendKey('+', 'add key')}  ${legendKey('-', 'unbind')}  ${legendKey('R', 'reset all')}`;

  Keys.rebinding++;
  const win = openWindow({
    title: 'Key bindings',
    width: 'min(90ch, 94vw)',
    height: '86vh',
    closeLabel: 'done',
    closeOnOpenKey: false,
    // Any key may be the new binding: global keys (tactical pause) stand down meanwhile.
    onClose: () => void Keys.rebinding--,
    onKey: (e) => {
      if (busy) return true;
      if (capturing) {
        if (e.repeat) return true;
        if (e.key === 'Escape') {
          capturing = null;
          flash = '';
          render();
          return true;
        }
        void bind(e, capturing);
        return true;
      }
      const k = e.key;
      if (k === 'ArrowDown' || k === 'j') move(1);
      else if (k === 'ArrowUp' || k === 'k') move(-1);
      else if (k === 'PageDown') move(10);
      else if (k === 'PageUp') move(-10);
      else if (k === 'Home') move(-1e9);
      else if (k === 'End') move(1e9);
      else if (k === 'Enter') start('set');
      else if (k === '+' || k === '=') start('add');
      else if (k === '-' || k === 'Delete') unbind();
      else if (k === 'R') void resetAll();
      else return false;
      return true;
    },
  });

  const list = document.createElement('div');
  const status = document.createElement('div');
  status.className = 'pre';
  status.style.minHeight = '2.4em';
  status.style.whiteSpace = 'pre-wrap';
  win.body.append(status, list);

  function move(d: number) {
    sel = Math.max(0, Math.min(actions.length - 1, sel + d));
    flash = '';
    render();
  }
  function start(mode: 'set' | 'add') {
    if (actions[sel].id === 'menu') {
      flash = c('c_light_red', 'The menu stays on Esc, so there is always a way out.');
      return render();
    }
    capturing = mode;
    flash = '';
    render();
  }
  function unbind() {
    const a = actions[sel];
    if (a.id === 'menu') return;
    const b = keys.bindings();
    b[a.id] = [];
    keys.setBindings(b);
    flash = c('c_yellow', `${a.name} is now unbound.`);
    render();
  }
  async function resetAll() {
    busy = true;
    const yes = await confirm('Reset every key binding to the defaults?');
    busy = false;
    if (!yes) return;
    keys.resetBindings();
    flash = c('c_light_green', 'All keys reset to the defaults.');
    render();
  }
  async function bind(e: KeyboardEvent, mode: 'set' | 'add') {
    // Bare modifier presses: keep waiting for the real key (Shift+o arrives as Shift, then O).
    if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'].includes(e.key)) return;
    const a = actions[sel];
    const b = keys.bindings();
    const chk = checkBinding(b, a.id, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, altGraph: e.getModifierState?.('AltGraph') }, keys.blockedChars());
    if (!chk.ok) {
      flash = c('c_light_red', chk.message);
      capturing = null;
      return render();
    }
    capturing = null;
    if (chk.replaces) {
      const other = actions.find((x) => x.id === chk.replaces)?.name ?? chk.replaces;
      busy = true;
      render();
      const yes = await confirm(`${c('c_yellow', keyLabel(e.key))} is already used by <color_white>${other}</color>.  Use it for <color_white>${a.name}</color> instead?`);
      busy = false;
      if (!yes) {
        flash = c('c_light_gray', 'Nothing changed.');
        return render();
      }
    }
    keys.setBindings(mode === 'set' ? applyBinding(b, a.id, e.key) : addBinding(b, a.id, e.key));
    flash = c('c_light_green', `${a.name}: ${keysText(a.id)}`) + (chk.replaces ? c('c_yellow', `   (${actions.find((x) => x.id === chk.replaces)?.name ?? chk.replaces}: ${keysText(chk.replaces)})`) : '');
    render();
  }
  function keysText(id: string): string {
    const ks = keys.bindings()[id] ?? [];
    return ks.length ? ks.map(keyLabel).join(' ') : 'unbound';
  }

  function render() {
    win.setFooter(footer());
    const unreachable = new Set(keys.unreachable());
    const blocked = keys.blockedChars();
    const b = keys.bindings();
    status.innerHTML = flash || c('c_dark_gray', `Movement: ${keys.movementKeys()} + Shift (run) + Space; those keys never trigger actions.`);
    list.innerHTML = actions
      .map((a, i) => {
        const ks = b[a.id] ?? [];
        // Layout stand-ins (AZERTY's w for wield) aren't the player's binding but do work: show them.
        const standIns = keys.keysFor(a.id).filter((k) => !ks.includes(k));
        const shown = ks.length
          ? [
              ...ks.map((k) => (blocked.has(k) ? c('c_dark_gray', `${keyLabel(k)}(movement)`) : c('c_yellow', keyLabel(k)))),
              ...standIns.map((k) => c('c_light_cyan', `${keyLabel(k)}(layout)`)),
            ].join(' ')
          : c('c_red', 'unbound');
        const warn = ks.length && unreachable.has(a.id) ? c('c_light_red', '  ← no usable key on this layout') : '';
        const name = a.name.length > 44 ? a.name.slice(0, 43) + '…' : a.name;
        const on = i === sel;
        const keyCell = on && capturing ? c('c_yellow', '<press a key>') : shown;
        return `<div class="menu-entry${on ? ' sel' : ''}" data-i="${i}">${c(on ? 'c_white' : 'c_light_gray', name.padEnd(46))}${keyCell}${warn}</div>`;
      })
      .join('');
    list.querySelectorAll<HTMLElement>('.menu-entry').forEach((row) => {
      const i = Number(row.dataset.i);
      row.onclick = () => {
        if (busy) return;
        if (sel === i && !capturing) start('set');
        else (sel = i), (capturing = null), (flash = ''), render();
      };
    });
    (list.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }
  render();
  return win;
}
