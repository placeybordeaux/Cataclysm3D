// Pure data for the vehicle screens (unit-tested): the top-down parts diagram (BN
// vehicle::part_displayed_at z-order, health colours), fuel/battery gauges, and the driving
// readout (speed vs safe/top speed, cruise target, strain).

import { has, MPH_PER_MS, type Vehicle, type VehiclePart } from '../../game/vehicle';
import type { Tone } from '../../ui2';

/** BN vpart_info z_order by location (veh_type.cpp): what shows on top in a square. */
const Z_ORDER: Record<string, number> = {
  on_roof: 9, on_cargo: 8, center: 7, under: 6, structure: 5, engine_block: 4, on_battery_mount: 3, fuel_source: 3, roof: -1, armor: -2,
};
/** BN list_order: the order parts are listed when you inspect a square. */
const LIST_ORDER: Record<string, number> = {
  structure: 1, armor: 2, on_roof: 3, roof: 4, on_cargo: 6, center: 7, engine_block: 8, fuel_source: 9, under: 10, on_battery_mount: 10,
};

export function zOrder(p: VehiclePart): number {
  return Z_ORDER[p.def.location ?? ''] ?? 0;
}

/** vehicle::part_displayed_at: the highest z-order part (the first of equals). */
export function displayedPart(parts: readonly VehiclePart[]): VehiclePart | null {
  let top: VehiclePart | null = null;
  for (const p of parts) if (!top || zOrder(p) > zOrder(top)) top = p;
  return top;
}

/** Parts of one square in BN's inspection order. */
export function listOrder(parts: readonly VehiclePart[]): VehiclePart[] {
  return [...parts].sort((a, b) => (LIST_ORDER[a.def.location ?? ''] ?? 5) - (LIST_ORDER[b.def.location ?? ''] ?? 5));
}

/** 0..1 health; broken parts are 0. */
export function partHealth(p: VehiclePart): number {
  return p.def.durability > 0 ? Math.max(0, Math.min(1, p.hp / p.def.durability)) : 1;
}

/** BN's part colour by damage: green, light green, yellow, light red, red; broken = dim. */
export function healthTone(f: number, broken = f <= 0): Tone {
  if (broken) return 'dim';
  return f >= 0.8 ? 'good' : f >= 0.5 ? 'warn' : 'bad';
}

/**
 * A one-character mark for the diagram, by what the part is (CDDA's vehicle symbols:
 * doors +/', windows ", wheels o, seats #, cargo =, engines *, tanks %, lights ^).
 */
export function partGlyph(p: VehiclePart): string {
  if (has(p, 'OPENABLE')) return p.open ? "'" : '+';
  if (has(p, 'WINDSHIELD') || has(p, 'WINDOW')) return '"';
  if (has(p, 'CONTROLS')) return '&';
  if (has(p, 'SEAT') || has(p, 'BED')) return '#';
  if (has(p, 'WHEEL')) return 'o';
  if (has(p, 'CARGO')) return '=';
  if (has(p, 'ENGINE')) return '*';
  if (has(p, 'FLUIDTANK')) return '%';
  if (has(p, 'CONE_LIGHT') || has(p, 'CIRCLE_LIGHT') || has(p, 'LIGHT')) return '^';
  if (has(p, 'HALF_BOARD') || has(p, 'OBSTACLE')) return '|';
  return 'H';
}

export interface DiagramCell {
  mx: number;
  my: number;
  /** Grid position with the front of the vehicle at the top: row 0 is the frontmost mount. */
  row: number;
  col: number;
  glyph: string;
  tone: Tone;
  /** Lowest health among the square's parts, 0..1 (a broken wheel under an intact seat shows). */
  worst: number;
  name: string;
  flags: { door?: 'open' | 'closed'; cargo?: number; controls?: boolean; engine?: boolean; broken?: number };
}

/**
 * The top-down diagram: one cell per mount point, the vehicle's front (+x) up and its right
 * side (+y) to the right, like BN's vehicle interaction screen.
 */
export function vehicleDiagram(v: Vehicle): { rows: number; cols: number; cells: DiagramCell[] } {
  const [x0, y0, x1, y1] = v.bounds();
  const cells: DiagramCell[] = [];
  for (let mx = x1; mx >= x0; mx--)
    for (let my = y0; my <= y1; my++) {
      const parts = v.partsAt(mx, my);
      const top = displayedPart(parts);
      if (!top) continue;
      const worst = Math.min(...parts.map(partHealth));
      const broken = parts.filter((p) => p.hp <= 0).length;
      const door = parts.find((p) => has(p, 'OPENABLE'));
      const cargo = parts.filter((p) => has(p, 'CARGO')).reduce((n, p) => n + p.items.length, 0);
      cells.push({
        mx, my, row: x1 - mx, col: my - y0,
        glyph: partGlyph(top),
        tone: healthTone(partHealth(top), top.hp <= 0),
        worst,
        name: top.def.name,
        flags: {
          door: door ? (door.open ? 'open' : 'closed') : undefined,
          cargo: parts.some((p) => has(p, 'CARGO')) ? cargo : undefined,
          controls: parts.some((p) => has(p, 'CONTROLS')) || undefined,
          engine: parts.some((p) => has(p, 'ENGINE')) || undefined,
          broken: broken || undefined,
        },
      });
    }
  return { rows: x1 - x0 + 1, cols: y1 - y0 + 1, cells };
}

export interface Gauge {
  id: string;
  label: string;
  /** 0..1 */
  frac: number;
  text: string;
  tone: Tone;
}

/** Fuel and battery gauges for every fuel type the vehicle stores. */
export function fuelGauges(v: Vehicle): Gauge[] {
  const out: Gauge[] = [];
  const types = [...new Set(v.parts.filter((p) => p.fuelType && p.def.capacity).map((p) => p.fuelType!))];
  // Battery last: the fuel that moves you reads first.
  types.sort((a, b) => Number(a === 'battery') - Number(b === 'battery'));
  for (const t of types) {
    const cap = v.fuelCapacity(t);
    if (!cap) continue;
    const left = v.fuelLeft(t);
    const frac = Math.max(0, Math.min(1, left / cap));
    const name = t === 'battery' ? 'Battery' : capitalize(v.vdata.fuels[t]?.name ?? t);
    const text = t === 'battery' ? `${Math.round(left)} / ${Math.round(cap)} kJ` : `${(left / 1000).toFixed(1)} / ${(cap / 1000).toFixed(1)} L`;
    out.push({ id: t, label: name, frac, text, tone: frac > 0.5 ? 'good' : frac > 0.15 ? 'warn' : 'bad' });
  }
  return out;
}

export interface DriveReadout {
  mph: number;
  reverse: boolean;
  safeMph: number;
  topMph: number;
  cruiseMph: number | null;
  /** 0 below the safe speed, rising to 1 at top speed (BN vehicle::strain). */
  strain: number;
  tone: Tone;
}

export function driveReadout(v: Vehicle, cruising: boolean): DriveReadout {
  const safeMs = v.engineOn ? v.maxVelocity(true) : 0;
  const topMs = v.engineOn ? Math.max(safeMs + 0.01, v.maxVelocity()) : 0;
  const speed = Math.abs(v.velocity);
  const strain = !v.engineOn || speed < safeMs ? 0 : Math.min(1, (speed - safeMs) / Math.max(0.01, topMs - safeMs));
  return {
    mph: Math.round(speed * MPH_PER_MS),
    reverse: v.velocity < -0.05,
    safeMph: Math.round(safeMs * MPH_PER_MS),
    topMph: Math.round(topMs * MPH_PER_MS),
    cruiseMph: cruising ? Math.round(v.cruiseVelocity / 100) : null,
    strain,
    tone: strain <= 0 ? 'info' : strain <= 0.2 ? 'warn' : 'bad',
  };
}

/** Overall condition in words (look mode's wording). */
export function conditionWord(v: Vehicle): { word: string; tone: Tone; pct: number } {
  const hp = v.parts.reduce((s, p) => s + Math.max(0, p.hp), 0), max = v.parts.reduce((s, p) => s + p.def.durability, 0);
  const pct = max > 0 ? Math.round((100 * hp) / max) : 100;
  if (pct >= 95) return { word: 'Undamaged', tone: 'good', pct };
  if (pct >= 70) return { word: 'Lightly damaged', tone: 'good', pct };
  if (pct >= 40) return { word: 'Damaged', tone: 'warn', pct };
  return { word: 'Badly damaged', tone: 'bad', pct };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
