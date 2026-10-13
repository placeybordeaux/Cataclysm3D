import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_BASE } from '../../core/assets';
import { SPRITE_CORE_PARTS, SPRITE_MODELS, SPRITE_MODEL_GEAR, type SpriteModelId } from './zombie';

// The Blender-built zombie meshes for `zstyle=sprite3d` (docs/SPRITE3D.md). tools/blender/
// zombies.py writes one GLB per model (+ a `_hi` close-range variant) into
// public/models/zombies/ with one mesh node per rig part, modelled in that part's unit box
// (-0.5..0.5). charLayer.ts draws each as an instanced shape with the part's box matrix, so the
// rig, poses, rag dolls and aim picking are the same as for the painted boxes.
//
// Colours are not baked. Each glTF material is named for what the face is:
//   pal:<region>:<shade>   a colour read off the creature's own sprite at runtime (the region's
//                          palette texel on the skin page) times shade: one walker model wears
//                          every zombie sprite's clothes
//   fix:rrggbb             a fixed colour (blood, teeth, a cop's helmet): baseColorFactor
//   glow:rrggbb:k          a fixed colour that emits share k (eyes, acid sacs)
// They become one vec4 vertex attribute, cCol: rgb = colour (fixed/glow) or shade (palette),
// w = 0 fixed, 1 + region index (palette), -1 - k (glow).
//
// Nothing here falls back silently: a missing GLB, part or unknown material throws, and asking
// for a mesh before loadSpriteModels() resolved throws too.

/** Palette regions in skin-page texel order (charLayer writes them; zombieSkin sprite3dPalette). */
export const PALETTE_REGIONS = ['skin', 'hair', 'shirt', 'inner', 'upperArm', 'foreArm', 'pants', 'shoes'] as const;
export type PaletteRegion = (typeof PALETTE_REGIONS)[number];

export interface SpriteModelManifest {
  models: Record<string, { lo: string; hi: string; parts: string[]; tris?: { lo: number; hi: number } }>;
}

export interface MeshShape {
  key: string;
  lo: THREE.BufferGeometry;
  hi: THREE.BufferGeometry;
}

let loaded: Map<string, MeshShape> | null = null;
/** Bumped whenever the loaded set changes (tests reset it); charLayer drops cached slots. */
let generation = 0;
export function spriteModelGeneration(): number {
  return generation;
}
let loading: Promise<void> | null = null;
let stats: Record<string, { lo: number; hi: number }> = {};

export function spriteModelsLoaded(): boolean {
  return loaded !== null;
}

/** Triangles per model (lo / hi), once loaded. */
export function spriteModelStats(): Record<string, { lo: number; hi: number }> {
  return stats;
}

/** The mesh for a rig part's `mesh` key (`<model>/<part>`). Throws when not loaded / unknown. */
export function meshShape(key: string): MeshShape {
  if (!loaded) throw new Error(`sprite3d: mesh ${key} asked for before loadSpriteModels() finished`);
  const m = loaded.get(key);
  if (!m) throw new Error(`sprite3d: no mesh ${key} in public/models/zombies (re-run tools/blender/zombies.py)`);
  return m;
}

/** Parse one material name into the cCol attribute value. */
export function materialCode(name: string, color: THREE.Color): [number, number, number, number] {
  const [kind, a, b] = name.split(':');
  if (kind === 'fix') return [color.r, color.g, color.b, 0];
  if (kind === 'glow') {
    const k = Number(b);
    if (!(k >= 0 && k <= 1)) throw new Error(`sprite3d: bad glow material ${name}`);
    return [color.r, color.g, color.b, -1 - k];
  }
  if (kind === 'pal') {
    const r = PALETTE_REGIONS.indexOf(a as PaletteRegion);
    const shade = Number(b);
    if (r < 0 || !(shade > 0 && shade < 4)) throw new Error(`sprite3d: bad palette material ${name}`);
    return [shade, shade, shade, 1 + r];
  }
  throw new Error(`sprite3d: unknown material ${name} (expected pal:/fix:/glow:)`);
}

/**
 * One part's node (a Mesh, or a Group of primitives, one per material) -> a single
 * non-indexed, flat-shaded geometry with position, normal, uv (zeros) and cCol.
 */
export function partGeometry(node: THREE.Object3D): THREE.BufferGeometry {
  const P: number[] = [], N: number[] = [], C: number[] = [];
  node.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
  const v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  let meshes = 0;
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;
    const mat = mesh.material as THREE.MeshStandardMaterial;
    if (Array.isArray(mat)) throw new Error(`sprite3d: ${node.name}: multi-material primitive`);
    const code = materialCode(mat.name, mat.color);
    // node-local: the part's own transform is identity in the exporter, but don't count on it
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = g.getAttribute('position');
    for (let i = 0; i + 2 < pos.count; i += 3) {
      for (let k = 0; k < 3; k++) v[k].fromBufferAttribute(pos, i + k).applyMatrix4(m);
      n.crossVectors(e1.subVectors(v[1], v[0]), e2.subVectors(v[2], v[0])).normalize();
      for (let k = 0; k < 3; k++) {
        P.push(v[k].x, v[k].y, v[k].z);
        N.push(n.x, n.y, n.z);
        C.push(...code);
      }
    }
  });
  if (!meshes) throw new Error(`sprite3d: part node ${node.name} has no mesh`);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((P.length / 3) * 2), 2));
  geo.setAttribute('cCol', new THREE.Float32BufferAttribute(C, 4));
  return geo;
}

/** Every part node of a parsed GLB scene, by name. */
function partsOf(scene: THREE.Object3D): Map<string, THREE.Object3D> {
  const out = new Map<string, THREE.Object3D>();
  for (const c of scene.children) out.set(c.name, c);
  return out;
}

export type Fetcher = (url: string) => Promise<ArrayBuffer>;

const defaultFetch: Fetcher = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`sprite3d: ${url}: HTTP ${r.status}`);
  return r.arrayBuffer();
};

async function parseGlb(buf: ArrayBuffer, url: string): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  try {
    const gltf = await loader.parseAsync(buf, '');
    return gltf.scene;
  } catch (e) {
    throw new Error(`sprite3d: ${url}: not a readable GLB (${(e as Error).message})`);
  }
}

/**
 * Load every model in the manifest (lo + hi) and check the contract: each model the game
 * knows (SPRITE_MODELS) is there with every part zombie.ts may ask it for. Rejects on anything
 * missing; the meshes become available only when all of them loaded.
 */
export function loadSpriteModels(base = `${ASSET_BASE}models/zombies/`, fetchBuf: Fetcher = defaultFetch): Promise<void> {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = (async () => {
    const manifestBuf = await fetchBuf(`${base}manifest.json`);
    const manifest = JSON.parse(new TextDecoder().decode(manifestBuf)) as SpriteModelManifest;
    const out = new Map<string, MeshShape>();
    const tri: Record<string, { lo: number; hi: number }> = {};
    await Promise.all(SPRITE_MODELS.map(async (id: SpriteModelId) => {
      const e = manifest.models?.[id];
      if (!e) throw new Error(`sprite3d: model ${id} missing from ${base}manifest.json`);
      const [lo, hi] = await Promise.all([e.lo, e.hi].map(async (f) => partsOf(await parseGlb(await fetchBuf(base + f), base + f))));
      const want = [...SPRITE_CORE_PARTS, ...SPRITE_MODEL_GEAR[id]];
      const t = { lo: 0, hi: 0 };
      for (const part of want) {
        const l = lo.get(part), h = hi.get(part);
        if (!l || !h) throw new Error(`sprite3d: ${id} has no ${!l ? 'lo' : 'hi'} mesh for part ${part}`);
        const s: MeshShape = { key: `${id}/${part}`, lo: partGeometry(l), hi: partGeometry(h) };
        t.lo += s.lo.getAttribute('position').count / 3;
        t.hi += s.hi.getAttribute('position').count / 3;
        out.set(s.key, s);
      }
      tri[id] = t;
    }));
    loaded = out;
    stats = tri;
    generation++;
  })();
  // a failed load can be retried (after fixing the assets) instead of caching the rejection
  loading.catch(() => (loading = null));
  return loading;
}

/** Tests only: forget what was loaded. */
export function resetSpriteModelsForTests(): void {
  generation++;
  loaded = null;
  loading = null;
  stats = {};
}

/** Tests only: register meshes without GLBs (every key gets a unit box). */
export function registerTestMeshes(keys: string[]): void {
  const box = (): THREE.BufferGeometry => {
    const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const n = g.getAttribute('position').count;
    // palette region 0 (skin), shade 1
    g.setAttribute('cCol', new THREE.Float32BufferAttribute(new Array(n * 4).fill(1), 4));
    return g;
  };
  loaded ??= new Map();
  generation++;
  for (const k of keys) loaded.set(k, { key: k, lo: box(), hi: box() });
}
