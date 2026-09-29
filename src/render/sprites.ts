import * as THREE from 'three';
import { LEVEL_HEIGHT } from '../world/coords';
import { shared, spriteMaterial } from './materials';
import type { TileFrame, TileTextureSource } from './textureSource';

// World-space billboards (Doom/Daggerfall style) for creatures, items, furniture, trees.
// One InstancedMesh per texture page, so thousands of sprites cost a handful of draw
// calls. Billboarding happens in the vertex shader (see materials.ts spriteMaterial);
// sprites are lit by the same banded lights as the world and cast shadows.
//
// Usage (other systems):
//   const h = renderer.sprites.add({ x: 10.5, y: 3.5, z: 0, glyph: { symbol: 'Z', color: 'green' }, height: 1.7 });
//   h.set(11, 3.2, 0);   // tile coords, float
//   h.flash(0xff2020);   // hit flash, fades over ~0.2 s
//   h.remove();

export interface SpriteSpec {
  /** Tile coordinates (x east, y south; +0.5 = tile centre) and z-level. */
  x: number;
  y: number;
  z: number;
  /** Either an explicit frame (from a TileTextureSource) or a CDDA glyph. */
  frame?: TileFrame;
  glyph?: { symbol: string; color: string };
  /** Height in metres (default 1). Width follows the frame's aspect unless given. */
  height?: number;
  width?: number;
  /** 'bottom' stands on the floor (default); 'center' floats centred at `lift`. */
  anchor?: 'bottom' | 'center';
  /** Metres above the level's floor (default 0). */
  lift?: number;
}

export interface SpriteHandle {
  set(x: number, y: number, z: number): void;
  setFrame(frame: TileFrame, height?: number): void;
  /** Tint fully to `color` then fade back over `seconds`. */
  flash(color?: number, seconds?: number): void;
  setVisible(v: boolean): void;
  remove(): void;
  readonly alive: boolean;
}

const INITIAL = 64;

class Batch {
  mesh: THREE.InstancedMesh;
  count = 0;
  owners: Sprite[] = [];
  private geo: THREE.InstancedBufferGeometry;
  rect!: THREE.InstancedBufferAttribute;
  size!: THREE.InstancedBufferAttribute;
  flash!: THREE.InstancedBufferAttribute;

  constructor(readonly page: THREE.Texture, private parent: THREE.Object3D, private depthMat: THREE.Material, capacity = INITIAL) {
    this.geo = Batch.makeGeometry(capacity);
    this.mesh = this.makeMesh(capacity);
  }

  private static makeGeometry(cap: number): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    const q = new THREE.PlaneGeometry(1, 1);
    q.translate(0, 0.5, 0);
    g.index = q.index;
    g.setAttribute('position', q.getAttribute('position'));
    g.setAttribute('normal', q.getAttribute('normal'));
    g.setAttribute('uv', q.getAttribute('uv'));
    g.setAttribute('instRect', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    g.setAttribute('instSize', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    g.setAttribute('instFlash', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
    return g;
  }

  private makeMesh(cap: number): THREE.InstancedMesh {
    const m = new THREE.InstancedMesh(this.geo, spriteMaterial(this.page), cap);
    m.count = this.count;
    m.frustumCulled = false; // instances span the whole view; per-instance culling isn't worth it
    m.castShadow = true;
    m.receiveShadow = true;
    m.customDepthMaterial = this.depthMat;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rect = this.geo.getAttribute('instRect') as THREE.InstancedBufferAttribute;
    this.size = this.geo.getAttribute('instSize') as THREE.InstancedBufferAttribute;
    this.flash = this.geo.getAttribute('instFlash') as THREE.InstancedBufferAttribute;
    this.parent.add(m);
    return m;
  }

  get capacity(): number {
    return this.rect.count;
  }

  grow(): void {
    const cap = this.capacity * 2;
    const old = { m: this.mesh.instanceMatrix.array, r: this.rect.array, s: this.size.array, f: this.flash.array };
    this.parent.remove(this.mesh);
    this.mesh.dispose();
    this.geo.dispose();
    this.geo = Batch.makeGeometry(cap);
    this.mesh = this.makeMesh(cap);
    (this.mesh.instanceMatrix.array as Float32Array).set(old.m);
    (this.rect.array as Float32Array).set(old.r);
    (this.size.array as Float32Array).set(old.s);
    (this.flash.array as Float32Array).set(old.f);
    this.touch();
  }

  touch(): void {
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.rect.needsUpdate = true;
    this.size.needsUpdate = true;
    this.flash.needsUpdate = true;
  }
}

class Sprite implements SpriteHandle {
  batch: Batch | null = null;
  index = -1;
  flashT = 0;
  flashDur = 0;
  flashColor = new THREE.Color();
  visible = true;
  constructor(private layer: SpriteLayer, public x: number, public y: number, public z: number,
    public frame: TileFrame, public w: number, public h: number, public yOff: number) {}
  get alive(): boolean {
    return this.batch !== null;
  }
  set(x: number, y: number, z: number): void {
    this.x = x; this.y = y; this.z = z;
    if (this.batch) this.layer.writeInstance(this);
  }
  setFrame(frame: TileFrame, height?: number): void {
    if (height !== undefined) { this.h = height; this.w = height * (frame.w / frame.h); }
    if (frame.texture !== this.frame.texture) {
      this.layer.detach(this);
      this.frame = frame;
      this.layer.attach(this);
    } else {
      this.frame = frame;
      this.layer.writeInstance(this);
    }
  }
  flash(color = 0xffffff, seconds = 0.2): void {
    this.flashColor.setHex(color);
    this.flashT = this.flashDur = seconds;
    this.layer.flashing.add(this);
    this.layer.writeInstance(this);
  }
  setVisible(v: boolean): void {
    this.visible = v;
    if (this.batch) this.layer.writeInstance(this);
  }
  remove(): void {
    this.layer.detach(this);
    this.layer.flashing.delete(this);
  }
}

export class SpriteLayer {
  readonly group = new THREE.Group();
  private batches = new Map<THREE.Texture, Batch>();
  /** @internal */ readonly flashing = new Set<Sprite>();
  private depthMats = new Map<THREE.Texture, THREE.Material>();
  /** Ambient multiplier at a position (renderer wires this to "is there a roof above"). */
  skyVisAt: ((x: number, y: number, z: number) => number) | null = null;

  constructor(private source: () => TileTextureSource) {
    this.group.name = 'sprites';
  }

  add(spec: SpriteSpec): SpriteHandle {
    const frame = spec.frame ?? (spec.glyph ? this.source().glyph(spec.glyph.symbol, spec.glyph.color) : null);
    if (!frame) throw new Error('SpriteLayer.add: need frame or glyph');
    const h = spec.height ?? 1;
    const w = spec.width ?? h * (frame.w / frame.h);
    const yOff = (spec.lift ?? 0) - (spec.anchor === 'center' ? h / 2 : 0);
    const s = new Sprite(this, spec.x, spec.y, spec.z, frame, w, h, yOff);
    this.attach(s);
    return s;
  }

  /** Fade hit flashes; call once per frame. */
  update(dt: number): void {
    for (const s of this.flashing) {
      s.flashT -= dt;
      if (s.flashT <= 0) {
        s.flashT = 0;
        this.flashing.delete(s);
      }
      if (s.batch) this.writeInstance(s);
    }
  }

  get count(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.count;
    return n;
  }

  /** @internal */
  attach(s: Sprite): void {
    let b = this.batches.get(s.frame.texture);
    if (!b) {
      b = new Batch(s.frame.texture, this.group, this.depthMaterial(s.frame.texture));
      this.batches.set(s.frame.texture, b);
    }
    if (b.count >= b.capacity) b.grow();
    s.batch = b;
    s.index = b.count++;
    b.owners[s.index] = s;
    this.writeInstance(s);
  }

  /** @internal swap-remove: O(1), moves the last instance into the hole. */
  detach(s: Sprite): void {
    const b = s.batch;
    if (!b) return;
    const last = b.count - 1;
    if (s.index !== last) {
      const moved = b.owners[last];
      b.owners[s.index] = moved;
      moved.index = s.index;
      this.writeInstance(moved);
    }
    b.owners.length = last;
    b.count = last;
    b.touch();
    s.batch = null;
    s.index = -1;
  }

  /** @internal */
  writeInstance(s: Sprite): void {
    const b = s.batch!;
    const i = s.index;
    const m = b.mesh.instanceMatrix.array as Float32Array;
    // translation-only matrix (column-major)
    m.fill(0, i * 16, i * 16 + 16);
    m[i * 16] = m[i * 16 + 5] = m[i * 16 + 10] = m[i * 16 + 15] = 1;
    m[i * 16 + 12] = s.x;
    m[i * 16 + 13] = s.z * LEVEL_HEIGHT;
    m[i * 16 + 14] = s.y;
    const r = b.rect.array as Float32Array;
    const f = s.frame.uv;
    r[i * 4] = f[0]; r[i * 4 + 1] = f[1]; r[i * 4 + 2] = f[2] - f[0]; r[i * 4 + 3] = f[3] - f[1];
    const sz = b.size.array as Float32Array;
    // Invisible sprites collapse to zero size rather than being moved out of the batch.
    sz[i * 4] = s.visible ? s.w : 0; sz[i * 4 + 1] = s.visible ? s.h : 0; sz[i * 4 + 2] = s.yOff;
    sz[i * 4 + 3] = this.skyVisAt ? this.skyVisAt(s.x, s.y, s.z) : 1;
    const fl = b.flash.array as Float32Array;
    const k = s.flashDur > 0 ? s.flashT / s.flashDur : 0;
    fl[i * 4] = s.flashColor.r; fl[i * 4 + 1] = s.flashColor.g; fl[i * 4 + 2] = s.flashColor.b; fl[i * 4 + 3] = k;
    b.touch();
  }

  private depthMaterial(page: THREE.Texture): THREE.Material {
    let d = this.depthMats.get(page);
    if (d) return d;
    // Shadow pass: same billboard expansion (facing the light's camera, which gives the
    // sprite's full silhouette as its shadow) + atlas-rect alpha test.
    const dm = new THREE.MeshDepthMaterial({ map: page, alphaTest: 0.5, depthPacking: THREE.RGBADepthPacking, side: THREE.DoubleSide });
    dm.onBeforeCompile = (shader) => {
      shader.uniforms.uSpriteTilt = shared.uSpriteTilt;
      shader.vertexShader = `attribute vec4 instRect;\nattribute vec4 instSize;\nvarying vec4 vInstRect;\n` + shader.vertexShader.replace(
        '#include <begin_vertex>',
        `vec3 camRight = normalize(vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]) + vec3(1e-5, 0.0, 0.0));
         vec3 transformed = camRight * position.x * instSize.x + vec3(0.0, position.y * instSize.y + instSize.z, 0.0);
         vInstRect = instRect;`,
      );
      shader.fragmentShader = 'varying vec4 vInstRect;\n' + shader.fragmentShader.replace(
        '#include <map_fragment>',
        'vec4 sampledDiffuseColor = texture2D( map, vInstRect.xy + clamp(vMapUv, 0.001, 0.999) * vInstRect.zw ); diffuseColor *= sampledDiffuseColor;',
      );
    };
    dm.customProgramCacheKey = () => 'cdda-sprite-depth';
    this.depthMats.set(page, dm);
    return dm;
  }
}
