import { Rng, hashSeed } from '../../core/rng';
import type { SpecialSpawns } from '../worldgen_data';

// Overmap monster groups placed by overmap specials (genVersion >= 3): BN's
// overmap_special_spawns, e.g. an anthill's roaming GROUP_ANT colony of 1000-2000 within 10-30
// submaps. Ports overmap::place_special's spawn step (overmap.cpp 5991-5998) and
// overmap::add_mon_group (6568-6630), which splits a big group into one radius-1 group per
// submap. Groups are pure functions of (seed, special uid), so like the rest of the overmap
// they are regenerated, never saved; src/game/mongroups.ts materialises them near the player
// and saves which ones are spent.

/** Submaps per OMT side (BN SEEX: a 24-tile OMT is 2x2 submaps of 12 tiles). */
export const SM_PER_OMT = 2;
export const SM_SIZE = 12;

/** One BN mongroup of radius 1: `population` points of `group` on one submap. */
export interface MonGroup {
  /** "sx,sy,z,uid": stable across sessions, the key saves record spent groups by */
  key: string;
  group: string;
  /** absolute submap coordinates (tile = s * SM_SIZE) */
  sx: number;
  sy: number;
  z: number;
  population: number;
  /** SpecialInstance uid of the special that placed it */
  special: number;
}

/**
 * BN place_special + add_mon_group for one placed special whose origin (the fixed special's
 * [0,0,0] point, or a mutable special's root) is OMT (x, y, z). Its own RNG stream per special
 * keeps every other generation draw where it was.
 *
 *  - pop = rng(population), rad = rng(radius): one group at the origin OMT's north-west submap
 *    (project_to<coords::sm>), rad in submaps.
 *  - rad 1 stays one group with all of pop. Otherwise (non-diffuse) every submap with
 *    trig_dist <= rad (BN truncates the float distance into an int) gets
 *    pop_here = (rad - dist) / rad * pop / (pi rad^2 + 1), whose fraction becomes one more
 *    point with x_in_y(fraction * 10000, 10000); rad 0 puts all of pop on the origin submap.
 *    The density falls off linearly, so the groups hold about a third of pop in all (BN).
 */
export function specialMonGroups(seed: number, uid: number, spawns: SpecialSpawns, x: number, y: number, z: number): MonGroup[] {
  const rng = new Rng(hashSeed(seed, uid, 0x6d67));
  const pop = rng.int(spawns.population[0], spawns.population[1]);
  const rad = rng.int(spawns.radius[0], spawns.radius[1]);
  const sx0 = x * SM_PER_OMT, sy0 = y * SM_PER_OMT;
  const make = (sx: number, sy: number, population: number): MonGroup => ({ key: `${sx},${sy},${z},${uid}`, group: spawns.group, sx, sy, z, population, special: uid });
  if (rad === 1) return pop > 0 ? [make(sx0, sy0, pop)] : [];
  const total = rad * rad * Math.PI + 1;
  const out: MonGroup[] = [];
  for (let dx = -rad; dx <= rad; dx++)
    for (let dy = -rad; dy <= rad; dy++) {
      const dist = Math.trunc(Math.sqrt(dx * dx + dy * dy));
      if (dist > rad) continue;
      const here = rad === 0 ? pop : ((rad - dist) / rad) * pop / total;
      let p = Math.max(0, Math.floor(here));
      if (here - p !== 0) {
        const mod = Math.trunc(10000 * (here - p));
        if (rng.int(1, 10000) <= mod) p++;
      }
      if (p > 0) out.push(make(sx0 + dx, sy0 + dy, p));
    }
  return out;
}
