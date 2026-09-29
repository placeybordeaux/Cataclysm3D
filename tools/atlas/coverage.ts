// Report how many CDDA terrain / furniture / item / monster ids have a sprite in the compiled
// atlas: directly (exact id or seasonal variant) or via the looks_like chain (as the game
// would resolve them). Read-only.
//
// Usage: npx tsx tools/atlas/coverage.ts [--cdda DIR] [--atlas FILE] [--missing N]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AtlasIndex } from '../../src/render/atlasTypes';
import { AtlasLookup, SEASONS } from '../../src/render/atlasIndex';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`coverage: sprite coverage of CDDA ids in public/atlas/atlas.json
  --cdda DIR    CDDA checkout (default ~/code/Cataclysm-DDA); reads DIR/data/json only (no mods)
  --atlas FILE  atlas index (default public/atlas/atlas.json)
  --missing N   list up to N missing ids per category (default 0)`);
  process.exit(0);
}
const arg = (n: string) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const CDDA = arg('--cdda') ?? join(process.env.HOME ?? '', 'code/Cataclysm-DDA');
const index = JSON.parse(readFileSync(arg('--atlas') ?? 'public/atlas/atlas.json', 'utf8')) as AtlasIndex;
const MISSING = Number(arg('--missing') ?? 0);
const atlas = new AtlasLookup(index);

const ITEM_TYPES = new Set([
  'GENERIC', 'ITEM', 'TOOL', 'COMESTIBLE', 'ARMOR', 'TOOL_ARMOR', 'PET_ARMOR', 'GUN', 'GUNMOD', 'AMMO', 'MAGAZINE',
  'BOOK', 'BIONIC_ITEM', 'ENGINE', 'WHEEL', 'TOOLMOD', 'BATTERY',
]);
const category = (t: string) =>
  t === 'terrain' ? 'terrain' : t === 'furniture' ? 'furniture' : t === 'MONSTER' ? 'monster' : ITEM_TYPES.has(t) ? 'item' : null;

type Obj = { id?: string | string[]; abstract?: string; type: string; 'copy-from'?: string; looks_like?: string };
const byId = new Map<string, Obj>(); // includes abstracts, for copy-from resolution
const ids: Record<string, Set<string>> = { terrain: new Set(), furniture: new Set(), item: new Set(), monster: new Set() };

function walk(d: string): void {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.json')) {
      const data = JSON.parse(readFileSync(p, 'utf8'));
      for (const o of (Array.isArray(data) ? data : [data]) as Obj[]) {
        const cat = category(o?.type);
        if (!cat) continue;
        const keys = o.abstract ? [o.abstract] : Array.isArray(o.id) ? o.id : o.id ? [o.id] : [];
        for (const k of keys) {
          byId.set(`${cat}:${k}`, o);
          if (!o.abstract) ids[cat].add(k);
        }
      }
    }
  }
}
walk(join(CDDA, 'data/json'));

function looksLike(cat: string, id: string): string | undefined {
  // looks_like is inherited through copy-from.
  let o = byId.get(`${cat}:${id}`);
  for (let i = 0; o && i < 20; i++) {
    if (o.looks_like) return o.looks_like;
    o = o['copy-from'] ? byId.get(`${cat}:${o['copy-from']}`) : undefined;
  }
  return undefined;
}

const hasDirect = (id: string) => atlas.has(id) || SEASONS.some((s) => atlas.has(`${id}_season_${s}`));
console.log(`${'category'.padEnd(10)} ${'ids'.padStart(6)} ${'direct'.padStart(14)} ${'+looks_like'.padStart(14)}`);
const bar = (f: number) => '█'.repeat(Math.round(f * 20)).padEnd(20, '·');
for (const [cat, set] of Object.entries(ids)) {
  let direct = 0, viaLL = 0;
  const missing: string[] = [];
  for (const id of set) {
    if (hasDirect(id)) direct++;
    else if (atlas.lookupWithLooksLike(id, (x) => looksLike(cat, x))) viaLL++;
    else missing.push(id);
  }
  const pct = (n: number) => `${((100 * n) / set.size).toFixed(1)}%`;
  console.log(
    `${cat.padEnd(10)} ${String(set.size).padStart(6)} ${`${direct} ${pct(direct)}`.padStart(14)} ${`${direct + viaLL} ${pct(direct + viaLL)}`.padStart(14)}  ${bar((direct + viaLL) / set.size)}`,
  );
  if (MISSING) console.log(`   missing: ${missing.slice(0, MISSING).join(' ')}`);
}
