import { DEFAULT_BINDINGS } from './keys';
import { c, colorize, openMenu, type UiWindow } from './framework';
import type { UiContext } from './context';

// '?' help: CDDA's help menu (data/core/help.json topics) with two topics of our own in
// front: the key bindings (from game.keys.list(), so every registered action shows up)
// and a short survival primer for the real-time version.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const INTRO = `<color_white>Surviving the Cataclysm</color>

The world ended.  Most people turned into shambling, hungry things, and the rest of us are hiding in evac shelters waiting for a rescue that is not coming.  You have what you are wearing and whatever you can scavenge.

<color_light_green>Look after your body.</color>  The sidebar on the right tracks your hit points per body part, your stamina, pain, hunger, thirst, tiredness and body temperature.  A labelled need is a problem; a <color_red>red</color> one is an emergency.  Thirst kills faster than hunger.

<color_light_green>Scavenge.</color>  Houses, shops and the shelter itself hold food, water, clothing and tools.  Press <color_yellow>g</color> to pick things up, <color_yellow>i</color> to look through your stuff, <color_yellow>W</color> to wear clothes and bags (more pockets means more you can carry), <color_yellow>E</color> to eat or drink.

<color_light_green>Pick your fights.</color>  Zombies are slow but numerous and they hear you.  Running (<color_yellow>Shift</color>) burns stamina; running out of it leaves you winded and easy prey.  Wield a real weapon (<color_yellow>z</color>) before you need one.  A crowbar or a pipe beats your fists.

<color_light_green>Rest.</color>  Sleep somewhere safe (<color_yellow>$</color>), wait out the night (<color_yellow>|</color>), bandage wounds with <color_yellow>A</color>.  Darkness is dangerous; a flashlight (<color_yellow>F</color>) helps you see and helps them see you.

<color_light_green>Look around.</color>  <color_yellow>x</color> describes whatever is under the crosshair, <color_yellow>m</color> shows the map of places you have seen.

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
  // Actions with a reserved key that no system has claimed yet, so players know they're coming.
  // (list() hands back the DEFAULT_BINDINGS arrays themselves, so identity tells them apart.)
  const claimed = new Set(listed.map(([k]) => k));
  const pending = Object.entries(DEFAULT_BINDINGS).filter(([, keys]) => !claimed.has(keys));
  if (pending.length) {
    rows.push('', c('c_dark_gray', 'NOT YET AVAILABLE'));
    for (const [id, keys] of pending) rows.push(c('c_dark_gray', `${keys.map(keyName).join(' ').padEnd(10)} ${id.replace(/_/g, ' ')}`));
  }
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
  add(c('c_white', 'How to survive'), () => colorize(INTRO));
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
