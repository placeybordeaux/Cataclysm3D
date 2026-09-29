// Extract CDDA's achievement system data (achievement, conduct, event_statistic,
// event_transformation, score) into public/data/achievements.json. Kept apart from the main
// extractor (which ignores these types) so misc.json doesn't churn and the runtime can load
// the file lazily.
//
// Usage: npm run extract:achievements -- [--cdda ~/code/Cataclysm-DDA] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir, loadCddaObjects } from './cdda';

function usage(): string {
  return `Usage: npm run extract:achievements -- [options]

Write public/data/achievements.json (achievements, conducts, event statistics, event
transformations, scores).

Options:
  --cdda <dir>   Cataclysm checkout (default: $CDDA_DIR or ~/code/Cataclysm-BN)
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

const TYPES = ['achievement', 'conduct', 'event_statistic', 'event_transformation', 'score'];
const byType = loadCddaObjects(args.cdda, { types: TYPES });

/** Strip "//" comment keys and flatten translations ({str, str_pl, str_sp}) where they're plain names. */
function strip(o: any): any {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const r: any = {};
    for (const [k, v] of Object.entries(o)) if (!k.startsWith('//')) r[k] = strip(v);
    return r;
  }
  return o;
}
const text = (v: any): string | undefined => (v === undefined ? undefined : typeof v === 'string' ? v : v.str_sp ?? v.str);

const out = {
  achievements: {} as Record<string, any>,
  statistics: {} as Record<string, any>,
  transformations: {} as Record<string, any>,
  scores: {} as Record<string, any>,
};
for (const type of ['achievement', 'conduct']) {
  for (const raw of byType.get(type) ?? []) {
    const o = strip(raw);
    const a: any = { id: o.id, name: text(o.name) ?? o.id, requirements: o.requirements ?? [] };
    if (type === 'conduct') a.conduct = true;
    const d = text(o.description);
    if (d) a.description = d;
    for (const k of ['hidden_by', 'time_constraint', 'manually_given', 'skill_requirements', 'kill_requirements']) if (o[k] !== undefined) a[k] = o[k];
    for (const r of a.requirements) if (r.description !== undefined) r.description = text(r.description);
    if (out.achievements[a.id]) throw new Error(`duplicate achievement ${a.id}`);
    out.achievements[a.id] = a;
  }
}
for (const raw of byType.get('event_statistic') ?? []) {
  const o = strip(raw);
  delete o.type;
  if (o.description) o.description = { one: text(o.description), many: o.description.str_pl ?? text(o.description) };
  out.statistics[o.id] = o;
}
for (const raw of byType.get('event_transformation') ?? []) {
  const o = strip(raw);
  delete o.type;
  out.transformations[o.id] = o;
}
for (const raw of byType.get('score') ?? []) {
  const o = strip(raw);
  out.scores[o.id] = { id: o.id, statistic: o.statistic, ...(o.description ? { description: text(o.description) } : {}) };
}

// Fail loudly on dangling references: the runtime would otherwise quietly never unlock them.
const statOk = (id: string) => !!out.statistics[id];
for (const a of Object.values(out.achievements)) {
  for (const r of a.requirements) if (!statOk(r.event_statistic)) throw new Error(`achievement ${a.id}: unknown statistic ${r.event_statistic}`);
  for (const h of a.hidden_by ?? []) if (!out.achievements[h]) throw new Error(`achievement ${a.id}: unknown hidden_by ${h}`);
}
for (const s of Object.values(out.statistics)) if (s.event_transformation && !out.transformations[s.event_transformation]) throw new Error(`statistic ${s.id}: unknown transformation ${s.event_transformation}`);
for (const t of Object.values(out.transformations)) if (t.event_transformation && !out.transformations[t.event_transformation]) throw new Error(`transformation ${t.id}: unknown transformation ${t.event_transformation}`);
for (const s of Object.values(out.scores)) if (!statOk(s.statistic)) throw new Error(`score ${s.id}: unknown statistic ${s.statistic}`);

const json = JSON.stringify(out);
const counts = Object.entries(out).map(([k, v]) => `${Object.keys(v).length} ${k}`).join(', ');
const file = path.join(args.out, 'achievements.json');
if (args.dryRun) console.log(`[dry-run] would write ${file} (${(json.length / 1024).toFixed(0)} KB): ${counts}`);
else {
  fs.mkdirSync(args.out, { recursive: true });
  fs.writeFileSync(file, json);
  console.log(`wrote ${file} (${(json.length / 1024).toFixed(0)} KB): ${counts}`);
}
