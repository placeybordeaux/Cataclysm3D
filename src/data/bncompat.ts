// TODO(BN inventory): temporary bridge from the Bright Nights item model (src/data/types.ts,
// docs/BN_DATA_MODEL.md) to the DDA-era pocket code in src/game/item.ts & inventory.ts.
//
// BN has no pockets: a container holds one stack of one item type, worn storage is a flat
// pool shared by everything carried, and guns/tools hold ammo either as integral charges
// or through one inserted magazine. Until the inventory rewrite lands, this derives an
// approximate DDA `pocket_data` list so the old runtime keeps booting and roughly working.
// Delete this file (and its two call sites) with that rewrite; do not build new code on it.

import type { ItemDef, PocketData } from './types';

const cache = new WeakMap<ItemDef, PocketData[]>();

/** Approximate DDA pockets for a BN item def (see header). Cached per def. */
export function legacyPocketData(def: ItemDef): PocketData[] {
  let p = cache.get(def);
  if (!p) cache.set(def, (p = derive(def)));
  return p;
}

function derive(def: ItemDef): PocketData[] {
  // DDA-shaped test fixtures still carry explicit pockets
  if (def.pocket_data) return def.pocket_data;
  const out: PocketData[] = [];
  const cd = def.container_data;
  if (cd) {
    out.push({ pocket_type: 'CONTAINER', max_contains_volume: cd.contains, watertight: cd.watertight, rigid: def.rigid, airtight: cd.seals });
  }
  // worn storage: BN pools it for the wearer; the old runtime needs somewhere to put things
  if ((def.storage ?? 0) > 0) out.push({ pocket_type: 'CONTAINER', max_contains_volume: def.storage, rigid: def.rigid });
  if (def.magazine) {
    out.push({ pocket_type: 'MAGAZINE', ammo_restriction: Object.fromEntries(def.magazine.ammo_type.map((t) => [t, def.magazine!.capacity])) });
  }
  const ammo = def.ammo ?? [];
  const integral = def.subtypes.includes('GUN') ? def.clip_size ?? 0 : def.subtypes.includes('TOOL') ? def.max_charges ?? 0 : 0;
  if (ammo.length && integral > 0) {
    out.push({ pocket_type: 'MAGAZINE', ammo_restriction: Object.fromEntries(ammo.map((t) => [t, integral])) });
  }
  const mags = Object.values(def.magazines ?? {}).flat();
  if (mags.length) {
    const dflt = Object.values(def.magazine_default ?? {})[0];
    out.push({ pocket_type: 'MAGAZINE_WELL', item_restriction: [...new Set(mags)], magazine_well: def.magazine_well, ...(dflt ? { default_magazine: dflt } : {}) });
  }
  if (def.holster) {
    out.push({
      pocket_type: 'CONTAINER', holster: true, max_contains_volume: def.holster.max_volume * def.holster.multi,
      min_item_volume: def.holster.min_volume, max_item_volume: def.holster.max_volume,
      ...(def.holster.max_weight > 0 ? { max_contains_weight: def.holster.max_weight * def.holster.multi } : {}),
      ...(def.holster.flags.length ? { flag_restriction: def.holster.flags } : {}),
    });
  }
  if (def.bandolier) {
    out.push({ pocket_type: 'MAGAZINE', ammo_restriction: Object.fromEntries(def.bandolier.ammo.map((t) => [t, def.bandolier!.capacity])) });
  }
  return out;
}
