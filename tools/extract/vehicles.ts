// Extract CDDA vehicles into public/data/vehicles.json: vehicle prototypes (copy-from
// resolved with CDDA's "parts append" rule), vehicle parts slimmed to what the game uses,
// vehicle groups (each prototype is also a group of itself, like veh_type.cpp), and the
// energy density of the fuels engines burn.
//
// Kept apart from the main extractor so vehicles can be regenerated without touching the
// shared misc.json (which also carries `vehicle`/`vehicle_part`, but older builds of it
// lost the inherited parts of copy-from vehicles).
//
// Usage: npm run extract:vehicles -- [--cdda DIR] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir, loadResolved, type CddaObject } from './cdda';
import type { VehicleDataFile, VPartDef, VProtoDef, VProtoPart, VItemSpawn } from '../../src/game/vehicle_data';

function usage(): string {
  return `Usage: npx tsx tools/extract/vehicles.ts [options]

Write public/data/vehicles.json (vehicle prototypes, parts, groups, fuel energy).

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

const t0 = performance.now();
const res = loadResolved(['vehicle', 'vehicle_part', 'vehicle_group', 'material', 'ITEM'], args.cdda);
const fam = (t: string) => res.get(t) ?? new Map<string, CddaObject>();
const items = fam('ITEM');
const materials = fam('material');

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const nameOf = (o: CddaObject | undefined): string | undefined => (typeof o?.name === 'string' ? o.name : undefined);

// --- fuels: kJ per charge. Material fuel_data.energy is per litre of the fuel item.
const fuels: VehicleDataFile['fuels'] = {};
function fuelInfo(id: string, needEnergy = true): void {
  if (fuels[id] || id === 'muscle' || id === 'animal' || id === 'wind') return;
  const it = items.get(id);
  if (!it) throw new Error(`fuel item ${id} unknown`);
  const mat = materials.get(asArr<string>(it.material as any)[0] ?? '') ?? materials.get(id);
  const perL = num(mat?.fuel_data?.energy);
  // Charges per litre: stack_size charges take `volume` ml (gasoline: 200 charges / 200 ml).
  const vol = num(it.volume) ?? 1000;
  const stack = num(it.stack_size) ?? num(it.count) ?? 1;
  const chargesPerL = (1000 * stack) / vol;
  const kj = id === 'battery' ? 1 : perL !== undefined ? perL / chargesPerL : undefined;
  if (kj === undefined && needEnergy) throw new Error(`fuel ${id}: no fuel_data energy on its material`);
  // Tank contents that aren't fuel (water) still need charges/L to fill the tank.
  fuels[id] = { name: nameOf(it) ?? id, kjPerCharge: kj ?? 0, chargesPerL: id === 'battery' ? undefined : chargesPerL };
}

// --- parts
const parts: Record<string, VPartDef> = {};
for (const [id, p] of fam('vehicle_part')) {
  const it = items.get(p.item);
  const flags = asArr<string>(p.flags);
  const def: VPartDef = {
    id,
    name: nameOf(p) ?? nameOf(it) ?? id,
    item: p.item,
    location: p.location,
    flags,
    durability: num(p.durability) ?? 100,
    weight: num(it?.weight) ?? 0,
    color: p.color,
    broken_color: p.broken_color,
    looks_like: p.looks_like,
    categories: p.categories,
  };
  for (const k of ['power', 'epower', 'energy_consumption', 'noise_factor', 'bonus', 'size', 'm2c', 'damage_modifier', 'comfort',
    'contact_area', 'backfire_threshold', 'damaged_power_factor'] as const) {
    const v = num(p[k]);
    if (v !== undefined) (def as any)[k] = v;
  }
  if (typeof p.fuel_type === 'string') def.fuel_type = p.fuel_type;
  if (p.damage_reduction) def.damage_reduction = p.damage_reduction;
  if (p.wheel_terrain_modifiers) def.wheel_terrain_modifiers = p.wheel_terrain_modifiers;
  // Symbols per variant for glyph fallbacks (first char of "symbols" = facing north).
  if (Array.isArray(p.variants)) {
    def.variants = Object.fromEntries(p.variants.filter((v: any) => typeof v?.id === 'string')
      .map((v: any) => [v.id, { symbols: String(v.symbols ?? ''), broken: String(v.symbols_broken ?? '') }]));
  }
  // Storage capacity: fuel tanks hold a volume of liquid (ml), batteries a charge (kJ).
  const pocket = asArr<any>(it?.pocket_data)[0];
  if (flags.includes('FLUIDTANK') && pocket) def.capacity = num(pocket.max_contains_volume);
  if (flags.includes('BATTERY') && pocket?.ammo_restriction) def.capacity = num(pocket.ammo_restriction.battery);
  if (def.fuel_type) fuelInfo(def.fuel_type);
  // Wheel size (inches, like CDDA's wheel items) for rendering and ground clearance.
  if (flags.includes('WHEEL') && num(it?.diameter) !== undefined) def.wheel = { diameter: num(it!.diameter)!, width: num(it!.width) ?? 6 };
  parts[id] = def;
}

// --- prototypes
const vehicles: Record<string, VProtoDef> = {};
const missingParts = new Set<string>();
for (const [id, v] of fam('vehicle')) {
  const out: VProtoPart[] = [];
  for (const mount of asArr<any>(v.parts)) {
    for (const e of asArr<any>(mount.parts)) {
      const s: string = typeof e === 'string' ? e : e.part;
      const [pid, variant] = s.split('#');
      if (!parts[pid]) {
        missingParts.add(pid);
        continue;
      }
      const pp: VProtoPart = { x: mount.x, y: mount.y, part: pid };
      if (variant) pp.variant = variant;
      if (typeof e === 'object' && typeof e.fuel === 'string') {
        pp.fuel = e.fuel;
        fuelInfo(e.fuel, false);
      }
      out.push(pp);
    }
  }
  const spawns: VItemSpawn[] = asArr<any>(v.items).map((s) => {
    const r: VItemSpawn = { x: s.x, y: s.y, chance: s.chance ?? 100 };
    const its = asArr<any>(s.items).map((i) => (typeof i === 'string' ? i : i.id));
    const grps = asArr<any>(s.item_groups);
    if (its.length) r.items = its;
    if (grps.length) r.item_groups = grps;
    return r;
  });
  vehicles[id] = { id, name: nameOf(v) ?? id, parts: out, items: spawns };
}

// --- groups (vehicle_group.cpp: every prototype is also a group containing only itself)
const groups: Record<string, [string, number][]> = {};
for (const [id, g] of fam('vehicle_group')) groups[id] = asArr<any>(g.vehicles).map((e) => [e[0], e[1] ?? 100]);

const file: VehicleDataFile = { parts, vehicles, groups, fuels };
const summary = `${Object.keys(vehicles).length} vehicles, ${Object.keys(parts).length} parts, ${Object.keys(groups).length} groups, fuels ${Object.keys(fuels).join(' ')}`;
if (missingParts.size) console.warn(`unknown vehicle parts skipped (${missingParts.size}): ${[...missingParts].slice(0, 12).join(', ')}`);
if (args.dryRun) {
  console.log(`[dry-run] would write ${path.join(args.out, 'vehicles.json')}: ${summary}`);
} else {
  fs.writeFileSync(path.join(args.out, 'vehicles.json'), JSON.stringify(file));
  console.log(`wrote ${path.join(args.out, 'vehicles.json')}: ${summary} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
}
