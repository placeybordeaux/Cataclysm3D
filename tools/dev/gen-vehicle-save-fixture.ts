// Writes tests/fixtures/vehicles_pre_v3.json: the "vehicles" save section as a build from
// before vehicles v3 wrote it (plain BN grids, no `chassis` per vehicle), for the save
// migration test (tests/chassis.test.ts). The pre-v3 format is today's minus `chassis`, so
// it's produced by today's code with the template cleared. Wear, fuel, open doors, cargo
// items, a driven vehicle and a queued mapgen request are all in it.
//
// Usage: npx tsx tools/dev/gen-vehicle-save-fixture.ts [--dry-run] [-h]

import { readFileSync, writeFileSync } from 'node:fs';
import { Rng } from '../../src/core/rng';
import { createItem } from '../../src/game/item';
import { L, spawnItem } from '../../src/game/moves';
import { has, spawnVehicle } from '../../src/game/vehicle';
import type { VehicleDataFile } from '../../src/game/vehicle_data';
import type { VehicleSaveJSON } from '../../src/game/vehicles';
import { loadNodeData } from '../lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  console.log('Usage: npx tsx tools/dev/gen-vehicle-save-fixture.ts [--dry-run]\n\nWrite tests/fixtures/vehicles_pre_v3.json (a pre-vehicles-v3 save section).');
  process.exit(0);
}
for (const a of argv) if (a !== '--dry-run') throw new Error(`unknown argument ${a}`);
const dryRun = argv.includes('--dry-run');

const data = loadNodeData().game;
const vdata: VehicleDataFile = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8'));
const OUT = 'tests/fixtures/vehicles_pre_v3.json';
const protos: [string, number][] = [['car', -1], ['pickup', 1], ['cube_van', -1], ['bus', 0], ['motorcycle', -1], ['golf_cart', 2], ['apc', -1], ['semi_truck', 1]];
const vehicles = protos.map(([id, status], i) => {
  const v = spawnVehicle(vdata, data, id, { x: 20.5 + i * 16, y: 40.5, z: 0, facing: (i * 90) % 360, fuel: -1, status, rng: new Rng(100 + i) });
  // Cargo that must survive: a few known items in every cargo part.
  for (const c of v.parts.filter((p) => has(p, 'CARGO')).slice(0, 3)) {
    for (const it of ['water_clean', 'hammer', 'rag']) if (data.items[it]) spawnItem(createItem(data, it), L.cargo(c), { force: true, quiet: true });
  }
  const door = v.parts.find((p) => has(p, 'OPENABLE'));
  if (door) door.open = true;
  const j = v.toJSON();
  if ('chassis' in j) delete j.chassis;
  return j;
});
const section: VehicleSaveJSON = { vehicles, driving: vehicles[0].uid, pending: [{ id: 'car', x: 300, y: 300, z: 0, rotation: 90 } as VehicleSaveJSON['pending'][number]] };
const json = JSON.stringify(section);
if (dryRun) console.log(`[dry-run] would write ${OUT}: ${vehicles.length} vehicles, ${vehicles.reduce((a, v) => a + v.parts.length, 0)} parts, ${json.length} bytes`);
else {
  writeFileSync(OUT, json + '\n');
  console.log(`wrote ${OUT}: ${vehicles.length} vehicles, ${json.length} bytes`);
}
