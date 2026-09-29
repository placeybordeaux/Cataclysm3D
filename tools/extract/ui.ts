// Extract the bits of Bright Nights data only the UI needs (title art, tombstone, names, help
// text, mood faces, tips) into public/data/ui.json. Kept apart from the main extractor because
// these live outside data/json (data/title, data/names, data/help/texts.json, data/raw/tips.json)
// and are plain text. BN draws the tombstone and the mood smileys in C++ (game.cpp,
// panels.cpp), so those are transcribed below.
//
// Usage: npm run extract:ui -- [--cdda ~/code/Cataclysm-BN] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir } from './cdda';

function usage(): string {
  return `Usage: npm run extract:ui -- [options]

Write public/data/ui.json (title art, tombstone art, name lists, help topics, mood faces, tips).

Options:
  --cdda <dir>   game checkout (default: $CDDA_DIR or ~/code/Cataclysm-BN)
  --out <dir>    output directory (default: public/data)
  --dry-run      print a summary instead of writing
  -h, --help     show this help`;
}

const args = { cdda: defaultCddaDir(), out: 'public/data', dryRun: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '-h' || k === '--help') {
    console.log(usage());
    process.exit(0);
  } else if (k === '--dry-run') args.dryRun = true;
  else if (k === '--cdda') args.cdda = argv[++i];
  else if (k === '--out') args.out = argv[++i];
  else throw new Error(`unknown argument ${k}\n\n${usage()}`);
}

const read = (p: string) => fs.readFileSync(path.join(args.cdda, p), 'utf8');
const readJson = (p: string) => JSON.parse(read(p));

// data/title/en.title: '#' lines are comments, the rest is color-tagged ASCII art.
const title = read('data/title/en.title').split('\n').filter((l) => l && !l.startsWith('#'));
if (title.length < 6) throw new Error('title art not found or too short');

// BN game.cpp (death screen, the default stone without a bible): the picture, coloured like
// BN does it per glyph (% green, _ and | white, @ brown, * red).
const BN_TOMBSTONE = [
  String.raw`           _________  ____           `,
  String.raw`         _/         ${'`'}/    \_         `,
  String.raw`       _/      _     _      \_.      `,
  String.raw`     _%\      |_) | |_)       \_     `,
  String.raw`   _/ \/      | \ | |           \_   `,
  String.raw` _/                               \_ `,
  String.raw`|                                   |`,
  String.raw` )                                 < `,
  String.raw`|                                   |`,
  String.raw`|                                   |`,
  String.raw`|   _                               |`,
  String.raw`|__/                                |`,
  String.raw` / ${'`'}--.                             |`,
  String.raw`|                                  ( `,
  String.raw`|                                   |`,
  String.raw`|                                   |`,
  String.raw`|     %                         .   |`,
  String.raw`|  @${'`'}                            %% |`,
  String.raw`| %@%@%\                *      %${'`'}%@%|`,
  String.raw`%%@@@.%@%\%%            ${'`'}\  %%.%%@@%@`,
  String.raw`@%@@%%%%%@@@@@@%%%%%%%%@@%%@@@%%%@%%@`,
];
const GLYPH_COLOR: Record<string, string> = { '%': 'green', '@': 'brown', '*': 'red' };
// Only the grass rows get colour tags: the runtime stamps the name/survival lines onto
// untagged rows (src/ui/death.ts), and plain white _ | are the default text colour anyway.
const tombPicture = BN_TOMBSTONE.map((row) => row.replace(/([%@*])\1*/g, (run) => `<color_${GLYPH_COLOR[run[0]]}>${run}</color>`));
// Where BN prints "In memory of: <name>", "Survived: <time>" and "Kills: <n>" on that stone.
const tombInfo: [[number, number], string][] = [
  [[6, 8], 'In memory of: <u_name>'],
  [[13, 9], 'Survived: <time_survived>'],
  [[15, 10], 'Kills: <total_kills>'],
];

const namesRaw = readJson('data/names/en.json') as { usage: string; gender?: string; name: string[] }[];
const pick = (usage: string, gender?: string) =>
  namesRaw.filter((n) => n.usage === usage && (gender === undefined || n.gender === gender)).flatMap((n) => n.name);
const names = {
  male: [...pick('given', 'male'), ...pick('backer', 'male')],
  female: [...pick('given', 'female'), ...pick('backer', 'female')],
  unisex: pick('backer', 'unisex'),
  family: pick('family'),
  nick: pick('nick'),
};
for (const [k, v] of Object.entries(names)) if (!v.length && k !== 'unisex') throw new Error(`no ${k} names`);

// Help topics: messages are strings or {force_monospaced: {str}} blocks.
const help = (readJson('data/help/texts.json') as any[])
  .filter((o) => o.type === 'help')
  .sort((a, b) => a.order - b.order)
  .map((o) => ({
    name: o.name as string,
    messages: (o.messages as any[]).map((m) => (typeof m === 'string' ? m : (m.force_monospaced?.str ?? m.str ?? ''))).filter(Boolean),
  }));

// BN panels.cpp morale_emotion (default, non-horizontal human face) with morale_stat's colour:
// green from +10, red from -10. First entry whose value <= morale wins.
const moodFaces = [
  [100, 'green', '8D'], [50, 'green', ':D'], [10, 'green', ':)'], [-10, 'white', ':|'], [-50, 'red', '):'],
  [-100, 'red', 'D:'], [-Infinity, 'red', 'D8'],
].map(([value, color, face]) => ({ value: value === -Infinity ? -1e9 : value, face: `<color_${color}>${face}</color>` }));

// data/raw/tips.json: the "tip" snippets BN shows on the loading screen and under the main
// menu ("tip of the day").
const tips = (readJson('data/raw/tips.json') as any[])
  .filter((o) => o.type === 'snippet' && o.category === 'tip')
  .flatMap((o) => (o.text as any[]).map((t) => (typeof t === 'string' ? t : t.text ?? t.str ?? '')))
  .filter(Boolean) as string[];
if (tips.length < 20) throw new Error(`only ${tips.length} tips in data/raw/tips.json`);

const out = {
  title,
  tombstone: { picture: tombPicture, added_info: tombInfo, last_words_label: 'Last Words:' },
  names,
  help,
  moodFaces,
  tips,
};

const summary = `title ${title.length} lines, tombstone ${out.tombstone.picture.length} lines, names ${Object.entries(names).map(([k, v]) => `${k}:${v.length}`).join(' ')}, help ${help.length} topics, tips ${tips.length}`;
if (args.dryRun) console.log(`[dry-run] would write ${path.join(args.out, 'ui.json')}: ${summary}`);
else {
  fs.writeFileSync(path.join(args.out, 'ui.json'), JSON.stringify(out));
  console.log(`wrote ${path.join(args.out, 'ui.json')}: ${summary}`);
}
