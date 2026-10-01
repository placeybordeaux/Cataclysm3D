import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import { raycastTiles } from '../game/raycast';
import { terrainShape } from './tileKinds';

// Sky-leak probe (docs/PERF.md "Levels from the world"): where the *map* says a roof, a floor
// or a wall is between the eye and the sky, the *render* must not show the sky. It renders the
// scene once with the sky, the skyline and the weather hidden into a target cleared to a
// sentinel colour, raycasts the tile map through every pixel, and counts pixels whose ray hits
// structure within reach but still show the sentinel: something the world contains was never
// built (the fixed-window bug: the sky through a fire station's roof three levels up).
//
// Only structural hits count (walls, floors, ceilings); windows, fences and shrubs are looked
// through, and furniture/trees/doors (whose drawn shapes don't fill their raycast boxes) make
// the sample "don't know". Silhouette edges disagree by a pixel between the two, so callers
// allow a small share (tools/skyleak.ts: 2 %).
//
// cdda.skyLeak({ width = 192, maxDist = 60 }) -> { samples, structural, leaks, share, where }

export interface SkyLeakResult {
  width: number;
  height: number;
  /** pixels sampled / whose ray hit structure within maxDist / of those, showing the sentinel */
  samples: number;
  structural: number;
  leaks: number;
  share: number;
  /** a few leaking pixels: screen position (0..1) and the tile the ray hit */
  where: { u: number; v: number; kind: string; x: number; y: number; z: number; ter: string }[];
}

const SENTINEL = [255, 0, 255];

export function skyLeakProbe(game: Game, renderer: Renderer, o: { width?: number; maxDist?: number } = {}): SkyLeakResult {
  const cam = renderer.rig.camera;
  const w = Math.max(16, Math.round(o.width ?? 192));
  const h = Math.max(8, Math.round(w / cam.aspect));
  const maxDist = o.maxDist ?? 60;
  const three = renderer.three;
  // two attachments: the world's materials write the normal target too (post.ts)
  const rt = new THREE.WebGLRenderTarget(w, h, { count: 2, depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  const hidden: THREE.Object3D[] = [renderer.sky.mesh, renderer.skyline.group, renderer.weather.group].filter((x) => x.visible);
  for (const x of hidden) x.visible = false;
  const prevTarget = three.getRenderTarget();
  const prevClear = three.getClearColor(new THREE.Color()), prevAlpha = three.getClearAlpha();
  const px = new Uint8Array(w * h * 4);
  try {
    cam.updateMatrixWorld();
    three.setRenderTarget(rt);
    three.setClearColor(new THREE.Color(SENTINEL[0] / 255, SENTINEL[1] / 255, SENTINEL[2] / 255), 1);
    three.clear();
    three.render(renderer.scene, cam);
    three.readRenderTargetPixels(rt, 0, 0, w, h, px);
  } finally {
    three.setRenderTarget(prevTarget);
    three.setClearColor(prevClear, prevAlpha);
    for (const x of hidden) x.visible = true;
    rt.dispose();
  }
  const origin = { x: cam.position.x, y: cam.position.z, h: cam.position.y };
  const v = new THREE.Vector3();
  let structural = 0, leaks = 0;
  const where: SkyLeakResult['where'] = [];
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      // readPixels rows are bottom-up
      const k = (j * w + i) * 4;
      v.set(((i + 0.5) / w) * 2 - 1, ((j + 0.5) / h) * 2 - 1, 0.5).unproject(cam).sub(cam.position).normalize();
      const hit = raycastTiles(game.map, origin, { x: v.x, y: v.z, h: v.y }, { maxDist, skipOrigin: true, throughTransparent: true });
      if (!hit || hit.dist < 0.3) continue;
      const structure = hit.kind === 'floor' || hit.kind === 'ceiling' || (hit.kind === 'terrain' && terrainShape(hit.terrain) === 'wall');
      if (!structure) continue;
      structural++;
      if (px[k] === SENTINEL[0] && px[k + 1] === SENTINEL[1] && px[k + 2] === SENTINEL[2]) {
        leaks++;
        if (where.length < 8 && (leaks % 7 === 1 || where.length < 3))
          where.push({ u: +((i + 0.5) / w).toFixed(3), v: +(1 - (j + 0.5) / h).toFixed(3), kind: hit.kind, x: hit.x, y: hit.y, z: hit.z, ter: hit.terrain.id });
      }
    }
  return { width: w, height: h, samples: w * h, structural, leaks, share: structural ? leaks / structural : 0, where };
}

export function installSkyLeak(game: Game, renderer: Renderer, api: Record<string, unknown>): void {
  api.skyLeak = (o?: { width?: number; maxDist?: number }) => skyLeakProbe(game, renderer, o);
}
