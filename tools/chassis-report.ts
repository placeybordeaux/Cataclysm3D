// Map every BN vehicle prototype onto its chassis template (vehicles v3, src/game/chassis) and
// report: how many land on each template, how the template was chosen, body sizes against the
// template's promised range, and every part that went to overflow (kept, but off-template).
//
// Usage: npx tsx tools/chassis-report.ts [--json] [--proto ID] [-h]
// Read-only: loads public/data, writes nothing.

import { readFileSync } from 'node:fs';
import { Rng } from '../src/core/rng';
import { chassisBodyRect, chassisOf, chassisSeats, layoutOf, TEMPLATES, type TemplateId } from '../src/game/chassis';
import { spawnVehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { loadNodeData } from './lib/node_data';

function usage(): string {
  return `Usage: npx tsx tools/chassis-report.ts [options]

Map all BN vehicle prototypes onto chassis templates and print a summary.

Options:
  --json        machine-readable output
  --proto ID    details (sockets, overflow) for one prototype
  -h, --help    show this help`;
}

const args = { json: false, proto: '' };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const k = argv[i];
  if (k === '-h' || k === '--help') {
    console.log(usage());
    process.exit(0);
  } else if (k === '--json') args.json = true;
  else if (k === '--proto') args.proto = argv[++i];
  else throw new Error(`unknown argument ${k}\n\n${usage()}`);
}

const data = loadNodeData().game;
const vdata: VehicleDataFile = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8'));
const make = (id: string) => spawnVehicle(vdata, data, id, { x: 0.5, y: 0.5, z: 0, facing: 0, fuel: 50, status: 0, rng: new Rng(1), items: false });

if (args.proto) {
  if (!vdata.vehicles[args.proto]) throw new Error(`unknown prototype ${args.proto}`);
  const v = make(args.proto);
  const ch = chassisOf(v);
  const L = layoutOf(v);
  console.log(`${args.proto}: ${ch.template} (${ch.why}), ${v.parts.length} parts, body ${JSON.stringify(chassisBodyRect(v))}`);
  for (const s of ch.sockets) console.log(`  ${s.id.padEnd(24)} ${s.parts.map((p) => p.def.id).join(', ')}`);
  for (const o of ch.overflow) console.log(`  OVERFLOW ${o.part.def.id} @ ${o.part.mx},${o.part.my}: ${o.reason}`);
  for (const s of chassisSeats(v)) console.log(`  seat ${s.part.def.id} @ ${s.mx},${s.my} drawn (${s.x.toFixed(2)}, ${s.y.toFixed(2)}) h ${s.h.toFixed(2)}${s.driver ? ' driver' : ''}`);
  console.log(`  sections ${L.sections.map((s) => s.kind).join(' ')}`);
  process.exit(0);
}

interface Row { id: string; template: TemplateId; why: string; parts: number; overflow: { part: string; reason: string }[]; length: number | null; width: number | null }
const rows: Row[] = [];
for (const id of Object.keys(vdata.vehicles)) {
  const v = make(id);
  const ch = chassisOf(v);
  const b = chassisBodyRect(v);
  rows.push({
    id, template: ch.template, why: ch.why, parts: v.parts.length,
    overflow: ch.overflow.map((o) => ({ part: o.part.def.id, reason: o.reason })),
    length: b ? b.x1 - b.x0 : null, width: b ? b.y1 - b.y0 : null,
  });
}
if (args.json) {
  console.log(JSON.stringify(rows, null, 1));
  process.exit(0);
}
const byT = new Map<TemplateId, Row[]>();
for (const r of rows) byT.set(r.template, [...(byT.get(r.template) ?? []), r]);
const totalParts = rows.reduce((a, r) => a + r.parts, 0), totalOver = rows.reduce((a, r) => a + r.overflow.length, 0);
console.log(`${rows.length} prototypes, ${totalParts} parts, ${totalOver} in overflow (${rows.filter((r) => r.overflow.length).length} prototypes)\n`);
for (const [t, list] of [...byT].sort((a, b) => b[1].length - a[1].length)) {
  const T = TEMPLATES[t];
  const lens = list.map((r) => r.length).filter((x): x is number => x !== null);
  const range = lens.length ? ` body ${Math.min(...lens).toFixed(1)}-${Math.max(...lens).toFixed(1)} m (promised ${T.length?.join('-')})` : '';
  console.log(`${t.padEnd(14)} ${String(list.length).padStart(3)}${range}`);
  console.log(`   ${list.map((r) => r.id + (r.why !== 'id' ? `[${r.why}]` : '') + (r.overflow.length ? `{${r.overflow.length} over}` : '')).join(' ')}`);
}
const reasons = new Map<string, number>();
for (const r of rows) for (const o of r.overflow) reasons.set(o.reason.replace(/[-\d.,() ]+/g, ' ').trim(), (reasons.get(o.reason.replace(/[-\d.,() ]+/g, ' ').trim()) ?? 0) + 1);
if (reasons.size) {
  console.log('\noverflow reasons:');
  for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
  console.log('\noverflow parts:');
  for (const r of rows.filter((q) => q.overflow.length)) console.log(`  ${r.id} (${r.template}): ${r.overflow.map((o) => o.part).join(', ')}`);
}
