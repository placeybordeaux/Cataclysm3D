import { colorize } from './framework';
import { h, scrollList, type Panel } from '../ui2';
import { openScreen } from './screen2';
import type { UiContext } from './context';
import { keyLabel } from './keymap';

// '?' help: CDDA's help menu (data/core/help.json topics) with two topics of our own in
// front: the key bindings (from game.keys.list(): every registered action, and only those)
// and a short survival primer for the real-time version.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Keys are <keybind:action id> (resolved from DEFAULT_BINDINGS) so the text never goes stale.
const INTRO = `<color_white>Surviving the Cataclysm</color>

The world ended.  Most people turned into shambling, hungry things, and the rest of us are hiding in evac shelters waiting for a rescue that is not coming.  You have what you are wearing and whatever you can scavenge.

<color_light_green>Look after your body.</color>  The figure in the bottom-left corner shows your health per body part (red drops: bleeding, white bands: bandaged, cracks: broken).  The icons next to it are hunger, thirst, sleep, temperature, pain and mood: they stay dim while all is well, light up with a word when something needs attention, and pulse when it's an emergency.  Thirst kills faster than hunger.  With the cursor free (any window open, or <keybind:look>), hover an icon for what to do.

<color_light_green>Scavenge.</color>  Houses, shops and the shelter itself hold food, water, clothing and tools.  Press <keybind:pickup> to pick things up, <keybind:inventory> to look through your stuff, <keybind:wear> to wear clothes and bags (more pockets means more you can carry), <keybind:eat> to eat or drink.

<color_light_green>Pick your fights.</color>  Zombies are slow but numerous and they hear you.  Running (<color_yellow>Shift</color>) burns stamina; running out of it leaves you winded and easy prey.  Wield a real weapon (<keybind:wield>) before you need one.  A crowbar or a pipe beats your fists.

<color_light_green>Rest.</color>  Sleep somewhere safe (<keybind:sleep>), wait out the night (<keybind:wait>), bandage wounds with <keybind:apply>.  Darkness is dangerous; a flashlight (<keybind:flashlight>) helps you see and helps them see you.

<color_light_green>Look around.</color>  <keybind:look> describes whatever is under the crosshair (and frees the cursor so you can point at other things), <keybind:map> shows the map of places you have seen: drag it, zoom with the wheel, right-click to write notes or set a destination for the compass at the top of the screen.  Red marks on the compass are hostiles you can see.

When you die, and you will, the game shows what you accomplished.  Then you start again, a little wiser.`;

const keyName = keyLabel;

/** The key reference: movement, mouse, menus, then every registered action (rebindable). */
function keybindingsEl(ctx: UiContext): HTMLElement {
  const keys = ctx.game.keys;
  const wasd = keys.movementKeys().split('').join(' ');
  const out = h('div', { class: 'hp-keys-wrap' });
  const group = (title: string, rows: [string, string, boolean?][]) => {
    out.append(h('div', { class: 'ui2-section', text: title }));
    out.append(h('div', { class: 'hp-keys' }, ...rows.map(([k, n, bad]) => h('div', { class: 'hp-keyrow' }, h('span', { class: `hp-kbd${bad ? ' unbound' : ''}`, text: k }), h('span', { text: n })))));
  };
  group('Moving and fighting', [
    [wasd, 'Move (forward / left / back / right)'], ['Mouse', 'Look around (click the view to capture the mouse)'], ['Shift', 'Run (uses stamina)'],
    ['Space', 'Side-step / dodge'], ['LMB', 'Attack / fire'], ['RMB', 'Guard (melee) / aim (guns)'], ['Wheel', 'Zoom (top-down camera)'],
  ]);
  group('Windows and menus', [
    ['Click', 'Select; double-click uses'], ['Right-click', 'Every action for an item or object, with its time'], ['Drag', 'Move items between containers, slots and the world'],
    ['Esc', 'Close the top window; in play, the pause menu'], ['Bksp', 'Close (the key that opened a window also closes it)'], ['↑↓ Enter', 'Move and pick in lists'],
  ]);
  const listed = keys.list().sort((a, b) => a[1].localeCompare(b[1]));
  group(`Actions (rebind in Options › Key bindings)`, listed.map(([ks, name]) => [ks.length ? ks.map(keyName).join(' ') : 'unbound', name, !ks.length]));
  out.append(h('div', { class: 'ui2-small ui2-dim', text: `Outside fullscreen the browser frees the mouse on Esc; click the view or press any key to take it back. ${keyName(keys.keyFor('fullscreen'))} fullscreen keeps it captured.` }));
  return out;
}

/** CDDA help strings reference keys as <keybind:action>; show ours where they map. */
function cddaHelpText(ctx: UiContext, messages: string[]): string {
  const map: Record<string, string> = {
    look: 'look', examine: 'interact', pickup: 'pickup', inventory: 'inventory', wear: 'wear', wield: 'wield',
    eat: 'eat', craft: 'craft', construct: 'construct', map: 'map', sleep: 'sleep', reload_weapon: 'reload', open: 'interact',
  };
  return messages
    .map((m) => colorize(m.replace(/<keybind:([a-z_]+)>/g, (_, a: string) => {
      const id = map[a];
      return id ? `<color_yellow>${keyName(ctx.game.keys.keyFor(id))}</color>` : `<color_dark_gray>[${a}]</color>`;
    }).replace(/<(?!\/?color|\/?good|\/?bad|\/?info)[^>]*>/g, '')))
    .join('\n\n');
}

export function openHelp(ctx: UiContext): Panel {
  type Topic = { label: string; render: () => HTMLElement };
  const topics: Topic[] = [
    { label: 'Key bindings', render: () => keybindingsEl(ctx) },
    { label: 'How to survive', render: () => h('div', { class: 'hp-text-inner', html: colorize(INTRO.replace(/<keybind:([a-z_]+)>/g, (_, id: string) => `<color_yellow>${esc(keyName(ctx.game.keys.keyFor(id)))}</color>`)) }) },
    ...ctx.data.help.map((t) => ({ label: t.name.replace(/^<[^>]*>:\s*/, ''), render: () => h('div', { class: 'hp-text-inner', html: cddaHelpText(ctx, t.messages) }) })),
  ];
  const text = h('div', { class: 'hp-text', attrs: { 'data-testid': 'help-text' } });
  const list = scrollList<Topic>({
    items: topics,
    render: (t) => h('div', { text: t.label }),
    onSelect: (t) => show(t),
    onActivate: (t) => show(t),
  });
  list.el.classList.add('hp-topics');
  const panel = openScreen(ctx.game, {
    id: 'scr.help',
    title: 'Help',
    group: 'scr.help',
    action: 'help',
    pauses: 'always',
    width: 'min(calc(var(--fs) * 52), 96vw)',
    height: 'min(calc(var(--fs) * 34), 90vh)',
    legend: [['↑↓', 'topic'], ['PgUp/PgDn', 'scroll']],
    onKey: (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        list.select(topics.indexOf(list.selected()!) + (e.key === 'ArrowDown' ? 1 : -1));
        return true;
      }
      if (e.key === 'PageDown' || e.key === 'PageUp') return (text.scrollTop += (e.key === 'PageDown' ? 1 : -1) * text.clientHeight * 0.9), true;
      return false;
    },
  });
  panel.body.append(h('div', { class: 'hp-wrap' }, list.el, text));
  panel.body.style.overflow = 'hidden';
  function show(t: Topic): void {
    text.replaceChildren(t.render());
    text.scrollTop = 0;
  }
  list.select(0);
  return panel;
}
