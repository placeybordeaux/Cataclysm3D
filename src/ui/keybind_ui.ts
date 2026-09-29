import type { Game } from '../game/game';
import { h, confirmModal, type Panel } from '../ui2';
import { openScreen } from './screen2';
import { addBinding, applyBinding, checkBinding, keyLabel } from './keymap';

// Options > Key bindings (CDDA's keybinding screen, reduced; a ui2 window): every action with
// its keys. Enter (or a click on the selected row) waits for a new key and replaces the action's
// keys with it, + adds an extra key, - unbinds, R resets everything. Movement keys, Space/Shift
// and the keys every menu uses are refused with the reason; a key another action has is moved
// after a yes/no. Changes apply at once and persist (src/ui/keys.ts setBindings → localStorage).

export function openKeybindings(game: Game): Panel {
  const keys = game.keys;
  const actions = keys.actionList();
  let sel = 0;
  /** Waiting for a key: 'set' replaces, 'add' appends. */
  let capturing: null | 'set' | 'add' = null;
  let flash: { text: string; tone: string } | null = null;
  let busy = false;

  const win = openScreen(game, {
    id: 'scr.keys',
    title: 'Key bindings',
    group: 'scr.keys',
    pauses: 'always',
    width: 'min(calc(var(--fs) * 40), 94vw)',
    height: 'min(calc(var(--fs) * 34), 90vh)',
    closeLabel: 'done',
    legend: [['↑↓', 'move'], ['Enter', 'rebind'], ['+', 'add key'], ['-', 'unbind'], ['R', 'reset all']],
    onKey: (e) => {
      if (busy) return true;
      if (capturing) {
        if (e.repeat) return true;
        if (e.key === 'Escape') {
          capturing = null;
          flash = null;
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

  const status = h('div', { class: 'kb-status', attrs: { 'data-testid': 'keys-status' } });
  const list = h('div', { class: 'ui2-list', attrs: { 'data-testid': 'keys-list' } });
  list.style.flex = '1';
  win.body.append(status, list);
  win.body.style.overflow = 'hidden';

  function move(d: number) {
    sel = Math.max(0, Math.min(actions.length - 1, sel + d));
    flash = null;
    render();
  }
  function start(mode: 'set' | 'add') {
    if (actions[sel].id === 'menu') {
      flash = { text: 'The menu stays on Esc, so there is always a way out.', tone: 'bad' };
      return render();
    }
    capturing = mode;
    flash = null;
    render();
  }
  function unbind() {
    const a = actions[sel];
    if (a.id === 'menu') return;
    const b = keys.bindings();
    b[a.id] = [];
    keys.setBindings(b);
    flash = { text: `${a.name} is now unbound.`, tone: 'warn' };
    render();
  }
  async function resetAll() {
    busy = true;
    const yes = await confirmModal({ title: 'Reset key bindings', body: 'Reset every key binding to the defaults?', ok: 'Reset', danger: true });
    busy = false;
    if (!yes) return;
    keys.resetBindings();
    flash = { text: 'All keys reset to the defaults.', tone: 'good' };
    render();
  }
  async function bind(e: KeyboardEvent, mode: 'set' | 'add') {
    // Bare modifier presses: keep waiting for the real key (Shift+o arrives as Shift, then O).
    if (['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock'].includes(e.key)) return;
    const a = actions[sel];
    const b = keys.bindings();
    const chk = checkBinding(b, a.id, { key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, altGraph: e.getModifierState?.('AltGraph') }, keys.blockedChars());
    if (!chk.ok) {
      flash = { text: chk.message, tone: 'bad' };
      capturing = null;
      return render();
    }
    capturing = null;
    if (chk.replaces) {
      const other = actions.find((x) => x.id === chk.replaces)?.name ?? chk.replaces;
      busy = true;
      render();
      const yes = await confirmModal({ title: 'Key already used', body: `${keyLabel(e.key)} is already used by ${other}. Use it for ${a.name} instead?`, ok: 'Use it' });
      busy = false;
      if (!yes) {
        flash = { text: 'Nothing changed.', tone: 'dim' };
        return render();
      }
    }
    keys.setBindings(mode === 'set' ? applyBinding(b, a.id, e.key) : addBinding(b, a.id, e.key));
    const moved = chk.replaces ? `   (${actions.find((x) => x.id === chk.replaces)?.name ?? chk.replaces}: ${keysText(chk.replaces)})` : '';
    flash = { text: `${a.name}: ${keysText(a.id)}${moved}`, tone: 'good' };
    render();
  }
  function keysText(id: string): string {
    const ks = keys.bindings()[id] ?? [];
    return ks.length ? ks.map(keyLabel).join(' ') : 'unbound';
  }

  function render() {
    const unreachable = new Set(keys.unreachable());
    const blocked = keys.blockedChars();
    const b = keys.bindings();
    status.replaceChildren(
      flash
        ? h('span', { class: `tone-${flash.tone}`, text: flash.text })
        : capturing
          ? h('span', { class: 'tone-warn', text: `Press the new key for "${actions[sel].name}" (Esc cancels)` })
          : h('span', { class: 'ui2-dim', text: `Movement: ${keys.movementKeys()} + Shift (run) + Space; those keys never trigger actions.` }),
    );
    list.replaceChildren(
      ...actions.map((a, i) => {
        const ks = b[a.id] ?? [];
        // Layout stand-ins (AZERTY's w for wield) aren't the player's binding but do work: show them.
        const standIns = keys.keysFor(a.id).filter((k) => !ks.includes(k));
        const on = i === sel;
        const chips = on && capturing
          ? [h('span', { class: 'kb-key wait', text: 'press a key' })]
          : ks.length
            ? [
                ...ks.map((k) => h('span', { class: `kb-key${blocked.has(k) ? ' blocked' : ''}`, text: blocked.has(k) ? `${keyLabel(k)} (movement)` : keyLabel(k) })),
                ...standIns.map((k) => h('span', { class: 'kb-key layout', text: `${keyLabel(k)} (layout)` })),
              ]
            : [h('span', { class: 'kb-key none', text: 'unbound' })];
        const warn = ks.length && unreachable.has(a.id) ? h('span', { class: 'ui2-small tone-bad', text: '  no usable key on this layout' }) : '';
        const row = h('div', { class: `ui2-list-row kb-row${on ? ' selected' : ''}`, data: { i: String(i) } }, h('span', null, h('span', { text: a.name }), warn), h('span', { class: 'kb-keys' }, ...chips));
        row.addEventListener('click', () => {
          if (busy) return;
          if (sel === i && !capturing) start('set');
          else (sel = i), (capturing = null), (flash = null), render();
        });
        return row;
      }),
    );
    (list.querySelector('.selected') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }
  render();
  return win;
}
