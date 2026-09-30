import type { FurnitureDef } from '../../data/types';
import type { Build } from './kit';
import * as I from './interior';
import * as X from './fixtures';
import * as O from './outdoor';

// Furniture id -> modelled archetype (docs/FURNITURE.md). Data-driven so coverage is broad:
// an ordered list of id patterns (most specific first); anything unmatched falls back to
// the voxel path. `tools/furniture-freq.ts --unmapped` ranks what is still unmapped by how
// often it appears around the start.

export type Facing =
  /** back against an adjacent wall, else along its connections, else by seed */
  | 'wall'
  /** chairs: face an adjacent table/desk, else like 'wall' */
  | 'table'
  /** rotation-free (round things, rocks): by seed so repeats don't line up */
  | 'free';

export interface Archetype {
  kind: string;
  build: Build;
  /** neighbours with the same group connect (long tables, counter runs, sofas) */
  group?: string;
  /** 'side' = connect only left/right of the piece's facing; 'all' = 4 ways */
  axis?: 'side' | 'all';
  facing: Facing;
  /** parameters for the builder */
  p?: Record<string, number | string | boolean>;
  /** height (m) items on this tile rest at; undefined = floor */
  top?: number;
}

const A = (kind: string, build: Build, facing: Facing = 'wall', extra: Partial<Archetype> = {}): Archetype => ({ kind, build, facing, ...extra });

const TABLE = A('table', I.table, 'free', { group: 'table', axis: 'all', top: 0.76 });
const COUNTER = A('counter', X.counter, 'wall', { group: 'counter', axis: 'side', top: 0.92 });

/** Ordered rules: first match wins. */
const RULES: [RegExp, Archetype][] = [
  // --- seating
  [/^f_(chair|chair_wood)$/, A('chair', I.chair, 'table', { top: 0.45 })],
  [/^f_chair_folding$/, A('chair', I.chair, 'table', { p: { material: 'metal' }, top: 0.45 })],
  [/^f_seat_airplane$/, A('armchair', I.sofa, 'wall', { top: 0.44 })],
  [/^f_camp_chair$/, A('campchair', I.campChair, 'table', { top: 0.4 })],
  [/^f_deckchair$/, A('deckchair', I.deckChair, 'wall')],
  [/^f_stool$/, A('stool', I.stool, 'free', { top: 0.62 })],
  [/^f_logstool$/, A('logstool', I.logStool, 'free', { top: 0.45 })],
  [/^f_(sofa|couch)$/, A('sofa', I.sofa, 'wall', { group: 'sofa', axis: 'side', top: 0.44 })],
  [/^f_armchair$/, A('armchair', I.sofa, 'wall', { top: 0.44 })],
  [/^f_(bench|park_bench)$/, A('bench', I.bench, 'wall', { group: 'bench', axis: 'side', top: 0.46 })],
  [/^f_metal_bench$/, A('bench', I.bench, 'wall', { group: 'bench', axis: 'side', p: { material: 'metal', back: false }, top: 0.46 })],
  // --- tables
  [/^f_table$/, TABLE],
  [/^f_(tourist_table|console_table)$/, A('table', I.table, 'free', { group: 'table', axis: 'all', p: { top: 'metal', leg: 0.03 }, top: 0.76 })],
  [/^f_(lab_bench|alien_table)$/, A('table', I.table, 'free', { group: 'table', axis: 'all', p: { top: 'metal' }, top: 0.9 })],
  [/^f_roulette_table$/, A('table', I.table, 'free', { group: 'table', axis: 'all', p: { cloth: true }, top: 0.8 })],
  [/^f_coffee_table$/, A('coffeetable', I.coffeeTable, 'wall', { group: 'coffee', axis: 'side', top: 0.44 })],
  [/^f_desk$/, A('desk', I.desk, 'wall', { group: 'desk', axis: 'side', top: 0.76 })],
  [/^f_(workbench|survivors_workbench)$/, A('workbench', I.table, 'wall', { group: 'workbench', axis: 'side', p: { h: 0.9, leg: 0.08 }, top: 0.9 })],
  [/^f_pool_table$/, A('pooltable', I.poolTable, 'free', { group: 'pool', axis: 'all', top: 0.8 })],
  // --- beds
  [/^f_(bed|hospital_bed|scan_bed|autodoc_couch)$/, A('bed', I.bed, 'wall', { group: 'bed', axis: 'all', top: 0.48 })],
  [/^f_bed_frame$/, A('bed', I.bed, 'wall', { group: 'bed', axis: 'all', p: { frameOnly: true }, top: 0.3 })],
  [/^f_bunkbed$/, A('bunkbed', I.bunkBed, 'wall', { top: 0.44 })],
  [/^f_triple_bunkbed$/, A('bunkbed', I.bunkBed, 'wall', { p: { triple: true }, top: 0.44 })],
  [/^f_(makeshift_bed|straw_bed|hay)$/, A('floorbed', I.floorBed, 'wall', { group: 'floorbed', axis: 'all', p: { straw: true, h: 0.22 }, top: 0.22 })],
  [/^f_(floor_mattress|down_mattress|wool_mattress|mattress)$/, A('floorbed', I.floorBed, 'wall', { group: 'floorbed', axis: 'all', top: 0.18 })],
  // --- storage
  [/^f_dresser$/, A('dresser', I.dresser)],
  [/^f_(wardrobe|gunsafe_ml|gunsafe_mj)$/, A('wardrobe', I.wardrobe)],
  [/^f_glass_cabinet$/, A('wardrobe', I.wardrobe, 'wall', { p: { doors: 2, d: 0.22 } })],
  [/^f_bookcase$/, A('bookcase', I.bookcase)],
  [/^f_(rack|utility_shelf|metal_butcher_rack)$/, A('shelf', I.shelving, 'wall', { group: 'shelf', axis: 'side', top: 0.68 })],
  [/^f_rack_wood$/, A('shelf', I.shelving, 'wall', { group: 'shelf', axis: 'side', p: { material: 'wood' }, top: 0.68 })],
  [/^f_warehouse_shelf$/, A('shelf', I.shelving, 'wall', { group: 'wshelf', axis: 'side', p: { h: 2.6, d: 0.45, shelves: 4 }, top: 0.9 })],
  [/^f_locker$/, A('locker', I.locker)],
  [/^f_(filing_cabinet|file_cabinet)$/, A('filing', I.filingCabinet)],
  [/^f_(foot_locker|chest)$/, A('chest', I.chest, 'wall', { top: 0.46 })],
  [/^f_(safe_c|safe_l|safe_o|gun_safe_el|gunsafe_c|gunsafe_o)$/, A('safe', I.filingCabinet, 'wall', { p: { w: 0.36, h: 1.0 } })],
  [/^f_rack_coat$/, A('coatrack', I.coatRack, 'free')],
  [/^f_clothing_rail$/, A('clothingrail', I.clothingRail, 'wall', { group: 'rail', axis: 'side' })],
  [/^f_entertainment_center$/, A('tvstand', I.tvStand)],
  [/^f_(piano|organ)$/, A('piano', I.piano)],
  // --- kitchen
  [/^f_counter(_gate_[co])?$/, COUNTER],
  [/^f_cupboard$/, A('cupboard', X.cupboard, 'wall', { group: 'counter', axis: 'side', top: 0.92 })],
  [/^f_sink$/, A('sink', X.sink, 'wall', { group: 'counter', axis: 'side', top: 0.8 })],
  [/^f_(oven|rvoven)$/, A('oven', X.oven, 'wall', { top: 0.92 })],
  [/^f_(fridge|fridge_off|fridge_on)$/, A('fridge', X.fridge)],
  [/^f_(freezer|freezer_off|freezer_on|freezer_industrial|freezer_industrial_off|freezer_industrial_on|sample_freezer)$/, A('fridge', X.fridge, 'wall', { p: { split: false, color: 'metal' } })],
  [/^f_(minifridge|minifridge_off|minifridge_on|minifreezer|minifreezer_off|minifreezer_on)$/, A('minifridge', X.underCounter, 'wall', { top: 0.86 })],
  [/^f_dishwasher$/, A('dishwasher', X.underCounter, 'wall', { p: { kind: 'dishwasher' }, top: 0.86 })],
  [/^f_(glass_fridge|glass_fridge_off|glass_fridge_on|glass_freezer|glass_freezer_off|glass_freezer_on)$/, A('glassfridge', X.glassFridge)],
  [/^f_washer$/, A('washer', X.washer, 'wall', { top: 0.88 })],
  [/^f_dryer$/, A('washer', X.washer, 'wall', { p: { dryer: true }, top: 0.88 })],
  // --- bathroom
  [/^f_toilet$/, A('toilet', X.toilet)],
  [/^f_(bathtub|bathtub_money)$/, A('bathtub', X.bathtub, 'wall', { group: 'bathtub', axis: 'side' })],
  [/^f_shower$/, A('shower', X.shower, 'wall')],
  // --- shops
  [/^f_(displaycase|displaycase_o|displaycase_b)$/, A('displaycase', X.displayCase, 'wall', { group: 'display', axis: 'side', top: 0.47 })],
  [/^f_(vending_c|vending_o|vending_reinforced|gridsoda_machine|water_dispenser)$/, A('vending', X.vending)],
  // --- boxes & bins
  [/^f_crate_c$/, A('crate', X.crate, 'free', { top: 0.76 })],
  [/^f_crate_o$/, A('crate', X.crate, 'free', { p: { open: true }, top: 0.45 })],
  [/^f_cardboard_box$/, A('box', X.cardboardBox, 'free', { top: 0.5 })],
  [/^f_(trashcan|recycle_bin|30gal_firebarrel|55gal_firebarrel)$/, A('bin', X.trashcan, 'free')],
  [/^f_dumpster$/, A('dumpster', X.dumpster, 'wall')],
  [/^f_barricade_road$/, A('barricade', X.barricade, 'free')],
  [/^f_(sandbag_half|earthbag_half)$/, A('sandbags', X.sandbags, 'free', { group: 'sandbag', axis: 'side' })],
  [/^f_(sandbag_wall|earthbag_wall)$/, A('sandbags', X.sandbags, 'free', { group: 'sandbag', axis: 'side', p: { full: true } })],
  // --- utilities & appliances
  [/^f_water_heater$/, A('tank', X.tank, 'free')],
  [/^f_(standing_tank|standing_tank_plumbed|wood_keg)$/, A('tank', X.tank, 'free', { p: { r: 0.4, h: 1.4 } })],
  [/^f_(air_conditioner|grid_air_conditioner|grid_air_conditioner_off|grid_air_conditioner_on)$/, A('machine', X.machine, 'wall', { p: { fan: true, h: 0.8 } })],
  [/^f_(home_furnace|air_filter|water_purifier|water_purifier_off|water_purifier_on|centrifuge|cellphone_booster|space_heater|space_heater_off|space_heater_on|space_heater_large|space_heater_large_off|space_heater_large_on|server|speaker_cabinet|battery|charger|shredder)$/, A('machine', X.machine, 'wall', { p: { h: 1.1 } })],
  [/^f_fireplace$/, A('fireplace', X.fireplace)],
  [/^f_woodstove$/, A('woodstove', X.woodStove)],
  [/^f_(floor_lamp|floor_lamp_off|floor_lamp_on)$/, A('lamp', X.floorLamp, 'free')],
  [/^f_(indoor_plant|indoor_plant_y)$/, A('plant', X.pottedPlant, 'free')],
  // --- street & yard
  [/^f_mailbox$/, A('mailbox', O.mailbox, 'free')],
  [/^f_(street_light|street_light_rewired|street_light_rewired_off|street_light_rewired_on)$/, A('streetlight', O.streetLight, 'free')],
  [/^f_traffic_light$/, A('trafficlight', O.trafficLight, 'free')],
  [/^f_utility_pole$/, A('pole', O.utilityPole, 'free')],
  [/^f_(sign|sign_warning|bulletin)$/, A('sign', O.sign, 'free')],
  [/^f_grave_stone$/, A('gravestone', O.gravestone, 'free')],
  [/^f_grave_stone_old$/, A('gravestone', O.gravestone, 'free', { p: { old: true } })],
  [/^f_grave_monument$/, A('monument', O.monument, 'free')],
  [/^f_grave_head$/, A('mound', O.graveMound, 'free')],
  [/^f_boulder_small(_harvested)?$/, A('boulder', O.boulder, 'free', { p: { r: 0.22 } })],
  [/^f_boulder_medium$/, A('boulder', O.boulder, 'free', { p: { r: 0.36 } })],
  [/^f_boulder_large$/, A('boulder', O.boulder, 'free', { p: { r: 0.5 } })],
  [/^f_(rubble|rubble_rock|rubble_landfill|wreckage)$/, A('rubble', O.rubble, 'free')],
  [/^f_birdbath$/, A('birdbath', O.birdbath, 'free')],
  [/^f_rotary_clothesline$/, A('clothesline', O.clothesline, 'free')],
  [/^f_chimney$/, A('roof', O.roofProp, 'free', { p: { kind: 'chimney' } })],
  [/^f_roof_turbine_vent$/, A('roof', O.roofProp, 'free', { p: { kind: 'turbine' } })],
  [/^f_TV_antenna$/, A('roof', O.roofProp, 'free', { p: { kind: 'antenna' } })],
  [/^f_small_satelitte_dish$/, A('roof', O.roofProp, 'wall', { p: { kind: 'dish' } })],
  [/^f_vent_pipe$/, A('roof', O.roofProp, 'free', { p: { kind: 'pipe' } })],
  [/^f_(solar_unit|solar_unit_v2|foldable_solar_unit)$/, A('solar', O.solarPanel, 'wall')],
  [/^f_(flagpole_metal|flagpole_wood|us_flag_metal|us_flag_wood|pirate_flag_metal|pirate_flag_wood)$/, A('flag', O.flagpole, 'free')],
  [/^f_dive_block$/, A('pedestal', O.pedestal, 'wall')],
];

const cache = new Map<string, Archetype | null>();

/** The archetype for a furniture id, or null (voxel / billboard fallback). */
export function archetypeFor(id: string, _fd?: FurnitureDef): Archetype | null {
  let a = cache.get(id);
  if (a !== undefined) return a;
  a = RULES.find(([re]) => re.test(id))?.[1] ?? null;
  cache.set(id, a);
  return a;
}

/** Every archetype kind the catalog can produce (tests, docs). */
export const ARCHETYPE_KINDS = [...new Set(RULES.map(([, a]) => a.kind))];
