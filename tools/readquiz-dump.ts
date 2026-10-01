// Print sample "field notes" questions for books (the reading minigame, src/game/readquiz/).
// For eyeballing the generators against the real data.
//
//   nix-shell --run 'npx tsx tools/readquiz-dump.ts cookbook manual_electronics'
//   options: --n 6            questions per book (default 6)
//            --template T     only this template (e.g. battery_fits)
//            --all            every book with a quiz
//            --seed 1         rng seed
import fs from 'node:fs';
import path from 'node:path';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { bookHasQuiz, nextQuestion, questionFrom, questionKey, setQuizVehicles, type TemplateId } from '../src/game/readquiz/questions';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: tsx tools/readquiz-dump.ts [book ids…] [--all] [--n 6] [--template id] [--seed 1]');
  process.exit(0);
}
const opt = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const dir = path.join(import.meta.dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = { terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: load('recipes.json'), misc: load('misc.json') };
setQuizVehicles(data, load('vehicles.json'));

const n = Number(opt('--n', '6'));
const template = argv.includes('--template') ? (opt('--template', '') as TemplateId) : null;
const rng = new Rng(Number(opt('--seed', '1')));
const flagArgs = new Set(['--n', '--template', '--seed']);
const ids = argv.includes('--all')
  ? Object.keys(data.items).filter((id) => (data.items[id].subtypes as string[] | undefined)?.includes('BOOK') && bookHasQuiz(data, id))
  : argv.filter((a, i) => !a.startsWith('--') && !flagArgs.has(argv[i - 1]));
for (const id of ids) {
  console.log(`\n\x1b[1m${id}\x1b[0m  (${data.items[id]?.skill ?? 'no skill'} ${data.items[id]?.required_level ?? 0}-${data.items[id]?.max_level ?? 0})`);
  const seen = new Set<string>();
  for (let i = 0; i < n * 4 && seen.size < n; i++) {
    const q = template ? questionFrom(data, id, template, rng) : nextQuestion(data, id, rng, seen);
    if (!q || seen.has(questionKey(q))) continue;
    seen.add(questionKey(q));
    console.log(`  [${q.template}] ${q.prompt}`);
    console.log(`     ${q.options.map((o, j) => (j === q.answer ? `\x1b[32m${o}\x1b[0m` : o)).join('  ·  ')}`);
    console.log(`     \x1b[2m${q.explain}\x1b[0m`);
  }
}
