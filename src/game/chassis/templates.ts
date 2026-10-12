// Chassis templates (vehicles v3, docs/design/VEHICLES_V3.md): the ladder of authored
// vehicle bodies every BN vehicle is mapped onto. A template owns the body the game collides
// with and the renderer draws (drawn = gameplay), its seats, door / window openings and typed
// sockets; BN parts keep their stats and are assigned to sockets (mapping.ts).
//
// Pure data: no three.js, no DOM. The style dimensions (STYLE_PARAMS) started as the wave-3
// body styles of src/render/vehicleLayout.ts and live here now, so the renderer draws from
// the template instead of owning the shape.

/** How the renderer draws a template's body (vehicleModel / vehicleBikes / vehicleFrame). */
export type BodyStyle = 'sedan' | 'hatch' | 'sports' | 'suv' | 'pickup' | 'van' | 'minivan' | 'bus' | 'truck' | 'motorcycle' | 'bicycle' | 'frame';

/** Style dimensions, metres above the ground (z-level floor) unless noted. */
export interface StyleParams {
  /** Underside of the body (ground clearance). */
  sill: number;
  /** Beltline: bottom of the side windows, top of the doors. */
  belt: number;
  /** Bonnet height at the windscreen and at the nose. */
  hood: number;
  nose: number;
  /** Roof of the cabin. */
  roof: number;
  /** Trunk lid / bed rail / flat deck height behind the cabin. */
  deck: number;
  /** Cargo box / sleeper roof (0 = no box). */
  box: number;
  /** Horizontal run of the windscreen (m): long = raked (sports), short = upright (bus). */
  rake: number;
  /** Horizontal run of the rear glass (sedans / fastbacks). */
  rearRake: number;
  /** Bulge of hood / roof / nose across the width (m). */
  crown: number;
  /** Radius of the rounded edge between the sides and the top (m). */
  shoulder: number;
  /** How much narrower the greenhouse is at the roof than at the beltline (fraction of width). */
  tumble: number;
  /** Visual width per grid column (m). */
  widthPerCol: number;
  /** Visual length per grid row: BN grids run long (a car is 6 rows), so bodies are
   * shortened around the grid's middle toward real proportions (~4.8 m x 1.8 x 1.45 for a
   * sedan, drawn ~1.17x to match the world's scale). */
  lengthScale: number;
  /** Nose face goes straight up into the windscreen (bus, cab-over van). */
  flatFront: boolean;
  /** Motorhomes: the box body runs forward over the cab (the overcab bunk). */
  overcab?: boolean;
  /** Tyre sidewall added to the rim radius, and an extra scale for chunky off-roaders. */
  wheelScale: number;
  bumper: 'chrome' | 'black' | 'body';
  /** Pillars and window frames painted black (modern) or body colour (older / utility). */
  blackPillars: boolean;
  /** Headlamp centre height and half-size (m). */
  lampY: number;
  lampW: number;
  lampH: number;
  /** Interior trim colour. */
  interior: number;
}

const BASE: StyleParams = {
  sill: 0.3, belt: 0.98, hood: 0.98, nose: 0.78, roof: 1.62, deck: 1.02, box: 0, rake: 0.8, rearRake: 0.8,
  crown: 0.06, shoulder: 0.12, tumble: 0.14, widthPerCol: 0.53, lengthScale: 0.93, flatFront: false, wheelScale: 1, bumper: 'black',
  blackPillars: true, lampY: 0.7, lampW: 0.2, lampH: 0.06, interior: 0x2e2e32,
};

export const STYLE_PARAMS: Record<BodyStyle, StyleParams> = {
  sedan: { ...BASE },
  hatch: { ...BASE, roof: 1.64, rake: 0.78 },
  sports: { ...BASE, sill: 0.22, belt: 0.82, hood: 0.8, nose: 0.6, roof: 1.3, widthPerCol: 0.54, lengthScale: 0.94, deck: 0.84, rake: 1.05, rearRake: 1.3, crown: 0.07, shoulder: 0.14, tumble: 0.2, lampY: 0.55, lampW: 0.22, lampH: 0.05 },
  suv: { ...BASE, sill: 0.42, belt: 1.16, hood: 1.14, nose: 1.0, roof: 1.95, widthPerCol: 0.54, lengthScale: 0.88, deck: 1.16, rake: 0.8, crown: 0.05, shoulder: 0.1, tumble: 0.1, wheelScale: 1.15, lampY: 0.9, lampW: 0.22, lampH: 0.08 },
  pickup: { ...BASE, sill: 0.44, belt: 1.18, hood: 1.2, nose: 1.08, roof: 1.95, widthPerCol: 0.55, lengthScale: 0.92, deck: 1.18, rake: 0.75, crown: 0.04, shoulder: 0.08, tumble: 0.08, wheelScale: 1.15, bumper: 'chrome', lampY: 0.95, lampW: 0.2, lampH: 0.09 },
  van: { ...BASE, sill: 0.4, belt: 1.25, hood: 1.28, nose: 1.1, roof: 2.2, deck: 1.25, box: 2.6, rake: 0.55, crown: 0.03, shoulder: 0.08, tumble: 0.06, widthPerCol: 0.54, lengthScale: 0.95, wheelScale: 1.05, lampY: 0.95, lampW: 0.18, lampH: 0.1, blackPillars: false },
  minivan: { ...BASE, sill: 0.34, belt: 1.12, hood: 1.08, nose: 0.92, roof: 2.05, lengthScale: 0.86, deck: 1.1, rake: 0.7, crown: 0.05, shoulder: 0.16, tumble: 0.06, lampY: 0.85, lampW: 0.18, lampH: 0.09 },
  bus: { ...BASE, sill: 0.34, belt: 1.35, hood: 1.35, nose: 1.2, roof: 2.55, deck: 1.35, rake: 0.3, crown: 0.04, shoulder: 0.14, tumble: 0.03, widthPerCol: 0.53, lengthScale: 0.97, flatFront: true, wheelScale: 1.1, lampY: 0.75, lampW: 0.16, lampH: 0.1, blackPillars: true },
  truck: { ...BASE, sill: 0.5, belt: 1.5, hood: 1.55, nose: 1.4, roof: 2.45, deck: 1.1, box: 2.6, rake: 0.45, crown: 0.03, shoulder: 0.08, tumble: 0.05, widthPerCol: 0.5, lengthScale: 0.97, wheelScale: 1.1, bumper: 'chrome', lampY: 1.0, lampW: 0.18, lampH: 0.11, blackPillars: false },
  motorcycle: { ...BASE, lengthScale: 1 },
  bicycle: { ...BASE, lengthScale: 1 },
  frame: { ...BASE, blackPillars: false, lengthScale: 1 },
};

/**
 * Socket kinds and the BN part locations each accepts (vpart "location", a free string in BN:
 * veh_type.cpp finalize). Parts with an empty or "on_*" location are fittings: BN stacks them
 * freely on a tile, and here they ride on whichever socket hosts their tile (mapping.ts).
 */
export type SocketKind = 'frame' | 'wheel' | 'cabin' | 'panel' | 'roof' | 'engine' | 'interior';
export const SOCKET_KINDS: readonly SocketKind[] = ['frame', 'wheel', 'cabin', 'panel', 'roof', 'engine', 'interior'];

export const SOCKET_LOCATIONS: Record<SocketKind, readonly string[]> = {
  /** The chassis rail under a cell: frames, rams, external tanks, non-wheel running gear, belly tanks. */
  frame: ['structure', 'under', 'fuel_source', 'armor'],
  /** An axle position: the wheel mount and the wheel (or tread) under it. */
  wheel: ['axle', 'under'],
  /** A cell of the passenger cabin: seats, controls, aisles, cargo, beds, stations. */
  cabin: ['center', 'on_windshield', 'armor', 'fuel_source'],
  /**
   * One side of the shell at a cell (left / right / front / rear): doors, windows, boards,
   * armour, and protrusions hung on it (wing mirrors, side rams: BN "structure" PROTRUSION).
   */
  panel: ['center', 'armor', 'on_windshield', 'structure'],
  /** The roof over a cell and what's mounted on it. */
  roof: ['roof', 'on_roof', 'on_ceiling'],
  /** The engine bay: engines, tanks and batteries next to them. */
  engine: ['engine_block', 'fuel_source', 'center', 'armor'],
  /** A load-space cell behind or around the cabin (bed, box, deck): cargo, tanks, stations. */
  interior: ['center', 'fuel_source', 'armor', 'on_windshield'],
};

/** Locations that stack freely on a tile (BN: empty location) or sit on another part. */
export const FITTING_LOCATIONS: readonly string[] = ['', 'anywhere', 'on_seat', 'on_controls', 'on_cargo', 'on_lockable_cargo', 'on_battery_mount', 'door_lock'];

/** Rungs of the ladder (VEHICLES_V3.md Q1): small rungs are fast, the top rung is the home. */
export type Rung = 'bike' | 'car' | 'utility' | 'heavy' | 'home' | 'frame';

export type TemplateId =
  | 'bicycle' | 'scooter' | 'motorcycle'
  | 'hatch' | 'sedan' | 'sports'
  | 'suv' | 'pickup' | 'minivan' | 'van'
  | 'box_truck' | 'bus' | 'semi_cab' | 'heavy_truck' | 'trailer'
  | 'rig'
  | 'frame' | 'frame_small' | 'frame_tracked' | 'frame_boat' | 'frame_air';

/** Where in the body a section of rows sits (layout.ts buildSections). */
export type RowKind = 'hood' | 'shield' | 'cabin' | 'rearglass' | 'box' | 'bed' | 'deck' | 'flat';

export interface ChassisTemplate {
  id: TemplateId;
  name: string;
  rung: Rung;
  /**
   * 'body' = an authored shell (the drawn body is the collision body); 'bike' = one track of
   * wheels, a narrow body; 'frame' = an honest home-made grid, collision = its cells.
   */
  family: 'body' | 'bike' | 'frame';
  style: BodyStyle;
  /** Grid envelope accepted (BN cells): body columns (width) and rows (length), inclusive. */
  cols: [number, number];
  rows: [number, number];
  /**
   * The drawn / collision body this template promises at 'real' width (m): tests check that
   * every BN vehicle mapped onto it lands inside. null for frame templates (cells).
   */
  length: [number, number] | null;
  width: [number, number] | null;
  /** Sections whose cells are engine bay (BN engine_block parts elsewhere don't fit the shell). */
  engineBay: RowKind[] | 'any';
  /** Style dimension overrides on top of STYLE_PARAMS[style]. */
  params?: Partial<StyleParams>;
  /** Walkable inside while parked by design (the top rung). */
  walkable?: boolean;
  blurb: string;
}

// Where BN puts engines: under the bonnet, often straddling the cowl (the windscreen row).
const CAR_BAY: RowKind[] = ['hood', 'shield'];
// Rear- and mid-engined cars (BN's sports cars, the beetle, the bubble car) keep it behind or
// under the seats.
const CAR_BAY_ANY_END: RowKind[] = ['hood', 'shield', 'cabin', 'deck', 'rearglass', 'flat'];
// Vans, trucks and armoured SUVs: under the cab too (the "doghouse" between the front seats).
const CAB_BAY: RowKind[] = ['hood', 'shield', 'cabin'];

export const TEMPLATES: Record<TemplateId, ChassisTemplate> = {
  bicycle: { id: 'bicycle', name: 'Bicycle', rung: 'bike', family: 'bike', style: 'bicycle', cols: [1, 2], rows: [1, 5], length: [0.9, 5.1], width: [0.5, 0.7], engineBay: 'any', blurb: 'A pedal frame: one track of wheels, a saddle and bars.' },
  scooter: { id: 'scooter', name: 'Scooter', rung: 'bike', family: 'bike', style: 'motorcycle', cols: [1, 1], rows: [2, 4], length: [1.9, 4.1], width: [0.7, 0.9], engineBay: 'any', blurb: 'A step-through: small wheels, a small engine under the seat.' },
  motorcycle: { id: 'motorcycle', name: 'Motorcycle', rung: 'bike', family: 'bike', style: 'motorcycle', cols: [1, 2], rows: [2, 5], length: [1.9, 5.1], width: [0.7, 0.9], engineBay: 'any', blurb: 'Two wheels and an engine between your knees; a sidecar bolts on at the side.' },
  hatch: { id: 'hatch', name: 'Hatchback', rung: 'car', family: 'body', style: 'hatch', cols: [3, 4], rows: [4, 5], length: [3.6, 4.8], width: [1.8, 2.3], engineBay: CAR_BAY_ANY_END, blurb: 'A small two-box car: bonnet, cabin, hatch.' },
  sedan: { id: 'sedan', name: 'Sedan', rung: 'car', family: 'body', style: 'sedan', cols: [3, 4], rows: [5, 10], length: [4.5, 9.4], width: [1.8, 2.3], engineBay: CAR_BAY, blurb: 'Three boxes: bonnet, cabin, trunk.' },
  sports: { id: 'sports', name: 'Sports car', rung: 'car', family: 'body', style: 'sports', cols: [3, 5], rows: [4, 8], length: [3.6, 7.6], width: [1.8, 2.8], engineBay: CAR_BAY_ANY_END, blurb: 'Low and raked; the engine may sit behind the seats.' },
  suv: { id: 'suv', name: 'SUV', rung: 'utility', family: 'body', style: 'suv', cols: [3, 5], rows: [6, 8], length: [5.0, 7.2], width: [1.9, 2.8], engineBay: CAB_BAY, blurb: 'A tall two-box on big wheels: the cabin runs to the tail.' },
  pickup: { id: 'pickup', name: 'Pickup', rung: 'utility', family: 'body', style: 'pickup', cols: [3, 5], rows: [6, 8], length: [5.2, 7.4], width: [1.9, 2.8], engineBay: CAR_BAY, blurb: 'A cab and an open bed.' },
  minivan: { id: 'minivan', name: 'Minivan', rung: 'utility', family: 'body', style: 'minivan', cols: [3, 4], rows: [6, 8], length: [5.0, 6.9], width: [1.8, 2.3], engineBay: CAR_BAY_ANY_END, blurb: 'One tall volume from windscreen to tail.' },
  van: { id: 'van', name: 'Van', rung: 'utility', family: 'body', style: 'van', cols: [3, 5], rows: [6, 9], length: [5.5, 8.6], width: [1.8, 2.8], engineBay: CAB_BAY, blurb: 'A cab and a tall box: a panel van on a car-width chassis.' },
  box_truck: { id: 'box_truck', name: 'Box truck', rung: 'heavy', family: 'body', style: 'van', cols: [5, 7], rows: [6, 12], length: [6.0, 11.5], width: [2.6, 3.3], engineBay: CAB_BAY, blurb: 'A cab and a wide box body: cube vans, ambulances, food trucks, motorhomes.' },
  bus: { id: 'bus', name: 'Bus', rung: 'heavy', family: 'body', style: 'bus', cols: [4, 7], rows: [9, 16], length: [9.5, 15.6], width: [2.6, 3.3], engineBay: ['hood', 'cabin', 'shield'], blurb: 'One long cabin: rows of seats, an aisle, doors on the kerb side.' },
  semi_cab: { id: 'semi_cab', name: 'Semi tractor', rung: 'heavy', family: 'body', style: 'truck', cols: [5, 8], rows: [8, 12], length: [8.5, 11.8], width: [2.6, 3.3], engineBay: ['hood', 'shield'], blurb: 'A sleeper cab over a long nose, and a fifth wheel behind.' },
  heavy_truck: { id: 'heavy_truck', name: 'Heavy truck', rung: 'heavy', family: 'body', style: 'truck', cols: [4, 7], rows: [7, 13], length: [6.5, 12.8], width: [2.4, 3.3], engineBay: ['hood', 'shield', 'cabin'], blurb: 'A crew cab and a flatbed, lockers or a tank: fire engines, flatbeds, army trucks.' },
  trailer: { id: 'trailer', name: 'Trailer', rung: 'heavy', family: 'body', style: 'truck', cols: [4, 8], rows: [6, 14], length: [5.8, 13.8], width: [2.4, 3.3], engineBay: [], params: { box: 3.1, sill: 0.95 }, blurb: 'A box on high sills; no cab (towing is future work).' },
  rig: {
    id: 'rig', name: 'Rig', rung: 'home', family: 'body', style: 'truck', cols: [5, 7], rows: [10, 16], length: [9.8, 15.8], width: [2.6, 3.3], engineBay: ['hood', 'shield', 'cabin'],
    params: { box: 3.0, deck: 1.2 }, walkable: true,
    blurb: 'The top rung: a long deck with a walkable box: the rolling home. Built, not found (phase 3).',
  },
  frame: { id: 'frame', name: 'Frame', rung: 'frame', family: 'frame', style: 'frame', cols: [1, 64], rows: [1, 64], length: null, width: null, engineBay: 'any', blurb: 'An honest home-made grid: golf carts, tractors, draisines, odd builds.' },
  frame_small: { id: 'frame_small', name: 'Cart', rung: 'frame', family: 'frame', style: 'frame', cols: [1, 2], rows: [1, 2], length: null, width: null, engineBay: 'any', blurb: 'One or two cells: carts, wheelchairs, barrows, boards.' },
  frame_tracked: { id: 'frame_tracked', name: 'Armoured frame', rung: 'frame', family: 'frame', style: 'frame', cols: [1, 64], rows: [1, 64], length: null, width: null, engineBay: 'any', blurb: 'Tanks, APCs and IFVs: armoured hulls on tracks or heavy wheels.' },
  frame_boat: { id: 'frame_boat', name: 'Hull', rung: 'frame', family: 'frame', style: 'frame', cols: [1, 64], rows: [1, 64], length: null, width: null, engineBay: 'any', blurb: 'Boats, rafts and hovercraft: a floating grid.' },
  frame_air: { id: 'frame_air', name: 'Airframe', rung: 'frame', family: 'frame', style: 'frame', cols: [1, 64], rows: [1, 64], length: null, width: null, engineBay: 'any', blurb: 'Planes, helicopters, blimps: wings and rotors on a grid.' },
};

export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

export function templateOf(id: string): ChassisTemplate {
  const t = TEMPLATES[id as TemplateId];
  if (!t) throw new Error(`unknown chassis template "${id}" (known: ${TEMPLATE_IDS.join(', ')})`);
  return t;
}

/** Style dimensions of a template: its style's, with the template's overrides. */
export function templateParams(t: ChassisTemplate): StyleParams {
  return { ...STYLE_PARAMS[t.style], ...(t.params ?? {}) };
}

/**
 * Version of the chassis data saved per vehicle (`VehicleJSON.chassis.v`). Saves without it
 * hold plain BN grids (before vehicles v3) and are mapped onto templates once on load.
 */
export const CHASSIS_VERSION = 1;
