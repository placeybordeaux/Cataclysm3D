import type { RequirementData } from '../data/types';
import type { Rng } from '../core/rng';
import { warnOnce } from '../data/warn';
import { DATA_BASE } from '../core/assets';

// Shape of public/data/vehicles.json (tools/extract/vehicles.ts). Units: g, ml, W, kJ.

export interface VPartDef {
  id: string;
  name: string;
  /** Item the part is made from (mass, and what you'd get by removing it). */
  item: string;
  /** Slot on the mount (CDDA "location"): structure, center, under, roof, fuel_source ... */
  location?: string;
  flags: string[];
  durability: number;
  /** Mass of the part's item, g. */
  weight: number;
  color?: string;
  broken_color?: string;
  looks_like?: string;
  categories?: string[];
  /** Engines: W at full throttle (positive). Alternators: negative (they cost power). */
  power?: number;
  /** Electrical draw (negative) or generation (positive), W. */
  epower?: number;
  /** Engines: fuel energy burnt at full load, W. */
  energy_consumption?: number;
  /** BN engine exclusion classes; two engines sharing a class cannot coexist. */
  engineExcludes?: string[];
  /** BN CRAFTER pseudo tools, powered by the shared vehicle battery. */
  integratedTools?: string[];
  fuel_type?: string;
  /** Engines that burn more than one fuel (BN fuel_options), in BN's order; absent = fuel_type only. */
  fuel_options?: string[];
  noise_factor?: number;
  /** Horn loudness, light luminance, muffler reduction... (CDDA "bonus"). */
  bonus?: number;
  /** Cargo volume, ml. */
  size?: number;
  /** Engines: share of power usable without strain, %. */
  m2c?: number;
  damage_modifier?: number;
  damage_reduction?: Record<string, number>;
  /** BN vpart_info::comfort (sleep comfort of the first intact BOARDABLE part on a tile). */
  comfort?: number;
  /** BN floor_bedding_warmth in JSON legacy body-temperature units (500 = 1 °C). */
  floor_bedding_warmth?: number;
  /** BN vpslot_workbench (WORKBENCH parts): speed multiplier, mass g and volume ml before slowdown. */
  workbench?: { multiplier: number; mass: number; volume: number };
  contact_area?: number;
  wheel_terrain_modifiers?: Record<string, number[]>;
  backfire_threshold?: number;
  damaged_power_factor?: number;
  /** Tanks: ml of liquid. Batteries: kJ. */
  capacity?: number;
  variants?: Record<string, { symbols: string; broken: string }>;
  /** Wheels: item diameter/width in cm (BN "425 mm" -> 42.5). */
  wheel?: { diameter: number; width: number };
  requirements?: Partial<Record<'install' | 'removal' | 'repair', VPartWorkRequirement>>;
  /** BN json_flag requires_flag mounting dependencies. */
  anchors?: string[];
  breaksInto?: { item: string; count: [number, number] }[];
}

export interface VPartWorkRequirement extends RequirementData {
  seconds: number;
  skills: [string, number][];
}

export interface VProtoPart {
  x: number;
  y: number;
  part: string;
  variant?: string;
  /** Tanks: the fuel item they hold. */
  fuel?: string;
  /** Turrets: percent chance to spawn loaded (BN vehicle_prototype part "ammo", 0..100). */
  ammo?: number;
  /** Turrets: the rounds it may spawn with (BN "ammo_types"; absent = the gun's default ammo). */
  ammo_types?: string[];
  /** Turrets: [min, max] rounds (BN "ammo_qty"; absent = {-1, -1} = full). */
  ammo_qty?: [number, number];
}

export interface VItemSpawn {
  x: number;
  y: number;
  chance: number;
  items?: string[];
  item_groups?: string[];
}

export interface VProtoDef {
  id: string;
  name: string;
  parts: VProtoPart[];
  items: VItemSpawn[];
}

export interface VehicleDataFile {
  parts: Record<string, VPartDef>;
  vehicles: Record<string, VProtoDef>;
  /** vehicle_group id -> [prototype id, weight] */
  groups: Record<string, [string, number][]>;
  /** fuel/tank liquid item id -> energy per charge (gasoline: 1 charge = 1 ml; 0 = not a fuel) */
  fuels: Record<string, { name: string; kjPerCharge: number; chargesPerL?: number }>;
}

export async function loadVehicleData(base = DATA_BASE): Promise<VehicleDataFile> {
  const res = await fetch(base + 'vehicles.json');
  if (!res.ok) throw new Error(`Failed to load ${base}vehicles.json: HTTP ${res.status} (run \`npm run extract:vehicles\`)`);
  return res.json();
}

/**
 * Resolve a mapgen "vehicle" value to a prototype id. CDDA mapgen names vehicle groups;
 * every prototype is implicitly a group of itself. Unknown ids warn once and yield null.
 */
export function pickVehicleProto(data: VehicleDataFile, id: string, rng: Rng): string | null {
  const g = data.groups[id];
  if (g && g.length) {
    const known = g.filter(([v]) => data.vehicles[v]);
    if (!known.length) {
      warnOnce('vehicle_group', id, `[cdda-data] vehicle group ${id} has no known vehicles`);
      return null;
    }
    return rng.weighted(known);
  }
  if (data.vehicles[id]) return id;
  warnOnce('vehicle', id, `[cdda-data] unknown vehicle or vehicle group "${id}"`);
  return null;
}
