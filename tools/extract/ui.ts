// Extract the bits of CDDA data only the UI needs (title art, tombstone, names, help text,
// mood faces) into public/data/ui.json. Kept apart from the main extractor because these
// live outside data/json (data/title, data/names, data/core/help.json) and are plain text.
//
// Usage: npm run extract:ui -- [--cdda ~/code/Cataclysm-DDA] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir } from './cdda';

function usage(): string {
  return `Usage: npm run extract:ui -- [options]

Write public/data/ui.json (title art, tombstone art, name lists, help topics, mood faces, tips).

Options:
  --cdda <dir>   Cataclysm-DDA checkout (default: $CDDA_DIR or ~/code/Cataclysm-DDA)
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

const graveyard = readJson('data/json/ascii_art/graveyard.json') as any[];
const tombArt = graveyard.find((o) => o.id === 'ascii_tombstone');
if (!tombArt) throw new Error('ascii_tombstone missing');
const endScreens = readJson('data/json/end_screen.json') as any[];
const tombScreen = endScreens.find((o) => o.id === 'death_tombstone');
if (!tombScreen) throw new Error('death_tombstone end_screen missing');

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
const help = (readJson('data/core/help.json') as any[])
  .filter((o) => o.type === 'help')
  .sort((a, b) => a.order - b.order)
  .map((o) => ({
    name: o.name as string,
    messages: (o.messages as any[]).map((m) => (typeof m === 'string' ? m : (m.force_monospaced?.str ?? m.str ?? ''))).filter(Boolean),
  }));

const moodFaces = (readJson('data/json/mood_faces.json') as any[]).find((o) => o.id === 'DEFAULT')?.values;
if (!moodFaces) throw new Error('DEFAULT mood_face missing');

// data/core/tips.json: the "tip" snippets CDDA shows on the loading screen and under the
// main menu ("tip of the day").
const tips = (readJson('data/core/tips.json') as any[])
  .filter((o) => o.type === 'snippet' && o.category === 'tip')
  .flatMap((o) => (o.text as any[]).map((t) => (typeof t === 'string' ? t : t.text ?? t.str ?? '')))
  .filter(Boolean) as string[];
if (tips.length < 20) throw new Error(`only ${tips.length} tips in data/core/tips.json`);

const out = {
  title,
  tombstone: { picture: tombArt.picture as string[], added_info: tombScreen.added_info, last_words_label: tombScreen.last_words_label },
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
