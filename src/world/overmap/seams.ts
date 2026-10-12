import { hashSeed } from '../../core/rng';

// Tunnel seams: where underground networks cross region edges (genVersion >= 3).
//
// Regions generate lazily and independently, so a crossing can't be negotiated between
// neighbours: both sides derive it from the seed alone, the way road portals are
// (overmap.ts portal()). Each region reserves its half of every crossing on its edges before
// anything else is placed (nothing can take the tile), then joins it to its own network after its
// connection requests are built (connections.ts, BN p2p layout). The two halves carry the line
// bit that points across the edge, so the track runs straight through whichever side exists.
//
// Only subways cross. BN never links networks across overmaps on purpose (connections_out is only
// fed by paths that happen to reach the border), but its overmaps are 180x180 and ours 96x96, so
// per-region subways came out as many small networks. Sewers don't cross: a BN sewer belongs to
// one city (layout "city": every manhole links to its city's centre), and our cities never
// straddle a region edge (placeCities keeps the centre size + 3 from the edge, layOutStreet keeps
// streets 2 from it), so every city's sewer already lies inside one region; a crossing would only
// join two different towns' sewers, which BN never does.

/** One region's half of a tunnel crossing, region-local. */
export interface TunnelSeam {
  /** om_direction of the edge: 0 north, 1 east, 2 south, 3 west; the half's line bit is 1 << side */
  side: number;
  x: number;
  y: number;
  z: number;
  /** BN overmap_connection id */
  connection: string;
  /** terrain both halves are reserved as */
  terrain: string;
}

interface SeamKind {
  connection: string;
  terrain: string;
  z: number;
  /** chance in 100 that a given region edge has a crossing */
  pct: number;
  /** hash salt, distinct per kind so kinds don't share crossing points */
  salt: number;
}

// About a third of the edges: over 3x3 regions that puts 70-100% of stations on a network with a
// station in another region while leaving 3-6 networks, not one grid (50% left 1-3, 25% reached
// 20-60% of stations; docs/WORLD_TRANSPORT.md, tools/transport_probe.ts).
const KINDS: readonly SeamKind[] = [{ connection: 'subway_tunnel', terrain: 'subway', z: -2, pct: 35, salt: 0x5e4 }];

/** Seams are kept this far from region corners, so a corner tile never carries two crossings. */
const CORNER_CLEARANCE = 8;

/**
 * The crossings on region (rx, ry)'s four edges, in side order then kind order. The edge is keyed
 * by the region that owns it (the one to its west or north), so both neighbours hash the same
 * thing.
 */
export function tunnelSeams(seed: number, rx: number, ry: number, size: number): TunnelSeam[] {
  if (size <= 2 * CORNER_CLEARANCE) throw new Error(`tunnelSeams: region size ${size} too small`);
  const out: TunnelSeam[] = [];
  for (let side = 0; side < 4; side++) {
    // owner region and its side (1 east or 2 south) for this edge
    const [ox, oy, os] = side === 0 ? [rx, ry - 1, 2] : side === 3 ? [rx - 1, ry, 1] : [rx, ry, side];
    for (const k of KINDS) {
      if (hashSeed(seed, ox, oy, os, k.salt, 1) % 100 >= k.pct) continue;
      const off = CORNER_CLEARANCE + (hashSeed(seed, ox, oy, os, k.salt, 2) % (size - 2 * CORNER_CLEARANCE));
      const x = side === 1 ? size - 1 : side === 3 ? 0 : off;
      const y = side === 2 ? size - 1 : side === 0 ? 0 : off;
      out.push({ side, x, y, z: k.z, connection: k.connection, terrain: k.terrain });
    }
  }
  return out;
}
