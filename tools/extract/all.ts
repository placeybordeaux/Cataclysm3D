// Run every CDDA data extractor in dependency order and report output size changes.
//
// Order matters: mapgen reads items.json (item migrations) and npcs.json (which
// update_mapgen ids dialogue/missions reference), so core and npcs run first.
//
// Usage: npm run data:all -- [--cdda DIR] [--dry-run] [--only core,npcs,...]
// (atlas and audio are separate: `npm run atlas`, `npm run audio`; they don't read these files)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const STEPS: { name: string; script: string }[] = [
  { name: 'core', script: 'tools/extract/index.ts' },
  { name: 'npcs', script: 'tools/extract/npcs.ts' },
  { name: 'mapgen', script: 'tools/extract/mapgen.ts' },
  { name: 'vehicles', script: 'tools/extract/vehicles.ts' },
  { name: 'ui', script: 'tools/extract/ui.ts' },
];
const OUT = 'public/data';

function usage(): string {
  return `Usage: npm run data:all -- [options]

Regenerate all of public/data from CDDA JSON (${STEPS.map((s) => s.name).join(' -> ')}).

Options:
  --cdda <dir>     Cataclysm-DDA checkout (passed to every extractor)
  --only <a,b>     run only these steps (still in dependency order)
  --dry-run        run the extractors in dry-run mode (nothing written)
  -h, --help       show this help`;
}

const argv = process.argv.slice(2);
const pass: string[] = [];
let only: Set<string> | null = null;
let dry = false;
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '-h' || k === '--help') {
    console.log(usage());
    process.exit(0);
  } else if (k === '--dry-run') {
    dry = true;
    pass.push(k);
  } else if (k === '--cdda') pass.push(k, argv[++i]);
  else if (k === '--only') only = new Set(argv[++i].split(','));
  else {
    console.error(`unknown argument ${k}\n\n${usage()}`);
    process.exit(2);
  }
}
if (only) for (const o of only) if (!STEPS.some((s) => s.name === o)) throw new Error(`--only: unknown step ${o}`);

const sizes = (): Map<string, number> => {
  const m = new Map<string, number>();
  if (!fs.existsSync(OUT)) return m;
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.json')) m.set(f, fs.statSync(path.join(OUT, f)).size);
  return m;
};
const before = sizes();
const t0 = Date.now();
for (const s of STEPS) {
  if (only && !only.has(s.name)) continue;
  console.log(`\n\x1b[1m== ${s.name}\x1b[0m (${s.script})`);
  const r = spawnSync(process.execPath, ['--import', 'tsx', s.script, ...pass], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\x1b[31mstep ${s.name} failed (exit ${r.status})\x1b[0m`);
    process.exit(1);
  }
}
const after = sizes();
const mb = (n: number) => (n / 1024 / 1024).toFixed(2).padStart(6);
console.log(`\n\x1b[1mpublic/data\x1b[0m${dry ? ' (dry run: unchanged)' : ''} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
let tb = 0, ta = 0;
for (const f of [...new Set([...before.keys(), ...after.keys()])].sort()) {
  const b = before.get(f) ?? 0, a = after.get(f) ?? 0;
  tb += b;
  ta += a;
  const d = a - b;
  const col = d > 0 ? '\x1b[33m' : d < 0 ? '\x1b[32m' : '\x1b[2m';
  console.log(`  ${f.padEnd(22)} ${mb(a)} MB  ${col}${d >= 0 ? '+' : ''}${(d / 1024).toFixed(0)} KB\x1b[0m`);
}
console.log(`  ${'total'.padEnd(22)} ${mb(ta)} MB  ${ta - tb >= 0 ? '+' : ''}${((ta - tb) / 1024).toFixed(0)} KB`);
