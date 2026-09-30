import * as THREE from 'three';
import type { GameMap } from '../world/map';
import { LEVEL_HEIGHT, chunkOf } from '../world/coords';
import { INDOOR_SKY } from './chunkMesh';
import { pointSeed } from './atlasIndex';
import { GeomBuilder } from './geometry';
import { worldMaterials } from './materials';
import { glassMaterial } from './furniture/glass';
import { terrainShape } from './tileKinds';
import { furnitureHide } from './furnitureHide';
import type { Renderer } from './renderer';
import type { TileFrame } from './textureSource';

// A dragged piece of furniture slides instead of teleporting (src/grab.ts). Furniture is baked
// into chunk meshes, so a moved dresser would pop from one tile to the next when its chunk
// rebuilt. Instead: the game moves it at once (collision and pathing stay honest), the mesher
// leaves it out of its new tile (furnitureHide), and this draws the same modelled piece as a
// stand-in gliding from the old tile to the new one. When the glide ends the tile is unhidden
// and the stand-in stays until the chunk's rebuilt mesh (with the piece in it) is up, so there
// is never a frame without it. Looks without modelled furniture (classic, voxel style) keep
// the instant move.

interface Slide {
  group: THREE.Group;
  to: [number, number, number];
  off: [number, number];
  t: number;
  dur: number;
  landed: boolean;
}

const WALLISH = new Set(['wall', 'halfwall', 'window', 'door', 'door_open']);
const DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];

export interface GrabView {
  /** Glide furniture `id` (already moved in the map) from `from` into `to` over `dur` seconds. */
  slide(id: string, from: [number, number, number], to: [number, number, number], dur: number): boolean;
  /** Stand-ins currently drawn (tests / cdda.grab). */
  active(): number;
}

export function installGrabView(renderer: Renderer, map: GameMap): GrabView {
  const slides: Slide[] = [];

  const build = (id: string, x: number, y: number, z: number): THREE.Group | null => {
    const ex = renderer.chunks.extras?.(true);
    const MD = ex?.f.voxelProps ? ex.models : undefined;
    if (!MD) return null;
    const pages = new Map<THREE.Texture, GeomBuilder>();
    let glass: GeomBuilder | undefined;
    // the same ambient share the mesher gives a piece under a roof, or it pops brighter
    const sky = renderer.chunks.covered(x, y, z) ? INDOOR_SKY : 1;
    const geo = (f: TileFrame) => {
      let g = pages.get(f.texture);
      if (!g) pages.set(f.texture, (g = new GeomBuilder()));
      g.skyVis = sky;
      return g;
    };
    const wallAt = (dx: number, dy: number) => WALLISH.has(terrainShape(map.terAt(x + dx, y + dy, z)));
    const ok = MD.furniture(geo, () => (glass ??= new GeomBuilder()), renderer.chunks.source, id, x, y, z * LEVEL_HEIGHT, pointSeed(x, y) >>> 0, {
      wall: DX.map((dx, d) => wallAt(dx, DY[d])),
      furn: (dx, dy) => (dx || dy ? map.furnAt(x + dx, y + dy, z).id : id),
      wallAt,
    });
    if (!ok) return null;
    const g = new THREE.Group();
    g.name = `grab stand-in ${id}`;
    for (const [page, gb] of pages) {
      if (gb.vertexCount === 0) continue;
      const { mat, depth } = worldMaterials(page);
      const mesh = new THREE.Mesh(gb.build(), mat);
      mesh.customDepthMaterial = depth;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }
    if (glass && glass.vertexCount) g.add(new THREE.Mesh(glass.build(), glassMaterial()));
    return g;
  };

  const drop = (s: Slide) => {
    renderer.scene.remove(s.group);
    for (const c of s.group.children) (c as THREE.Mesh).geometry.dispose();
    slides.splice(slides.indexOf(s), 1);
  };

  renderer.beforeRender.push((dt) => {
    for (const s of [...slides]) {
      if (!s.landed) {
        s.t = Math.min(s.dur, s.t + dt);
        const k = 1 - s.t / s.dur;
        s.group.position.set(s.off[0] * k, 0, s.off[1] * k);
        if (s.t >= s.dur) {
          s.landed = true;
          const [x, y, z] = s.to;
          furnitureHide.delete(x, y, z);
          renderer.chunks.invalidateChunk(chunkOf(x), chunkOf(y), z);
        }
      } else if (renderer.chunks.upToDate(chunkOf(s.to[0]), chunkOf(s.to[1]), s.to[2])) drop(s);
    }
  });

  return {
    slide(id, from, to, dur) {
      // a piece still gliding into `from` (holding W): take over from where it is drawn now
      const prev = slides.find((s) => s.to[0] === from[0] && s.to[1] === from[1] && s.to[2] === from[2]);
      let ox = from[0] - to[0], oy = from[1] - to[1];
      if (prev) {
        if (!prev.landed) {
          const k = 1 - prev.t / prev.dur;
          ox += prev.off[0] * k;
          oy += prev.off[1] * k;
          furnitureHide.delete(...prev.to);
        }
        drop(prev);
      }
      const g = build(id, to[0], to[1], to[2]);
      if (!g) return false;
      furnitureHide.add(...to);
      // the map change already queued a rebuild of both chunks; hiding must apply to it
      renderer.chunks.invalidateChunk(chunkOf(to[0]), chunkOf(to[1]), to[2]);
      if (chunkOf(from[0]) !== chunkOf(to[0]) || chunkOf(from[1]) !== chunkOf(to[1])) renderer.chunks.invalidateChunk(chunkOf(from[0]), chunkOf(from[1]), from[2]);
      g.position.set(ox, 0, oy);
      renderer.scene.add(g);
      slides.push({ group: g, to, off: [ox, oy], t: 0, dur: Math.max(0.05, dur), landed: false });
      return true;
    },
    active: () => slides.length,
  };
}

