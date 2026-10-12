// Overmap transport probe: per-seed counts of labs, stations, manholes and the sewer/subway
// networks over a block of regions, for genVersion 1 and the latest. Read-only.
import { Overmap, REGION, WORLDGEN_VERSION } from '../src/world/overmap/overmap';
import { loadNodeData } from './lib/node_data';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`transport_probe [--seeds 1,2,3] [--radius 1] [--version N]
  Counts overmap transport features per seed over (2r+1)^2 regions around region 0,0.`);
  process.exit(0);
}
const arg = (n: string, d: string) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const seeds = arg('--seeds', '1,2,3,42,743667900').split(',').map(Number);
const rad = Number(arg('--radius', '1'));
const versions = argv.includes('--version') ? [Number(arg('--version', '2'))] : [1, WORLDGEN_VERSION];
const { wg } = loadNodeData();
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

for (const v of versions)
  for (const seed of seeds) {
    const t0 = performance.now();
    const om = new Overmap(seed, wg.overmap, v);
    const c: Record<string, number> = {};
    const uids = new Map<number, string>();
    const inc = (k: string) => (c[k] = (c[k] ?? 0) + 1);
    const lo = -rad * REGION, hi = (rad + 1) * REGION;
    for (let z = -4; z <= 0; z++)
      for (let y = lo; y < hi; y++)
        for (let x = lo; x < hi; x++) {
          const o = om.omtAt(x, y, z);
          if (z === 0 && o.type === 'road_nesw_manhole') inc('manhole');
          if (z === 0 && o.type === 'sub_station') inc('sub_station');
          if (o.type === 'sewer') inc(`sewer z${z}`);
          if (o.type === 'subway') inc(`subway z${z}`);
          if (o.special) uids.set(o.special.uid, o.special.def);
          if (o.type === 'sewer' || o.type === 'subway') {
            // every line bit must be answered: by the same network, or by a non-linear tile (a station)
            for (let d = 0; d < 4; d++) {
              if (!(o.line & (1 << d))) continue;
              const n = om.omtAt(x + DX[d], y + DY[d], z);
              if (n.type === o.type ? !(n.line & (1 << ((d + 2) % 4))) : n.line >= 0 || n.type === 'empty_rock') inc(`bad line ${o.type}`);
            }
          }
        }
    for (const def of uids.values()) {
      if (def === '4x4_microlab_surface') inc('microlab');
      if (def === 'lab_mutagen_6_level') inc('mutagen lab');
      if (def === 'Lab') inc('classic lab');
    }
    // Network components: tiles joined along line bits; a non-linear tile a line points into (a
    // station, a building's sewer room) joins every tunnel pointing into it.
    for (const [type, z] of [['sewer', -1], ['subway', -2]] as const) {
      const comp = new Map<string, number>();
      const adj = (x: number, y: number): [number, number][] => {
        const o = om.omtAt(x, y, z), out: [number, number][] = [];
        for (let d = 0; d < 4; d++) {
          const nx = x + DX[d], ny = y + DY[d], n = om.omtAt(nx, ny, z);
          if (o.type === type ? o.line & (1 << d) : n.type === type && n.line & (1 << ((d + 2) % 4))) out.push([nx, ny]);
        }
        return out;
      };
      let comps = 0;
      for (let y = lo; y < hi; y++)
        for (let x = lo; x < hi; x++) {
          if (comp.has(`${x},${y}`) || om.omtAt(x, y, z).type !== type) continue;
          comps++;
          const st: [number, number][] = [[x, y]];
          comp.set(`${x},${y}`, comps);
          while (st.length) {
            const [cx, cy] = st.pop()!;
            for (const [nx, ny] of adj(cx, cy)) {
              const k = `${nx},${ny}`;
              if (comp.has(k) || nx < lo || ny < lo || nx >= hi || ny >= hi) continue;
              comp.set(k, comps);
              st.push([nx, ny]);
            }
          }
        }
      c[`${type} networks`] = comps;
      if (type === 'sewer') {
        // every manhole's sewer must reach a city centre's hub
        const hubs = new Set(om.citiesNear(0, 0, rad).map((t) => comp.get(`${t.x},${t.y}`)));
        for (let y = lo; y < hi; y++)
          for (let x = lo; x < hi; x++) {
            if (om.omtAt(x, y, 0).type !== 'road_nesw_manhole') continue;
            inc(hubs.has(comp.get(`${x},${y}`)) ? 'manhole joined' : 'manhole cut off');
          }
      } else {
        // regions holding a station, per network: a station "reaches another region" when its
        // network also holds a station in a different region (cross-region tunnels, genVersion 3)
        const stationRegions = new Map<number, Set<string>>();
        const stations: { comp: number | undefined; region: string }[] = [];
        for (let y = lo; y < hi; y++)
          for (let x = lo; x < hi; x++) {
            const t = om.omtAt(x, y, z).type;
            if (!/sub_station/.test(t)) continue;
            inc(comp.has(`${x},${y}`) ? `${t} joined` : `${t} cut off`);
            const region = `${Math.floor(x / REGION)},${Math.floor(y / REGION)}`, k = comp.get(`${x},${y}`);
            stations.push({ comp: k, region });
            if (k !== undefined) (stationRegions.get(k) ?? stationRegions.set(k, new Set()).get(k)!).add(region);
          }
        c['subway networks with a station'] = stationRegions.size;
        c['stations reaching another region'] = stations.filter((s) => s.comp !== undefined && [...stationRegions.get(s.comp)!].some((r) => r !== s.region)).length;
        c['stations'] = stations.length;
      }
    }
    console.log(`v${v} seed ${seed}: ${JSON.stringify(c)} (${(performance.now() - t0).toFixed(0)} ms)`);
  }
