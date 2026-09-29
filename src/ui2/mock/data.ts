// Mock inventory for the ui2 showcase and the placeholder inventory screen: real item names,
// weights, volumes, pockets and sprites from public/data/items.json, arranged as a survivor's
// kit (worn clothes with pockets, a backpack, something in hand, loot on the ground). Pure
// (takes the parsed items.json), so the conservation tests can build the same store.
//
// This is *mock data*: it doesn't touch the game's inventory. The screen-porting agent replaces
// it with an adapter from the real (BN) item model to ItemView.

import type { ItemStat, ItemView, Badge } from '../logic/items';
import type { ContainerRules } from '../logic/dnd';
import type { DollSlotPos } from '../logic/layout';
import { MockStore, type RootLocation } from './store';

/** The slice of an items.json record the mock reads. */
export interface RawItem {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  subtypes?: string[];
  weight?: number;
  volume?: number;
  symbol?: string;
  color?: string;
  looks_like?: string;
  count?: number;
  charges?: number;
  flags?: string[];
  armor?: { covers?: string[]; encumbrance?: number | number[] }[];
  pocket_data?: { pocket_type?: string; max_contains_volume?: number; max_contains_weight?: number; holster?: boolean }[];
  melee_damage?: Record<string, number>;
  to_hit?: number;
  warmth?: number;
}
export type RawItems = Record<string, RawItem>;

/** Equipment slots of the mock paper doll, with the body parts an item must cover. */
export interface DollSlotDef extends DollSlotPos {
  label: string;
  parts: string[];
  /** Also required: e.g. the back slot takes bags (BELTED + pockets), outer takes OUTER. */
  needFlag?: string;
  /** Refused flags: a t-shirt slot won't take an OUTER jacket or a BELTED bag. */
  noFlag?: string[];
}

export const DOLL_SLOTS: DollSlotDef[] = [
  { id: 'head', label: 'Head', parts: ['head'], col: 1, row: 0 },
  { id: 'eyes', label: 'Eyes', parts: ['eyes'], col: 0, row: 0.5 },
  { id: 'mouth', label: 'Face', parts: ['mouth'], col: 2, row: 0.5 },
  { id: 'torso', label: 'Torso', parts: ['torso'], col: 1, row: 1.1, noFlag: ['OUTER', 'BELTED'] },
  { id: 'outer', label: 'Outer', parts: ['torso'], col: 0, row: 1.6, needFlag: 'OUTER' },
  { id: 'back', label: 'Back', parts: ['torso'], col: 2, row: 1.6, needFlag: 'BELTED' },
  { id: 'hands', label: 'Hands', parts: ['hand_l', 'hand_r'], col: 0, row: 2.7 },
  { id: 'legs', label: 'Legs', parts: ['leg_l', 'leg_r'], col: 1, row: 2.2 },
  { id: 'feet', label: 'Feet', parts: ['foot_l', 'foot_r'], col: 1, row: 3.3 },
  { id: 'wield', label: 'Wielded', parts: [], col: 2, row: 2.7 },
];

const STACKY = new Set(['AMMO', 'COMESTIBLE']);

/** Deterministic pseudo-random in [0,1) from a string (stable mock conditions). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

/** ItemView from an items.json record. `n` = stack size; `seq` makes the instance id unique. */
export function mockItem(raw: RawItem, n: number, seq: string): ItemView {
  const subtypes = raw.subtypes ?? [];
  const stackable = subtypes.some((s) => STACKY.has(s)) || raw.count !== undefined || raw.charges !== undefined;
  const pockets = (raw.pocket_data ?? []).filter((p) => (p.pocket_type ?? 'CONTAINER') === 'CONTAINER');
  const capVol = pockets.reduce((a, p) => a + (p.max_contains_volume ?? 0), 0);
  const capWt = pockets.reduce((a, p) => a + (p.max_contains_weight ?? 0), 0);
  const covers = [...new Set((raw.armor ?? []).flatMap((a) => a.covers ?? []))];
  const stats: ItemStat[] = [];
  const md = raw.melee_damage ?? {};
  if (md.bash) stats.push({ label: 'Bash', value: md.bash, better: 'higher' });
  if (md.cut) stats.push({ label: 'Cut', value: md.cut, better: 'higher' });
  if (md.stab) stats.push({ label: 'Pierce', value: md.stab, better: 'higher' });
  if (raw.to_hit !== undefined) stats.push({ label: 'To-hit', value: raw.to_hit, better: 'higher' });
  if (raw.warmth) stats.push({ label: 'Warmth', value: raw.warmth, better: 'higher' });
  const enc = (raw.armor ?? []).map((a) => (Array.isArray(a.encumbrance) ? a.encumbrance[0] : a.encumbrance ?? 0));
  if (enc.length) stats.push({ label: 'Encumbrance', value: Math.max(0, ...enc), better: 'lower' });
  const badges: Badge[] = [];
  const cond = stackable ? undefined : Math.round((0.35 + 0.65 * hash01(raw.id)) * 20) / 20;
  const flags = raw.flags ?? [];
  if (flags.includes('FRAGILE')) badges.push({ text: '◆', tone: 'warn', title: 'Fragile' });
  if (subtypes.includes('COMESTIBLE') && hash01(raw.id + 'rot') < 0.25) badges.push({ text: '!', tone: 'bad', title: 'Going bad soon' });
  return {
    id: seq,
    typeId: raw.id,
    name: raw.name ?? raw.id,
    count: n,
    stackable,
    weight: raw.weight ?? 0,
    volume: raw.volume ?? 0,
    category: raw.category ?? subtypes[0]?.toLowerCase() ?? 'other',
    condition: cond,
    badges,
    description: raw.description,
    icon: { typeId: raw.id, looksLike: raw.looks_like, symbol: raw.symbol, color: raw.color },
    covers: covers.length ? covers : undefined,
    stats,
    capacity: capVol > 0 ? { volume: capVol, weight: capWt || capVol * 2 } : undefined,
    contents: capVol > 0 ? [] : undefined,
  };
}

/** Rules for a paper-doll slot: one item, swaps, must cover the slot's parts. */
export function dollSlotRules(slot: DollSlotDef, raw: RawItems): ContainerRules {
  return {
    maxStacks: 1,
    swap: true,
    accepts: (it) => {
      // Anything can be held (a stack of nails too, like CDDA).
      if (slot.id === 'wield') return null;
      const r = raw[it.typeId];
      const flags = r?.flags ?? [];
      if (!it.covers?.some((p) => slot.parts.includes(p))) return `${it.name} isn't worn on the ${slot.label.toLowerCase()}`;
      if (slot.needFlag && !flags.includes(slot.needFlag)) return slot.needFlag === 'BELTED' ? `${it.name} isn't a bag` : `${it.name} isn't outerwear`;
      if (slot.noFlag?.some((f) => flags.includes(f))) return `${it.name} goes on the ${flags.includes('BELTED') ? 'back' : 'outer'} slot`;
      return null;
    },
  };
}

// The kit: [typeId, count, where]. Where = a doll slot, 'ground', or 'in:<typeId>' (inside
// the first item of that type). Unknown ids are skipped with a warning (the BN port may
// rename some); the store stays consistent either way.
const KIT: [string, number, string][] = [
  ['hat_ball', 1, 'head'],
  ['glasses_eye', 1, 'eyes'],
  ['tshirt', 1, 'torso'],
  ['hoodie', 1, 'outer'],
  ['backpack', 1, 'back'],
  ['jeans', 1, 'legs'],
  ['sneakers', 1, 'feet'],
  ['bat', 1, 'wield'],
  ['smart_phone', 1, 'in:jeans'],
  ['lighter', 1, 'in:jeans'],
  ['granola', 3, 'in:jeans'],
  ['aspirin', 12, 'in:hoodie'],
  ['water_clean', 2, 'in:backpack'],
  ['can_beans', 2, 'in:backpack'],
  ['bandages', 5, 'in:backpack'],
  ['flashlight', 1, 'in:backpack'],
  ['duct_tape', 1, 'in:backpack'],
  ['9mm', 23, 'in:backpack'],
  ['hammer', 1, 'in:backpack'],
  ['chips', 1, 'in:backpack'],
  ['machete', 1, 'ground'],
  ['crowbar', 1, 'ground'],
  ['jacket_leather', 1, 'ground'],
  ['gloves_leather', 1, 'ground'],
  ['boots', 1, 'ground'],
  ['mask_dust', 1, 'ground'],
  ['duffelbag', 1, 'ground'],
  ['glock_19', 1, 'ground'],
  ['apple', 4, 'ground'],
  ['cola', 2, 'ground'],
  ['nail', 40, 'ground'],
  ['rock', 3, 'ground'],
  ['2x4', 2, 'ground'],
];

export interface MockKit {
  store: MockStore;
  raw: RawItems;
  /** Location ids of the doll slots: `worn:<slot>`. */
  slot: (id: string) => string;
  /** Ids of every item type used (for icon preloading). */
  typeIds: string[];
}

export function buildMockKit(raw: RawItems, warn: (msg: string) => void = console.warn): MockKit {
  const roots: RootLocation[] = [
    { id: 'ground', name: 'Ground', rules: {}, items: [] },
    ...DOLL_SLOTS.map((s) => ({ id: `worn:${s.id}`, name: s.label, rules: dollSlotRules(s, raw), items: [] as ItemView[] })),
  ];
  const byId = new Map(roots.map((r) => [r.id, r]));
  const firstOfType = new Map<string, ItemView>();
  let seq = 0;
  const typeIds: string[] = [];
  for (const [typeId, n, where] of KIT) {
    const r = raw[typeId];
    if (!r) {
      warn(`ui2 mock: no item ${typeId} in items.json, skipped`);
      continue;
    }
    const it = mockItem(r, n, `k${++seq}`);
    typeIds.push(typeId);
    if (!firstOfType.has(typeId)) firstOfType.set(typeId, it);
    if (where.startsWith('in:')) {
      const box = firstOfType.get(where.slice(3));
      if (!box?.contents) {
        warn(`ui2 mock: container ${where.slice(3)} missing, ${typeId} goes to the ground`);
        byId.get('ground')!.items.push(it);
      } else box.contents.push(it);
    } else {
      const loc = byId.get(where === 'ground' ? 'ground' : `worn:${where}`);
      if (!loc) throw new Error(`ui2 mock: bad location ${where}`);
      loc.items.push(it);
    }
  }
  return { store: new MockStore(roots), raw, slot: (id) => `worn:${id}`, typeIds };
}
