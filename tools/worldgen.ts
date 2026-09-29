// Headless worldgen probe: builds the overmap + JSON mapgen from public/data in Node (no
// browser) and prints ASCII dumps and generation statistics.
//
// Usage: npm run worldgen -- [--seed N] [--overmap R] [--chunk cx,cy,z]... [--start]
//                            [--stats N] [--quiet]
//   --overmap R    print the overmap (radius R OMTs) around the start shelter
//   --chunk c      print one chunk as ASCII (repeatable). Coordinates are OMTs; "start"
//                  prints the shelter chunk
//   --start        print the start location
//   --stats N      generate N x N chunks around the start (z=0 plus z=1/-1 of buildings)
//                  and print timings, % JSON mapgen, unsupported features
//   --png file     render a top-down colour map (terrain/furniture colours) to a PNG
//   --around x,y   OMT centre for --png (default: start shelter); --radius R OMTs (default 4)
//   --z Z          z-level for --png (default 0)
//   --coverage     run every om_terrain mapgen in the data once and report unsupported
//                  features / unknown ids across all of it
//   --quiet        don't print per-feature warnings

import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import { cddaColor } from '../src/render/renderer';
import { WorldGenerator } from '../src/world/worldgen';
import { loadNodeData, makeMap } from './lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split('\n').slice(0, 14).join('\n'));
  process.exit(0);
}

const get = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const seed = Number(get('--seed') ?? 1);
const t0 = performance.now();
const { game, wg } = loadNodeData();
const t1 = performance.now();
const map = makeMap(game, seed);
const gen = new WorldGenerator(seed, wg, game);
gen.stats.quiet = argv.includes('--quiet');
map.generator = gen;
const start = gen.findStartLocation('shelter', map);
const t2 = performance.now();
console.log(`data load ${(t1 - t0).toFixed(0)} ms; overmap region + start ${(t2 - t1).toFixed(0)} ms`);
if (argv.includes('--start')) console.log('start', start);

const om = get('--overmap');
if (om) console.log(gen.overmap.dump(start.omx, start.omy, Number(om)));

for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--chunk') continue;
  const v = argv[i + 1];
  const [cx, cy, cz] = v === 'start' ? [start.omx, start.omy, 0] : v.split(',').map(Number);
  const c = map.chunk(cx, cy, cz ?? 0)!;
  console.log(`chunk ${cx},${cy},${cz ?? 0}  ${c.omt?.id} (${c.omt?.source})  items=${c.items.size} spawns=${c.spawns.length}`);
  console.log(gen.dumpChunk(map, cx, cy, cz ?? 0));
}

const n = get('--stats');
if (n) {
  const N = Number(n);
  const times: number[] = [];
  for (let dy = -N; dy <= N; dy++)
    for (let dx = -N; dx <= N; dx++)
      for (const z of [0, 1, -1]) {
        const cx = start.omx + dx, cy = start.omy + dy;
        if (z !== 0 && !gen.overmap.omtAt(cx, cy, z).special) continue;
        const a = performance.now();
        map.chunk(cx, cy, z);
        times.push(performance.now() - a);
      }
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({ ...gen.stats.summary(), p50: times[times.length >> 1]?.toFixed(2), p95: times[Math.floor(times.length * 0.95)]?.toFixed(2) }, null, 2));
}

if (argv.includes('--coverage')) {
  const ids = Object.keys(wg.mapgen.omt);
  const a = performance.now();
  for (const id of ids) {
    const oid = id.replace(/_(straight|curved|end|tee|four_way)$/, '');
    try {
      gen.previewOmt(map, wg.overmap.terrains[oid] ? oid : id, 0, 1);
    } catch (e) {
      console.log(`!! ${id}: ${(e as Error).message}`);
    }
  }
  const s = gen.stats.summary();
  console.log(`coverage: ${ids.length} om_terrain mapgens in ${(performance.now() - a).toFixed(0)} ms`);
  console.log(JSON.stringify({ topUnsupported: s.topUnsupported, topUnknownIds: s.topUnknownIds }, null, 2));
}

const png = get('--png');
if (png) {
  const R = Number(get('--radius') ?? 4);
  const [ax, ay] = get('--around') ? get('--around')!.split(',').map(Number) : [start.omx, start.omy];
  const z = Number(get('--z') ?? 0);
  const S = 3, span = (2 * R + 1) * 24;
  const img = new PNG({ width: span * S, height: span * S });
  for (let oy = -R; oy <= R; oy++)
    for (let ox = -R; ox <= R; ox++) {
      const c = map.chunk(ax + ox, ay + oy, z)!;
      for (let ly = 0; ly < 24; ly++)
        for (let lx = 0; lx < 24; lx++) {
          const i = ly * 24 + lx;
          const t = map.terrain.get(c.ter[i]);
          const f = c.furn[i] ? map.furniture.get(c.furn[i]) : undefined;
          let col = cddaColor(f ? f.color : t.color);
          // walls a bit brighter, open air black, so building outlines read clearly
          if (t.id === 't_open_air') col = 0x101018;
          else if (t.move_cost === 0 && !f) col = mix(col, 0xffffff, 0.35);
          if (c.items.has(i) && !f) col = mix(col, 0xffd040, 0.5);
          const px = ((oy + R) * 24 + ly) * S, pxx = ((ox + R) * 24 + lx) * S;
          for (let dy = 0; dy < S; dy++)
            for (let dx = 0; dx < S; dx++) {
              const k = ((px + dy) * span * S + pxx + dx) * 4;
              const edge = (lx === 0 && dx === 0) || (ly === 0 && dy === 0);
              const cc = edge ? mix(col, 0x000000, 0.3) : col;
              img.data[k] = (cc >> 16) & 255;
              img.data[k + 1] = (cc >> 8) & 255;
              img.data[k + 2] = cc & 255;
              img.data[k + 3] = 255;
            }
        }
    }
  writeFileSync(png, PNG.sync.write(img));
  console.log(`wrote ${png} (${span * S}px, centre ${ax},${ay},${z})`);
}

function mix(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t) << s;
  return ch(16) | ch(8) | ch(0);
}
