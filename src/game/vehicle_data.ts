import type { Rng } from '../core/rng';
import { warnOnce } from '../data/warn';

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
  fuel_type?: string;
  noise_factor?: number;
  /** Horn loudness, light luminance, muffler reduction... (CDDA "bonus"). */
  bonus?: number;
  /** Cargo volume, ml. */
  size?: number;
  /** Engines: share of power usable without strain, %. */
  m2c?: number;
  damage_modifier?: number;
  damage_reduction?: Record<string, number>;
  comfort?: number;
  contact_area?: number;
  wheel_terrain_modifiers?: Record<string, number[]>;
  backfire_threshold?: number;
  damaged_power_factor?: number;
  /** Tanks: ml of liquid. Batteries: kJ. */
  capacity?: number;
  variants?: Record<string, { symbols: string; broken: string }>;
  /** Wheels: item diameter/width in inches. */
  wheel?: { diameter: number; width: number };
}

export interface VProtoPart {
  x: number;
  y: number;
  part: string;
  variant?: string;
  /** Tanks: the fuel item they hold. */
  fuel?: string;
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

export async function loadVehicleData(base = '/data/'): Promise<VehicleDataFile> {
  const res = await fetch(base + 'vehicles.json');
  if (!res.ok) throw new Error(`Failed to load ${base}vehicles.json: HTTP ${res.status} (run \`npx tsx tools/extract/vehicles.ts\`)`);
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
