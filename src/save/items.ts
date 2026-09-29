import type { GameData } from '../data/types';
import { Item, type ItemJSON } from '../game/item';
import type { InventoryJSON } from '../game/inventory';

export type Warn = (msg: string) => void;

/**
 * Item.fromJSON input made safe against data drift between the build that saved and the one
 * loading: unknown item types are dropped (with what they hold) with a warning instead of
 * failing the whole load. Pre-BN saves (DDA `pockets`) are migrated: a magazine goes into the
 * magazine slot, loose rounds of an integral magazine become its charges, everything else
 * becomes contents (BN put_in). Nothing is dropped except unknown types.
 */
export function sanitizeItemJSON(data: GameData, j: ItemJSON, warn: Warn): ItemJSON | null {
  if (!j || typeof j.typeId !== 'string') {
    warn(`malformed item ${JSON.stringify(j)?.slice(0, 60)} dropped`);
    return null;
  }
  const def = data.items[j.typeId];
  if (!def) {
    warn(`unknown item "${j.typeId}" dropped`);
    return null;
  }
  const clean = (list: ItemJSON[] | undefined) => (list ?? []).map((c) => sanitizeItemJSON(data, c, warn)).filter((c): c is ItemJSON => !!c);
  const out: ItemJSON = { ...j };
  delete out.pockets;
  delete out.sealed;
  if (j.contents) out.contents = clean(j.contents);
  if (j.gunmods) out.gunmods = clean(j.gunmods);
  if (j.magazine) {
    const m = sanitizeItemJSON(data, j.magazine, warn);
    if (m) out.magazine = m;
    else delete out.magazine;
  }
  if (j.pockets) {
    // Probe the type once to know where legacy pocket contents belong.
    const probe = new Item(data, def);
    const contents = out.contents ?? [];
    for (const c of clean(j.pockets.flat())) {
      const cdef = data.items[c.typeId]!;
      if (!out.magazine && cdef.subtypes.includes('MAGAZINE') && probe.magazineCompatible().includes(c.typeId)) out.magazine = c;
      else if (probe.hasIntegralMagazine() && cdef.subtypes.includes('AMMO') && (!out.ammo || out.ammo === c.typeId)) {
        out.charges = (out.charges ?? 0) + (c.charges ?? 0);
        out.ammo = c.typeId;
      } else contents.push(c);
    }
    if (contents.length) out.contents = contents;
  }
  return out;
}

export function loadItemSafe(data: GameData, j: ItemJSON, warn: Warn): Item | null {
  const clean = sanitizeItemJSON(data, j, warn);
  return clean ? Item.fromJSON(data, clean) : null;
}

/**
 * A saved character's belongings, sanitized. Pre-BN saves kept everything carried in the
 * pockets of worn clothes; in BN those clothes only give carrying capacity, so what was in them
 * moves to the flat inventory (containers, holsters and bandoliers keep their contents).
 */
export function sanitizeInventoryJSON(data: GameData, inv: InventoryJSON, warn: Warn): InventoryJSON {
  const clean = (it: ItemJSON | null) => (it ? sanitizeItemJSON(data, it, warn) : null);
  const legacy = inv.items === undefined;
  const items = (inv.items ?? []).map(clean).filter((w): w is ItemJSON => !!w);
  const unpack = (j: ItemJSON | null): ItemJSON | null => {
    if (!j || !legacy || !j.contents?.length) return j;
    const def = data.items[j.typeId]!;
    if (def.container_data || def.holster || def.bandolier || def.subtypes.includes('MAGAZINE')) return j;
    items.push(...j.contents);
    const { contents: _drop, ...rest } = j;
    void _drop;
    return rest;
  };
  const worn = inv.worn.map((w) => unpack(clean(w))).filter((w): w is ItemJSON => !!w);
  const wielded = unpack(clean(inv.wielded));
  return { wielded, worn, items };
}
