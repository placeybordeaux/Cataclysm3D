import { describe, expect, it } from 'vitest';
import { hashString } from '../src/core/rng';
import { LAB_SPECIAL, MICROLAB_SPECIAL, CLASSIC_LAB_SPECIAL, Overmap, REGION, type SpecialInstance } from '../src/world/overmap/overmap';
import { parseOterId, rotateOffset } from '../src/world/overmap/oter';
import { loadNodeData } from '../tools/lib/node_data';

const { wg } = loadNodeData();
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
const SEEDS = [1, 2, 3, 42, 743667900];
const LO = -REGION, HI = 2 * REGION;

/** Every special instance with a z0 tile in the 3x3 regions around region 0,0. */
function specials(om: Overmap): SpecialInstance[] {
  const out = new Map<number, SpecialInstance>();
  for (let y = LO; y < HI; y++)
    for (let x = LO; x < HI; x++) {
      const s = om.omtAt(x, y, 0).special;
      if (s) out.set(s.uid, s);
    }
  return [...out.values()];
}
const regionOf = (s: { x: number; y: number }) => `${Math.floor(s.x / REGION)},${Math.floor(s.y / REGION)}`;

/** Tunnel components at z: tiles joined along line bits; a non-linear tile a line points into
 *  (a station) joins every tunnel pointing into it. */
function components(om: Overmap, type: string, z: number): Map<string, number> {
  const comp = new Map<string, number>();
  let n = 0;
  for (let y = LO; y < HI; y++)
    for (let x = LO; x < HI; x++) {
      if (comp.has(`${x},${y}`) || om.omtAt(x, y, z).type !== type) continue;
      comp.set(`${x},${y}`, ++n);
      const st: [number, number][] = [[x, y]];
      while (st.length) {
        const [cx, cy] = st.pop()!;
        const o = om.omtAt(cx, cy, z);
        for (let d = 0; d < 4; d++) {
          const nx = cx + DX[d], ny = cy + DY[d];
          if (nx < LO || ny < LO || nx >= HI || ny >= HI || comp.has(`${nx},${ny}`)) continue;
          const nb = om.omtAt(nx, ny, z);
          if (o.type === type ? !(o.line & (1 << d)) : !(nb.type === type && nb.line & (1 << ((d + 2) % 4)))) continue;
          comp.set(`${nx},${ny}`, n);
          st.push([nx, ny]);
        }
      }
    }
  return comp;
}

describe('overmap transport (genVersion 2)', () => {
  it('places UNIQUE specials at most once per region, keeping the start-region labs', () => {
    for (const seed of SEEDS) {
      const all = specials(new Overmap(seed, wg.overmap));
      for (const def of [LAB_SPECIAL, MICROLAB_SPECIAL]) {
        const per = new Map<string, number>();
        for (const s of all) if (s.def === def) per.set(regionOf(s), (per.get(regionOf(s)) ?? 0) + 1);
        for (const [r, k] of per) expect(k, `${def} in region ${r}, seed ${seed}`).toBe(1);
        expect(per.get('0,0'), `${def} in the start region, seed ${seed}`).toBe(1);
      }
      expect(all.some((s) => s.def === CLASSIC_LAB_SPECIAL && regionOf(s) === '0,0')).toBe(true);
    }
    // genVersion 1 ignored UNIQUE: a dozen or more per region.
    expect(specials(new Overmap(1, wg.overmap, 1)).filter((s) => s.def === LAB_SPECIAL).length).toBeGreaterThan(50);
  }, 60_000);

  it('builds no road to an underground connection point', () => {
    let v1Stubs = 0;
    for (const [version, seeds] of [[1, [1]], [2, SEEDS]] as const)
      for (const seed of seeds) {
        const om = new Overmap(seed, wg.overmap, version);
        for (const s of specials(om)) {
          // City buildings' tunnel points sit under the street they face, where a street end is normal.
          // Mutable specials (anthills, mines...) name `mutables`; their connections are pushed
          // as requests by mutable_place.ts and checked in mutable_specials.test.ts.
          if (!wg.overmap.specials[s.def]) {
            expect(wg.overmap.mutables?.[s.def], `special ${s.def}`).toBeDefined();
            continue;
          }
          if (wg.overmap.specials[s.def].city) continue;
          for (const c of wg.overmap.specials[s.def].connections) {
            if (!c.connection || c.connection === 'local_road') continue;
            const [dx, dy] = rotateOffset(c.p[0], c.p[1], s.rot);
            const o = om.omtAt(s.x + dx, s.y + dy, 0);
            // a dead-end road on the point is the stub genVersion 1 paved towards the nearest road
            const stub = o.type === 'road' && [1, 2, 4, 8].includes(o.line);
            if (version === 1) v1Stubs += stub ? 1 : 0;
            else expect(stub, `${s.def} ${c.connection} at ${s.x + dx},${s.y + dy}, seed ${seed}`).toBe(false);
          }
        }
      }
    expect(v1Stubs).toBeGreaterThan(10);
  }, 60_000);

  it('joins manholes to their city sewer and stations to the subway', () => {
    for (const seed of SEEDS) {
      const om = new Overmap(seed, wg.overmap);
      const cities = om.citiesNear(0, 0, 1);
      // linear tunnels answer every line bit: the same network, or a station it opens into
      for (const [type, z] of [['sewer', -1], ['subway', -2]] as const)
        for (let y = LO; y < HI; y++)
          for (let x = LO; x < HI; x++) {
            const o = om.omtAt(x, y, z);
            if (o.type !== type) continue;
            expect(parseOterId(o.id, wg.overmap.terrains)).toEqual({ type, rot: 0, line: o.line });
            for (let d = 0; d < 4; d++) {
              if (!(o.line & (1 << d))) continue;
              const n = om.omtAt(x + DX[d], y + DY[d], z);
              const ok = n.type === type ? !!(n.line & (1 << ((d + 2) % 4))) : n.line < 0 && n.type !== 'empty_rock';
              expect(ok, `${o.id} at ${x},${y},${z} opens into ${n.id}, seed ${seed}`).toBe(true);
            }
          }
      const sewers = components(om, 'sewer', -1);
      const hubs = new Set(cities.map((c) => {
        expect(om.omtAt(c.x, c.y, -1).type, `sewer hub under ${c.name}`).toBe('sewer');
        return sewers.get(`${c.x},${c.y}`);
      }));
      let manholes = 0;
      for (let y = LO; y < HI; y++)
        for (let x = LO; x < HI; x++) {
          if (om.omtAt(x, y, 0).type !== 'road_nesw_manhole') continue;
          manholes++;
          expect(hubs.has(sewers.get(`${x},${y}`)), `manhole ${x},${y} reaches a city hub, seed ${seed}`).toBe(true);
        }
      expect(manholes).toBeGreaterThan(cities.length / 2);
      const subways = components(om, 'subway', -2);
      let stations = 0;
      for (let y = LO; y < HI; y++)
        for (let x = LO; x < HI; x++) {
          const t = om.omtAt(x, y, -2).type;
          if (t !== 'underground_sub_station' && t !== 'microlab_sub_station') continue;
          stations++;
          expect(subways.has(`${x},${y}`), `${t} at ${x},${y} has a tunnel, seed ${seed}`).toBe(true);
        }
      expect(stations).toBeGreaterThan(5);
      // a region's stations form a handful of networks, not one per station
      expect(new Set(subways.values()).size).toBeLessThan(stations);
    }
  }, 60_000);

  it('generates a region the same whichever neighbours exist', () => {
    const hash = (om: Overmap) => {
      const parts: string[] = [];
      for (let z = -4; z <= 0; z++)
        for (let y = REGION; y < 2 * REGION; y++)
          for (let x = REGION; x < 2 * REGION; x++) parts.push(om.omtAt(x, y, z).id);
      return hashString(parts.join('|'));
    };
    const alone = new Overmap(42, wg.overmap);
    const crowded = new Overmap(42, wg.overmap);
    for (const [x, y] of [[0, 0], [2, 1], [1, 2], [0, 1], [2, 2]]) crowded.omtAt(x * REGION, y * REGION, 0);
    expect(hash(crowded)).toBe(hash(alone));
  });
});
