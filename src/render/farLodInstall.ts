import { Box3, Matrix4, Vector3, type BufferAttribute, type InstancedMesh, type Mesh, type Object3D } from 'three';
import type * as THREE from 'three';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { GameMap } from '../world/map';
import { WorldGenerator } from '../world/worldgen';
import { registerOption } from '../ui/options';
import { clearFade, setFade } from './dissolve';
import { DISSOLVE_S, dissolves, FAR_LOD_MODES, farLod, Handoff, setFarLodMode, usesProxies, type FarLodMode } from './farLod';
import { FarProxyLayer, overmapTopOf } from './farProxy';
import type { PlaceholderLayer } from './placeholders';
import type { Renderer } from './renderer';
import { look } from './look';
import { emitSilhouette, silhouetteStoreys, SKYLINE_NEAR, SKYLINE_OUTER, SKYLINE_PULL } from './skyline';

// Wires the far LOD (farLod.ts, farProxy.ts, docs/FAR_LOD.md) into the renderer: the proxy
// ring, the hand-off after each chunk update, fade-ins of covers appearing at the far edge, the
// camera's far plane (the proxies reach past the chunks' 200 m), the option and the debug API.
//
//   cdda.setFarLod('dissolve')   switch live (not persisted)
//   cdda.farLod()                mode and stats

const CAMERA_FAR = 200;

export function installFarLod(game: Game, renderer: Renderer, worldgen: WorldGenerator, placeholders: PlaceholderLayer, api: DebugApi): { proxies: FarProxyLayer; handoff: Handoff } {
  // a hook-free copy of the world for columns nobody has generated (farProxy.ts)
  const scratch = new GameMap(game.map.seed);
  for (const t of game.map.terrain.defs) scratch.terrain.add(t);
  for (const f of game.map.furniture.defs) scratch.furniture.add(f);
  scratch.generator = new WorldGenerator(worldgen.seed, worldgen.wg, worldgen.game, worldgen.genVersion, worldgen.overmap);
  const chunks = renderer.chunks;
  const proxies = new FarProxyLayer({
    live: game.map,
    scratch,
    overmapTop: (cx, cy) => overmapTopOf((x, y, z) => worldgen.overmap.omtAt(x, y, z), cx, cy),
    white: () => renderer.whiteFrame(),
    art: (id, part) => chunks.source.averageColor?.(id, part) ?? null,
    pitch: () => look.f.archDetail,
  });
  renderer.scene.add(proxies.group);
  proxies.yieldTo = () => chunks.behind;
  proxies.speed = () => Math.hypot(chunks.vel.x, chunks.vel.y);
  proxies.startIdle();
  const handoff = new Handoff(chunks, placeholders, proxies, (cx, cy) => {
    const t = chunks.levels.columnTop(cx, cy);
    return Number.isNaN(t) ? 1 : t;
  });

  // Covers appearing at the far edge (a proxy at the ring's rim, a stand-in when a column
  // becomes wanted) fade in instead of popping up.
  const appearing = new Map<THREE.Object3D, { t0: number; proxy: [number, number] | null }>();
  const appear = (o: THREE.Object3D, proxy: [number, number] | null, now: number) => {
    appearing.set(o, { t0: now, proxy });
    setFade(o, 0);
  };

  let lastMode: FarLodMode | null = null;
  renderer.beforeRender.push(() => {
    const mode = farLod.mode;
    const p = game.player;
    const now = performance.now();
    const R = chunks.radius;
    if (mode !== lastMode) {
      // (switching live: a clean slate, the next frames rebuild what the mode needs)
      for (const o of appearing.keys()) clearFade(o);
      appearing.clear();
      handoff.reset();
      if (!usesProxies(mode)) proxies.clear();
      lastMode = mode;
    }
    proxies.enabled = usesProxies(mode);
    placeholders.doneFn = mode === 'current' ? null : (cx, cy) => handoff.done(cx, cy);
    // proxy modes: no overmap stand-ins at all (the hand-off builds a missing proxy instead)
    placeholders.covered = usesProxies(mode) ? () => true : null;
    proxies.update(p.x, p.y, p.z, R, chunks.forward);
    const cam = renderer.camera;
    // With proxies the skyline's pull starts past them (else the pulled far ground ring lands
    // in front of distant proxies and paints over their bottoms), and the far plane takes in
    // the proxies and everything the skyline pulls in behind them.
    const proxyOn = proxies.enabled && p.z >= 0;
    const near = proxyOn ? (proxies.outer(R) + 1.5) * CHUNK : SKYLINE_NEAR;
    renderer.skyline.uniforms.uNear.value = near;
    renderer.skyline.innerChunks = proxyOn ? proxies.outer(R) + 0.5 : null;
    const pulledFar = near + Math.max(0, (R + SKYLINE_OUTER + 1) * CHUNK - near) * SKYLINE_PULL;
    const far = proxyOn ? Math.max(CAMERA_FAR, pulledFar + 10) : CAMERA_FAR;
    if (cam.far !== far) {
      cam.far = far;
      cam.updateProjectionMatrix();
    }
    if (dissolves(mode)) {
      const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
      for (const [cx, cy] of proxies.fresh) {
        // inside the draw radius the hand-off owns a proxy (it is the cover there)
        if ((cx - pcx) ** 2 + (cy - pcy) ** 2 <= (R + 2) ** 2) continue;
        const m = proxies.solo(cx, cy);
        if (m) appear(m, [cx, cy], now);
      }
      for (const m of placeholders.fresh) appear(m, null, now);
    }
    proxies.fresh.length = 0;
    for (const [o, a] of appearing) {
      const f = (now - a.t0) / (DISSOLVE_S * 1000);
      if (f < 1 && o.parent) {
        setFade(o, f);
        continue;
      }
      clearFade(o);
      appearing.delete(o);
      if (a.proxy && !handoff.covering(a.proxy[0], a.proxy[1])) proxies.unsolo(a.proxy[0], a.proxy[1]);
    }
  });
  chunks.afterUpdate.push(() => handoff.update(game.player.x, game.player.y, game.player.z));
  game.events.on('gameLoaded', () => {
    handoff.reset();
    proxies.clear();
  });

  registerOption({
    category: 'World',
    name: 'Far detail',
    value: () => farLod.mode,
    change: (d) => setFarLodMode(FAR_LOD_MODES[(FAR_LOD_MODES.indexOf(farLod.mode) + d + FAR_LOD_MODES.length) % FAR_LOD_MODES.length], true),
    desc: 'How buildings at the edge of the draw distance come in.  proxy-dissolve: low-poly copies of the real buildings out to 1.75x the draw distance, the detail dissolves in over them.  proxy: the same, swapped in one frame.  dissolve: no far copies; the stand-in boxes fade in and the buildings dissolve in over them.  current: the old pop-in.',
  });
  const a = api as DebugApi & Record<string, unknown>;
  /** Far LOD mode (farLod.ts): live, not persisted. */
  a.setFarLod = (m: string) => setFarLodMode(m as FarLodMode, false);
  /**
   * Columns inside the proxy ring that show nothing: neither handed over to their chunks nor
   * drawn as a proxy (a hole where a building should be). `inner`: those inside the draw radius
   * + 2, where the ring is long built and a hole is a bug, not the rim still filling in.
   */
  const uncovered = () => {
    const p = game.player, R = chunks.radius, outer = proxies.outer(R);
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    let all = 0, inner = 0;
    for (let dy = -Math.ceil(outer); dy <= Math.ceil(outer); dy++)
      for (let dx = -Math.ceil(outer); dx <= Math.ceil(outer); dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > outer * outer) continue;
        const cx = pcx + dx, cy = pcy + dy;
        if (proxies.drawn(cx, cy) || handoff.done(cx, cy) || handoff.covering(cx, cy)) continue;
        all++;
        if (d2 <= (R + 2) ** 2) inner++;
      }
    return { all, inner };
  };
  a.farLod = () => ({ mode: farLod.mode, proxies: { ...proxies.stats }, handoff: { ...handoff.stats }, appearing: appearing.size, cameraFar: renderer.camera.far, uncovered: usesProxies(farLod.mode) ? uncovered() : null });
  /** Drop the chunks beyond `dist` m: they stream back in and hand over in view (captures). */
  a.restreamEdge = (dist = 130) => chunks.dropBeyond(game.player.x, game.player.y, dist);
  /** Debug: draw only proxies (chunks and stand-ins hidden), to compare their shapes with the real view. */
  a.proxyView = (on: boolean) => {
    proxies.showAll = on;
    chunks.group.visible = !on;
    placeholders.group.visible = !on;
    proxies.remergeAll();
  };
  /**
   * Debug: per built column within `r` chunks, the proxy's top against the real chunks' top
   * (bounding boxes of the world meshes); the worst `n` mismatches.
   */
  a.proxyCheck = (r = 6, n = 12) => {
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const out: { cx: number; cy: number; proxy: number; real: number; diff: number }[] = [];
    const box = new Box3(), tmp = new Box3();
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy;
        const pt = proxies.proxyTop(cx, cy);
        if (Number.isNaN(pt)) continue;
        box.makeEmpty();
        for (let z = 0; z <= 10; z++) {
          const e = chunks.entryAt(cx, cy, z);
          e?.group?.traverse((o) => {
            const m = o as Mesh;
            if (!m.isMesh || !(m.material as { userData?: { worldPage?: boolean } }).userData?.worldPage) return;
            m.geometry.computeBoundingBox();
            tmp.copy(m.geometry.boundingBox!).applyMatrix4(m.matrixWorld);
            box.union(tmp);
          });
        }
        if (box.isEmpty()) continue;
        out.push({ cx, cy, proxy: +pt.toFixed(2), real: +box.max.y.toFixed(2), diff: +(pt - box.max.y).toFixed(2) });
      }
    out.sort((a2, b) => Math.abs(b.diff) - Math.abs(a2.diff));
    return { checked: out.length, worst: out.slice(0, n), meanAbs: +(out.reduce((s2, o) => s2 + Math.abs(o.diff), 0) / Math.max(1, out.length)).toFixed(2) };
  };
  /**
   * Debug: how much of column (cx, cy) is drawn, by anyone: the top of the highest level its
   * chunks show from the ground up, or what the proxy layer draws (proxy, solo cover, cap).
   */
  a.columnDrawnTop = (cx: number, cy: number) => {
    let z = -1;
    for (let k = 0; k <= 12; k++) {
      const e = chunks.entryAt(cx, cy, k);
      if (!e || !e.shown || !e.visible) break;
      z = k;
    }
    const chunkTop = z < 0 ? -Infinity : (z + 1) * LEVEL_HEIGHT;
    return { chunks: chunkTop, proxy: proxies.drawnTop(cx, cy), full: proxies.proxyTop(cx, cy) };
  };
  /**
   * Debug QA (docs/FAR_LOD.md): proxy vs real geometry per tile, for every column within `r`
   * chunks whose wanted levels are all shown and that has a proxy. Real height = the highest
   * vertex of anything its chunk groups draw over the tile (world meshes, 3D trees, furniture
   * models; instanced meshes by their instances' bounds). Compared only where either stands
   * over 0.6 m (ground vs ground is noise). Returns totals and the worst tiles with the
   * terrain stacked there, top first.
   */
  /** The stand-in (overmap silhouette) of column (cx, cy) as a per-tile top height (proxyQa 'standin'). */
  const standinHeightmap = (cx: number, cy: number): Float32Array => {
    const H = new Float32Array(CHUNK * CHUNK).fill(-Infinity);
    const bx = cx * CHUNK, by = cy * CHUNK;
    const sample = (A: number[], B: number[], C: number[]) => {
      const edge = Math.max(Math.hypot(B[0] - A[0], B[2] - A[2]), Math.hypot(C[0] - A[0], C[2] - A[2]), Math.hypot(C[0] - B[0], C[2] - B[2]), 0.01);
      const ns = Math.min(60, Math.max(1, Math.ceil(edge / 0.4)));
      for (let i = 0; i <= ns; i++)
        for (let j = 0; j <= ns - i; j++) {
          const u = i / ns, w = j / ns;
          const x = A[0] + u * (B[0] - A[0]) + w * (C[0] - A[0]), y = A[1] + u * (B[1] - A[1]) + w * (C[1] - A[1]), z = A[2] + u * (B[2] - A[2]) + w * (C[2] - A[2]);
          const tx = Math.floor(x - bx), tz = Math.floor(z - by);
          if (tx < 0 || tz < 0 || tx >= CHUNK || tz >= CHUNK) continue;
          const k = tz * CHUNK + tx;
          if (y > H[k]) H[k] = y;
        }
    };
    const om = { omtAt: (x: number, y: number, z: number) => worldgen.overmap.omtAt(x, y, z) };
    emitSilhouette(cx, cy, om.omtAt(cx, cy, 0).id, (a2, b, c2, d) => { sample(a2, b, c2); sample(a2, c2, d); }, (a2, b, c2) => sample(a2, b, c2), silhouetteStoreys(om, cx, cy));
    return H;
  };
  a.proxyQa = (r = 5, worstN = 25, scratchOnly: boolean | 'standin' = false) => {
    const p = game.player;
    const pcx = Math.floor(p.x / CHUNK), pcy = Math.floor(p.y / CHUNK);
    const m4 = new Matrix4(), v3 = new Vector3(), bb = new Box3();
    const va = new Vector3(), vb = new Vector3(), vc = new Vector3(), nn = new Vector3();
    const tiles: { cx: number; cy: number; tx: number; ty: number; proxy: number; real: number; diff: number }[] = [];
    let columns = 0, skipped = 0;
    let treeTiles = 0, treeBoth = 0, treeProxyOnly = 0, treeRealOnly = 0, treeDiff = 0;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const cx = pcx + dx, cy = pcy + dy;
        const standin = scratchOnly === 'standin';
        const PH = standin ? (proxies.has(cx, cy) ? standinHeightmap(cx, cy) : null) : proxies.heightmap(cx, cy, 'build', scratchOnly === true);
        const PT = standin ? new Float32Array(CHUNK * CHUNK).fill(-Infinity) : proxies.heightmap(cx, cy, 'crown', scratchOnly === true);
        // every level with content drawn (columnComplete follows what the manager wants, which
        // skips tower tops while it thinks you drive: right after a teleport, say)
        let all = !!PH;
        for (let z = 0; z <= 12 && all; z++) {
          if (!game.map.hasChunk(cx, cy, z) || game.map.chunk(cx, cy, z)!.empty) continue;
          const e = chunks.entryAt(cx, cy, z);
          if (!e || !e.shown || !e.visible) all = false;
        }
        if (!PH || !all) { skipped++; continue; }
        columns++;
        const RH = new Float32Array(CHUNK * CHUNK).fill(-Infinity), RT = new Float32Array(CHUNK * CHUNK).fill(-Infinity);
        const bx = cx * CHUNK, by = cy * CHUNK;
        let into = RH;
        const put = (x: number, y: number, z: number) => {
          const tx = Math.floor(x - bx), tz = Math.floor(z - by);
          if (tx < 0 || tz < 0 || tx >= CHUNK || tz >= CHUNK) return;
          const i = tz * CHUNK + tx;
          if (y > into[i]) into[i] = y;
        };
        for (let z = 0; z <= 12; z++) {
          const e = chunks.entryAt(cx, cy, z);
          e?.group?.updateMatrixWorld(true);
          e?.group?.traverse((o) => {
            const m = o as InstancedMesh;
            // (far page meshes merged by the chunk batcher are hidden but still what is drawn)
            if (!m.isMesh || (!m.visible && !m.userData.batchable)) return;
            const pos = m.geometry.attributes.position as BufferAttribute | undefined;
            if (!pos) return;
            // trees (chunkManager tags them) are compared with the proxy's crowns, the rest with its buildings
            let tr = false;
            for (let q: Object3D | null = m; q && !tr; q = q.parent) tr = !!q.userData.tree;
            into = tr ? RT : RH;
            if (m.isInstancedMesh) {
              m.geometry.computeBoundingBox();
              for (let k = 0; k < m.count; k++) {
                m.getMatrixAt(k, m4);
                m4.premultiply(m.matrixWorld);
                bb.copy(m.geometry.boundingBox!).applyMatrix4(m4);
                v3.setFromMatrixPosition(m4);
                put(v3.x, bb.max.y, v3.z);
              }
              return;
            }
            // per triangle: its highest corner, on the tile under its centre nudged into the
            // solid behind it (a wall face lies on the tile edge: by its vertices it counted
            // for the tile next door)
            const idx = m.geometry.index;
            const nt = idx ? idx.count / 3 : pos.count / 3;
            for (let t = 0; t < nt; t++) {
              const ia = idx ? idx.getX(t * 3) : t * 3, ib = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, ic = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
              va.fromBufferAttribute(pos, ia).applyMatrix4(m.matrixWorld);
              vb.fromBufferAttribute(pos, ib).applyMatrix4(m.matrixWorld);
              vc.fromBufferAttribute(pos, ic).applyMatrix4(m.matrixWorld);
              nn.subVectors(vb, va).cross(v3.subVectors(vc, va));
              const len = nn.length();
              if (len < 1e-9) continue;
              nn.multiplyScalar(1 / len);
              // sampled across the triangle at ~0.4 m (a far tree is two big crossed cards: one
              // sample at its centre put the tree on the tile next to its own)
              const edge = Math.max(va.distanceTo(vb), vb.distanceTo(vc), vc.distanceTo(va));
              const ns = Math.min(40, Math.max(1, Math.ceil(edge / 0.4)));
              for (let i = 0; i <= ns; i++)
                for (let j = 0; j <= ns - i; j++) {
                  const u = i / ns, w = j / ns;
                  const x = va.x + u * (vb.x - va.x) + w * (vc.x - va.x);
                  const y = va.y + u * (vb.y - va.y) + w * (vc.y - va.y);
                  const zz = va.z + u * (vb.z - va.z) + w * (vc.z - va.z);
                  put(x - nn.x * 0.02, y, zz - nn.z * 0.02);
                }
            }
          });
        }
        for (let i = 0; i < CHUNK * CHUNK; i++) {
          const ph = PH![i], rh = standin ? Math.max(RH[i], RT[i]) : RH[i];
          if (ph > 0.6 || rh > 0.6) {
            const pv = Number.isFinite(ph) ? ph : 0, rv = Number.isFinite(rh) ? rh : 0;
            tiles.push({ cx, cy, tx: i % CHUNK, ty: Math.floor(i / CHUNK), proxy: +pv.toFixed(2), real: +rv.toFixed(2), diff: +(pv - rv).toFixed(2) });
          }
          // trees: cover (a crown over the tile, both sides) and height where both have one.
          // Far trees are crossed cards whose corners are transparent: their measured top is
          // an upper bound out to the card's width, so cover is the fairer test.
          const pt = PT![i] > 2, rt = RT[i] > 2;
          if (pt || rt) {
            treeTiles++;
            if (pt && rt) { treeBoth++; treeDiff += PT![i] - RT[i]; }
            else if (pt) treeProxyOnly++;
            else treeRealOnly++;
          }
        }
      }
    const n = tiles.length;
    const over = (t: number) => tiles.filter((x) => x.diff > t).length;
    const under = (t: number) => tiles.filter((x) => x.diff < -t).length;
    const worst = [...tiles].sort((a2, b) => Math.abs(b.diff) - Math.abs(a2.diff)).slice(0, worstN).map((t) => {
      const stack: string[] = [];
      for (let z = 12; z >= 0; z--) {
        if (!game.map.hasChunk(t.cx, t.cy, z)) continue;
        const ter = game.map.terAt(t.cx * CHUNK + t.tx, t.cy * CHUNK + t.ty, z), furn = game.map.furnAt(t.cx * CHUNK + t.tx, t.cy * CHUNK + t.ty, z);
        if (ter.id === 't_open_air' && furn.id === 'f_null') continue;
        stack.push(`z${z}:${ter.id}${furn.id !== 'f_null' ? '+' + furn.id : ''}`);
      }
      return { ...t, omt: worldgen.overmap.omtAt(t.cx, t.cy, 0).id, stack: stack.slice(0, 4).join(' ') };
    });
    return {
      columns, skipped, tiles: n,
      meanAbs: n ? +(tiles.reduce((s2, t) => s2 + Math.abs(t.diff), 0) / n).toFixed(2) : 0,
      over1: n ? +(over(1) / n).toFixed(3) : 0, over3: n ? +(over(3) / n).toFixed(3) : 0,
      under1: n ? +(under(1) / n).toFixed(3) : 0, under3: n ? +(under(3) / n).toFixed(3) : 0,
      worst,
      trees: { tiles: treeTiles, both: treeBoth, proxyOnly: treeProxyOnly, realOnly: treeRealOnly, meanDiffBoth: treeBoth ? +(treeDiff / treeBoth).toFixed(2) : 0 },
    };
  };
  /** Debug: a column's proxy source and the live chunks' wall/tree counts per level. */
  a.proxyColumn = (cx: number, cy: number) => {
    const lv: Record<number, { walls: number; trees: number; empty: boolean }> = {};
    for (let z = 0; z <= 10; z++) {
      if (!game.map.hasChunk(cx, cy, z)) continue;
      const c = game.map.chunk(cx, cy, z)!;
      let walls = 0, trees = 0;
      for (let i = 0; i < c.ter.length; i++) {
        const t = game.map.terrain.get(c.ter[i]);
        if (t.flags?.includes('WALL')) walls++;
        if (t.flags?.includes('TREE')) trees++;
      }
      lv[z] = { walls, trees, empty: !!c.empty };
    }
    return { proxy: proxies.describe(cx, cy), omt: worldgen.overmap.omtAt(cx, cy, 0).id, live: lv };
  };
  /** Pause chunk building (true) or resume it: captures separate dropping from arriving. */
  a.holdBuilds = (on: boolean) => void (chunks.holdBuilds = on);
  return { proxies, handoff };
}
