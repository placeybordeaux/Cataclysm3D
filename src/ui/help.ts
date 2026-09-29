import { c, colorize, openMenu, type UiWindow } from './framework';
import type { UiContext } from './context';

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

const MOVEMENT: [string, string][] = [
  ['W A S D', 'Move (forward / left / back / right)'],
  ['Mouse', 'Look around (click the view to capture the mouse)'],
  ['Shift', 'Run (uses stamina)'],
  ['LMB', 'Attack / fire'],
  ['RMB', 'Aim'],
];

function keyName(k: string): string {
  if (k === 'Escape') return 'Esc';
  if (k === ' ') return 'Space';
  return k;
}

function keybindingsText(ctx: UiContext): string {
  const rows: string[] = [];
  rows.push(c('c_light_blue', 'MOVEMENT'));
  for (const [k, n] of MOVEMENT) rows.push(`${c('c_yellow', k.padEnd(10))} ${esc(n)}`);
  rows.push('', c('c_light_blue', 'ACTIONS'));
  const listed = ctx.game.keys.list();
  for (const [keys, name] of listed.sort((a, b) => a[1].localeCompare(b[1]))) rows.push(`${c('c_yellow', keys.map(keyName).join(' ').padEnd(10))} ${esc(name)}`);
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
    footer: `${c('c_light_green', '↑↓')} topic  ${c('c_light_green', 'Esc')} close`,
    entries,
    onSelect: () => false,
  });
  const list = win.body.querySelector('.cols')?.firstElementChild as HTMLElement | null;
  if (list) list.style.flex = '0 0 30ch';
  return win;
}
