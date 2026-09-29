import { c, colorize, openMenu, type UiWindow } from './framework';
import type { UiContext } from './context';
import { keyLabel } from './keymap';

// '?' help: CDDA's help menu (data/core/help.json topics) with two topics of our own in
// front: the key bindings (from game.keys.list(): every registered action, and only those)
// and a short survival primer for the real-time version.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Keys are <keybind:action id> (resolved from DEFAULT_BINDINGS) so the text never goes stale.
const INTRO = `<color_white>Surviving the Cataclysm</color>

The world ended.  Most people turned into shambling, hungry things, and the rest of us are hiding in evac shelters waiting for a rescue that is not coming.  You have what you are wearing and whatever you can scavenge.

<color_light_green>Look after your body.</color>  The sidebar on the right tracks your hit points per body part, your stamina, pain, hunger, thirst, tiredness and body temperature.  A labelled need is a problem; a <color_red>red</color> one is an emergency.  Thirst kills faster than hunger.

<color_light_green>Scavenge.</color>  Houses, shops and the shelter itself hold food, water, clothing and tools.  Press <keybind:pickup> to pick things up, <keybind:inventory> to look through your stuff, <keybind:wear> to wear clothes and bags (more pockets means more you can carry), <keybind:eat> to eat or drink.

<color_light_green>Pick your fights.</color>  Zombies are slow but numerous and they hear you.  Running (<color_yellow>Shift</color>) burns stamina; running out of it leaves you winded and easy prey.  Wield a real weapon (<keybind:wield>) before you need one.  A crowbar or a pipe beats your fists.

<color_light_green>Rest.</color>  Sleep somewhere safe (<keybind:sleep>), wait out the night (<keybind:wait>), bandage wounds with <keybind:apply>.  Darkness is dangerous; a flashlight (<keybind:flashlight>) helps you see and helps them see you.

<color_light_green>Look around.</color>  <keybind:look> describes whatever is under the crosshair, <keybind:map> shows the map of places you have seen.

When you die, and you will, the game shows what you accomplished.  Then you start again, a little wiser.`;

const keyName = keyLabel;

function keybindingsText(ctx: UiContext): string {
  const keys = ctx.game.keys;
  const wasd = keys.movementKeys().split('').join(' ');
  const rows: string[] = [];
  const row = (k: string, n: string, col = 'c_yellow') => rows.push(`${c(col, k.padEnd(10))} ${esc(n)}`);
  rows.push(c('c_light_blue', 'MOVEMENT'));
  row(wasd, 'Move (forward / left / back / right)');
  row('Mouse', 'Look around (click the view to capture the mouse)');
  row('Shift', 'Run (uses stamina)');
  row('LMB', 'Attack / fire');
  row('RMB', 'Aim (hold)');
  row('Wheel', 'Zoom (top-down camera)');
  rows.push('', c('c_light_blue', 'MENUS'));
  row('↑↓ PgUp/Dn', 'Move the highlight (j k where they are not hotkeys)');
  row('letter', 'Pick the entry with that hotkey');
  row('Enter', 'Select');
  row('Bksp', 'Close (the key that opened a menu also closes it)');
  row('Esc', 'Close; in gameplay opens the pause menu');
  rows.push(c('c_dark_gray', `Outside fullscreen the browser frees the mouse on Esc; click the view or press any key to take it back. ${keyName(keys.keyFor('fullscreen'))} fullscreen keeps it captured.`));
  rows.push('', c('c_light_blue', 'ACTIONS') + c('c_dark_gray', '  (rebind in Options > Key bindings)'));
  const listed = keys.list();
  for (const [ks, name] of listed.sort((a, b) => a[1].localeCompare(b[1])))
    row(ks.length ? ks.map(keyName).join(' ') : 'unbound', name, ks.length ? 'c_yellow' : 'c_red');
  return rows.join('\n');
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

export function openHelp(ctx: UiContext): UiWindow {
  type Topic = () => string;
  const entries: { label: string; value: Topic; detail: Topic }[] = [];
  const add = (label: string, f: Topic) => entries.push({ label, value: f, detail: f });
  add(c('c_white', 'Key bindings'), () => keybindingsText(ctx));
  add(c('c_white', 'How to survive'), () => colorize(INTRO.replace(/<keybind:([a-z_]+)>/g, (_, id: string) => `<color_yellow>${esc(keyName(ctx.game.keys.keyFor(id)))}</color>`)));
  for (const t of ctx.data.help) add(esc(t.name), () => cddaHelpText(ctx, t.messages));
  const win = openMenu<Topic>({
    title: 'Help',
    width: 'min(130ch, 96vw)',
    height: '90vh',
    detailPane: true,
    footer: `${c('c_light_green', '↑↓')} topic`,
    entries,
    onSelect: () => false,
  });
  const list = win.body.querySelector('.cols')?.firstElementChild as HTMLElement | null;
  if (list) list.style.flex = '0 0 30ch';
  return win;
}
