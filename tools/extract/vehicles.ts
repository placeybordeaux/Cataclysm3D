// Extract Bright Nights vehicles into public/data/vehicles.json: vehicle prototypes (copy-from
// resolved with CDDA's "parts append" rule), vehicle parts slimmed to what the game uses,
// vehicle groups (each prototype is also a group of itself, like veh_type.cpp), and the
// energy density of the fuels engines burn.
//
// Kept apart from the main extractor so vehicles can be regenerated without touching the
// shared misc.json (which also carries `vehicle`/`vehicle_part`, but older builds of it
// lost the inherited parts of copy-from vehicles).
//
// BN differences: item types are still split (TOOL, AMMO, MAGAZINE, CONTAINER...) rather than
// DDA's single ITEM type, and there are no pockets: a fuel tank holds its item's "contains"
// volume, a battery its MAGAZINE "capacity".
//
// Usage: npm run extract:vehicles -- [--cdda DIR] [--out public/data] [--dry-run]

import fs from 'node:fs';
import path from 'node:path';
import { defaultCddaDir, FAMILY_HOOKS, familyOf, familyTypes, loadCddaObjects, objectIds, resolveFamily, type CddaObject } from './cdda';
import { prepareObject } from './prepare';
import { RequirementResolver, parseRequirementLists, parseUsing } from './requirements';
import { parseQuantity } from './units';
import type { VehicleDataFile, VPartDef, VProtoDef, VProtoPart, VItemSpawn } from '../../src/game/vehicle_data';

function usage(): string {
  return `Usage: npx tsx tools/extract/vehicles.ts [options]

Write public/data/vehicles.json (vehicle prototypes, parts, groups, fuel energy).

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

const t0 = performance.now();
// BN spreads items over many types (TOOL, AMMO, CONTAINER...) that resolve as one ITEM family.
// Not loadResolved: vpart shapes must be expanded on the raw objects before copy-from.
const res = new Map<string, Map<string, CddaObject>>();
{
  const raw = loadCddaObjects(args.cdda, { types: ['vehicle', 'vehicle_part', 'vehicle_group', 'material', 'requirement', 'json_flag', ...familyTypes('ITEM')] });
  // BN vpart "shapes": each {direction, symbol} entry defines another part "<id>_<direction>"
  // (frame_vertical, windshield_ne...) copying the one that lists them (veh_type.cpp).
  const vparts = raw.get('vehicle_part') ?? [];
  for (const p of vparts) for (const r of Object.values(p.requirements ?? {}) as any[]) if (typeof r.time === 'number') r.time /= 100;
  for (const o of [...vparts]) {
    const base = o.abstract ?? o.id;
    for (const sh of Array.isArray(o.shapes) ? o.shapes : []) {
      const shape: CddaObject = { type: 'vehicle_part', id: `${base}_${sh.direction}`, 'copy-from': base };
      if (typeof sh.symbol === 'string') shape.symbol = sh.symbol;
      if (typeof sh.looks_like === 'string') shape.looks_like = sh.looks_like;
      else if (typeof o.looks_like === 'string') shape.looks_like = `${o.looks_like}_${sh.direction}`;
      vparts.push(shape);
    }
  }
  const families = new Map<string, CddaObject[]>();
  for (const [type, list] of raw) {
    const f = familyOf(type);
    families.set(f, [...(families.get(f) ?? []), ...list]);
  }
  for (const [f, list] of families) {
    const r = resolveFamily(list.filter((o) => objectIds(o).length > 0), FAMILY_HOOKS[f] ?? {}, prepareObject);
    res.set(f, r.byId);
  }
}
const fam = (t: string) => res.get(t) ?? new Map<string, CddaObject>();
const items = fam('ITEM');
const materials = fam('material');
const requirements = new RequirementResolver(new Map([...fam('requirement')].map(([id, def]) => [id, parseRequirementLists(def, id)])), msg => { throw new Error(msg); });

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const asArr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
/** BN CONTAINER "contains" is a volume string ("60L") that prepare.ts leaves alone. */
const volumeMl = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return undefined;
  const q = parseQuantity(v);
  if (!q || q.dim !== 'volume') throw new Error(`bad volume ${JSON.stringify(v)}`);
  return q.value;
};
const nameOf = (o: CddaObject | undefined): string | undefined => (typeof o?.name === 'string' ? o.name : undefined);

// --- fuels: kJ per charge. Material fuel_data.energy is per litre of the fuel item.
const fuels: VehicleDataFile['fuels'] = {};
function fuelInfo(id: string, needEnergy = true): void {
  if (fuels[id] || id === 'muscle' || id === 'animal' || id === 'wind') return;
  const it = items.get(id);
  if (!it) throw new Error(`fuel item ${id} unknown`);
  const mat = materials.get(asArr<string>(it.material as any)[0] ?? '') ?? materials.get(id);
  // DDA: the material's fuel_data.energy; BN: the item's own "fuel": {"energy"}, in kJ per ml
  // (vehicle::drain_energy's kj_per_mL).
  const perL = num(mat?.fuel_data?.energy);
  const bnPerMl = num(it.fuel?.energy);
  // Charges per litre: stack_size charges take `volume` ml (gasoline: 200 charges / 200 ml).
  const vol = num(it.volume) ?? 1000;
  const stack = num(it.stack_size) ?? num(it.count) ?? 1;
  const chargesPerL = (1000 * stack) / vol;
  const kj = id === 'battery' ? 1 : perL !== undefined ? perL / chargesPerL : bnPerMl !== undefined ? (bnPerMl * 1000) / chargesPerL : undefined;
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
  for (const k of ['power', 'epower', 'energy_consumption', 'noise_factor', 'bonus', 'size', 'm2c', 'damage_modifier', 'comfort', 'floor_bedding_warmth',
    'contact_area', 'backfire_threshold', 'damaged_power_factor'] as const) {
    const v = num(p[k]);
    if (v !== undefined) (def as any)[k] = v;
  }
  if (typeof p.fuel_type === 'string') def.fuel_type = p.fuel_type;
  if(flags.includes('ENGINE') && Array.isArray(p.exclusions) && p.exclusions.length) def.engineExcludes=p.exclusions.filter((x:unknown):x is string=>typeof x==='string');
  if (flags.includes('CRAFTER') && Array.isArray(p.integrated_tools)) def.integratedTools = p.integrated_tools.filter((x: unknown): x is string => typeof x === 'string');
  if (flags.includes('WORKBENCH')) {
    // veh_type.cpp load_workbench: vpslot_workbench defaults are multiplier 1, 0 g, 0 ml
    // (unlike furniture, whose defaults are unlimited). Mass/volume strings are g/ml after prepare.
    const wb = p.workbench;
    if (!wb || typeof wb !== 'object') throw new Error(`vehicle part ${id}: WORKBENCH without "workbench" data`);
    const mass = wb.mass === undefined ? 0 : num(wb.mass), volume = wb.volume === undefined ? 0 : volumeMl(wb.volume);
    if (mass === undefined || volume === undefined) throw new Error(`vehicle part ${id}: unparsed workbench ${JSON.stringify(wb)}`);
    def.workbench = { multiplier: num(wb.multiplier) ?? 1, mass, volume };
  }
  if (p.damage_reduction) def.damage_reduction = p.damage_reduction;
  if (p.wheel_terrain_modifiers) def.wheel_terrain_modifiers = p.wheel_terrain_modifiers;
  // Symbols per variant for glyph fallbacks (first char of "symbols" = facing north).
  if (Array.isArray(p.variants)) {
    def.variants = Object.fromEntries(p.variants.filter((v: any) => typeof v?.id === 'string')
      .map((v: any) => [v.id, { symbols: String(v.symbols ?? ''), broken: String(v.symbols_broken ?? '') }]));
  }
  // Storage capacity: fuel tanks hold a volume of liquid (ml), batteries a charge (kJ).
  const pocket = asArr<any>(it?.pocket_data)[0];
  if (flags.includes('FLUIDTANK')) def.capacity = pocket ? num(pocket.max_contains_volume) : volumeMl(it?.contains);
  // BN has no BATTERY part flag: a battery is a non-engine part burning "battery" (its item is
  // a battery MAGAZINE). The runtime keys batteries on the DDA flag, so add it.
  if (def.fuel_type === 'battery' && !flags.includes('ENGINE') && !flags.includes('BATTERY')) flags.push('BATTERY');
  if (flags.includes('BATTERY')) {
    def.capacity = pocket?.ammo_restriction ? num(pocket.ammo_restriction.battery) : num(it?.capacity);
  }
  if (flags.includes('REACTOR')) def.capacity = num(it?.max_charges) ?? num(it?.capacity);
  if (def.fuel_type) fuelInfo(def.fuel_type);
  // veh_type.cpp load_engine: "fuel_options" (inherited, e.g. from gas_turbine_engine), else
  // just the fuel_type. vehicle::start_engine falls back through these when the current one is dry.
  if (flags.includes('ENGINE')) {
    const opts = asArr<string>(p.fuel_options).filter((x): x is string => typeof x === 'string');
    const list = opts.length ? opts : def.fuel_type && def.fuel_type !== 'null' ? [def.fuel_type] : [];
    if (list.length > 1) {
      def.fuel_options = list;
      for (const f of list) fuelInfo(f);
    }
  }
  // Wheel size (inches, like CDDA's wheel items) for rendering and ground clearance.
  if (flags.includes('WHEEL') && num(it?.diameter) !== undefined) def.wheel = { diameter: num(it!.diameter)!, width: num(it!.width) ?? 6 };
  const reqs = p.requirements ?? {};
  def.requirements = {};
  for (const kind of ['install', 'removal', 'repair'] as const) {
    const raw = reqs[kind] ?? {};
    const expanded = requirements.expand(parseRequirementLists(raw.using === undefined ? raw : {}, `${id}.${kind}`), parseUsing(raw.using, `${id}.${kind}`), `${id}.${kind}`);
    if (kind === 'install') expanded.components.push([{ id: p.item, count: 1 }]);
    if (kind === 'repair' && !expanded.components.length && !expanded.tools.length && !expanded.qualities.length) continue;
    def.requirements[kind] = { ...expanded, skills: raw.skills ?? [], seconds: raw.time ?? (kind === 'removal' ? (reqs.install?.time ?? 3600) / 2 : 3600) };
  }
  const anchors = [...new Set(flags.map(f => fam('json_flag').get(f)?.requires_flag).filter((f): f is string => typeof f === 'string'))];
  if (anchors.length) def.anchors = anchors;
  if (Array.isArray(p.breaks_into)) def.breaksInto = p.breaks_into.filter((x: any) => x.item).map((x: any) => ({ item: x.item, count: Array.isArray(x.count) ? x.count : [x.count ?? 1, x.count ?? 1] }));
  parts[id] = def;
}

// --- prototypes
const vehicles: Record<string, VProtoDef> = {};
const missingParts = new Set<string>();
/**
 * Turret spawn ammo on a prototype part (veh_type.cpp vehicle_prototype::load, part object):
 * "ammo" is the percent chance the turret spawns loaded (clamped 0..100), "ammo_types" the
 * rounds it may hold (empty = the gun's default, resolved at spawn), "ammo_qty" [min, max]
 * rounds (BN default {-1, -1}: ammo_set with a negative count fills it to capacity).
 */
function turretAmmo(pp: VProtoPart, e: unknown): void {
  if (!e || typeof e !== 'object') return;
  const o = e as { ammo?: unknown; ammo_types?: unknown; ammo_qty?: unknown };
  if (o.ammo === undefined) return;
  if (typeof o.ammo !== 'number') throw new Error(`vehicle part ${pp.part}: "ammo" is not a number: ${JSON.stringify(o.ammo)}`);
  pp.ammo = Math.max(0, Math.min(100, o.ammo));
  if (o.ammo_types !== undefined) pp.ammo_types = asArr<string>(o.ammo_types as string | string[]);
  if (o.ammo_qty !== undefined) {
    if (!Array.isArray(o.ammo_qty) || o.ammo_qty.length !== 2 || o.ammo_qty.some((n) => typeof n !== 'number')) throw new Error(`vehicle part ${pp.part}: bad "ammo_qty" ${JSON.stringify(o.ammo_qty)}`);
    pp.ammo_qty = [o.ammo_qty[0], o.ammo_qty[1]];
  }
}

for (const [id, v] of fam('vehicle')) {
  const out: VProtoPart[] = [];
  // BN "blueprint" prototypes (veh_type.cpp vehicle_prototype::load): an ASCII picture whose
  // characters name palette entries (lists of parts); column = mount x (forward is to the
  // right), row = mount y, both offset by -blueprint_origin. Parsed before "parts" like BN,
  // so install order matches. 26 BN vehicles (tankers, aircraft, boats) are only defined so;
  // skipping them left those prototypes empty.
  const bpRows = asArr<string>(v.blueprint);
  if (bpRows.length && v.palette && typeof v.palette === 'object') {
    const origin = v.blueprint_origin ?? {};
    let y = -(origin.y ?? 0);
    for (const row of bpRows) {
      let x = -(origin.x ?? 0) - 1;
      for (const ch of row) {
        x += 1;
        const entry = v.palette[ch];
        if (!entry) continue;
        for (const e of asArr<any>(entry)) {
          const pid: string = typeof e === 'string' ? e : e.part;
          if (!parts[pid]) {
            missingParts.add(pid);
            continue;
          }
          const pp: VProtoPart = { x, y, part: pid };
          if (typeof e === 'object' && typeof e.fuel === 'string') {
            pp.fuel = e.fuel;
            fuelInfo(e.fuel, false);
          }
          turretAmmo(pp, e);
          out.push(pp);
        }
      }
      y += 1;
    }
  }
  for (const mount of asArr<any>(v.parts)) {
    // BN accepts both { x, y, parts: [...] } and one part per entry, { x, y, part, fuel? }
    // (veh_type.cpp: part.has_string("part") -> add_part_obj on the entry itself).
    const entries = typeof mount.part === 'string' ? [mount] : asArr<any>(mount.parts);
    for (const e of entries) {
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
      turretAmmo(pp, e);
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
