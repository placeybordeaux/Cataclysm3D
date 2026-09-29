import * as THREE from 'three';
import { buildLut, lowResSize } from './grading';

// The pixel pipeline:
//   1. scene -> low-res MRT target (HalfFloat colour + view normal/flag, depth texture)
//   2. post pass at low res: outlines (depth Laplacian + normals), distance fog,
//      linear->sRGB, ordered Bayer dither, LUT grade / palette snap  -> low-res RGBA8
//   3. blit to the canvas with exact integer nearest upscaling (+ sub-pixel shift)
// Doing the post pass at low resolution keeps every effect aligned to the pixel grid
// (a dither cell is one low-res pixel, an outline is one low-res pixel wide).

export type GradeMode = 'palette' | 'smooth' | 'off';
const GRADE_INDEX: Record<GradeMode, number> = { palette: 0, smooth: 1, off: 2 };

export interface PipelineOptions {
  /** Approximate low-res height in pixels; the actual one divides the screen exactly. */
  targetHeight: number;
  grade: GradeMode;
  /** Dither amplitude in sRGB units (0 = off). */
  dither: number;
  /** Silhouette darkening (0..1) and crease brightening (0..1). */
  outline: number;
  crease: number;
  fogNear: number;
  fogFar: number;
  /** 0..1 cap of fog opacity. */
  fogMax: number;
}

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const POST_FRAG = /* glsl */ `
precision highp float;
precision highp sampler3D;
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform sampler3D tLutPal;
uniform sampler3D tLutSmooth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uFogMax;
uniform int uMode;
uniform float uDither;
uniform float uOutline;
uniform float uCrease;
uniform float uLutSize;
uniform float uExposure;
varying vec2 vUv;

float linDepth(vec2 uv) {
  float d = texture2D(tDepth, uv).r;
  if (d >= 1.0) return 1e6;
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

vec3 toSrgb(vec3 c) {
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

float bayer4(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int idx = i.x + i.y * 4;
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[idx]) + 0.5) / 16.0;
}

void main() {
  vec2 px = 1.0 / uRes;
  vec3 col = texture2D(tColor, vUv).rgb * uExposure;
  float dC = linDepth(vUv);
  bool sky = dC > 1e5;

  if (!sky) {
    // --- outlines -------------------------------------------------------------------
    // For planar surfaces 1/depth is affine in screen space, so comparing each neighbour
    // with the planar continuation from the opposite side rejects grazing floors (which
    // naive depth-difference outlines light up at distance).
    vec4 nC4 = texture2D(tNormal, vUv);
    vec3 nC = nC4.xyz * 2.0 - 1.0;
    float invC = 1.0 / dC;
    float sil = 0.0;
    float convex = 0.0;
    float concave = 0.0;
    vec2 offs[4] = vec2[4](vec2(px.x, 0.0), vec2(-px.x, 0.0), vec2(0.0, px.y), vec2(0.0, -px.y));
    for (int i = 0; i < 4; i++) {
      vec2 o = offs[i];
      float dn = linDepth(vUv + o);
      float dO = linDepth(vUv - o);
      float invN = dn > 1e5 ? 0.0 : 1.0 / dn;
      float invO = dO > 1e5 ? invC : 1.0 / dO;
      float pred = 2.0 * invC - invO;
      float diff = (pred - invN) / invC; // > 0: neighbour farther than the plane predicts
      if (diff > 0.12 && dn > dC * 1.04) sil = 1.0;
      vec4 nN4 = texture2D(tNormal, vUv + o);
      if (nC4.a > 0.5 && nN4.a > 0.5) {
        float nd = dot(nC, nN4.xyz * 2.0 - 1.0);
        if (nd < 0.8 && abs(diff) < 0.12) {
          if (diff > 0.0005) convex = 1.0; else concave = 1.0;
        }
      }
    }
    float fog = uFogMax * smoothstep(uFogNear, uFogFar, dC);
    float near = 1.0 - smoothstep(uFogNear * 0.8, uFogFar, dC);
    if (sil > 0.5) col *= mix(1.0, 1.0 - uOutline, near);
    else if (convex > 0.5) col = col * (1.0 + uCrease * near) + uCrease * 0.02 * near;
    else if (concave > 0.5) col *= 1.0 - uCrease * 0.5 * near;

    // --- fog -------------------------------------------------------------------------
    col = mix(col, uFogColor, fog);
  }

  vec3 s = toSrgb(col);
  if (uMode != 2) {
    s += (bayer4(gl_FragCoord.xy) - 0.5) * uDither;
    s = clamp(s, 0.0, 1.0);
    vec3 lc = s * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
    if (uMode == 0) s = texture(tLutPal, lc).rgb;
    else {
      s = texture(tLutSmooth, lc).rgb;
      s = floor(s * 20.0 + 0.5) / 20.0;
    }
  }
  gl_FragColor = vec4(s, 1.0);
}`;

const BLIT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uLowRes;
uniform float uScale;
uniform vec2 uOffset; // sub-pixel camera compensation, in device px
uniform float uMargin;
void main() {
  vec2 p = floor((gl_FragCoord.xy + uOffset) / uScale) + uMargin;
  gl_FragColor = texture2D(tSrc, (p + 0.5) / uLowRes);
}`;

function lut3d(data: Uint8Array, size: number, filter: THREE.MagnificationTextureFilter): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(data, size, size, size);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.magFilter = filter;
  t.minFilter = filter;
  t.wrapR = t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  return t;
}

export class PixelPipeline {
  readonly options: PipelineOptions;
  scene!: THREE.WebGLRenderTarget;
  private postTarget!: THREE.WebGLRenderTarget;
  private postMat: THREE.ShaderMaterial;
  private blitMat: THREE.ShaderMaterial;
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scale = 1;
  lowW = 1;
  lowH = 1;
  readonly margin = 1;
  /** Sub-pixel shift (in low-res pixels) applied at blit time; set by the camera rig. */
  readonly subPixel = new THREE.Vector2();
  exposure = 1;

  constructor(private three: THREE.WebGLRenderer, opts: Partial<PipelineOptions> = {}) {
    this.options = {
      targetHeight: 360, grade: 'palette', dither: 0.035, outline: 0.55, crease: 0.22,
      fogNear: 22, fogFar: 78, fogMax: 0.92, ...opts,
    };
    const LUT = 32;
    const pal = lut3d(buildLut(LUT, 'palette'), LUT, THREE.NearestFilter);
    const smooth = lut3d(buildLut(LUT, 'smooth'), LUT, THREE.LinearFilter);
    this.postMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        tColor: { value: null }, tNormal: { value: null }, tDepth: { value: null },
        tLutPal: { value: pal }, tLutSmooth: { value: smooth }, uLutSize: { value: LUT },
        uRes: { value: new THREE.Vector2() }, uNear: { value: 0.1 }, uFar: { value: 300 },
        uFogColor: { value: new THREE.Color() }, uFogNear: { value: 20 }, uFogFar: { value: 80 }, uFogMax: { value: 1 },
        uMode: { value: 0 }, uDither: { value: 0.05 }, uOutline: { value: 0.5 }, uCrease: { value: 0.2 },
        uExposure: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.blitMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BLIT_FRAG,
      uniforms: {
        tSrc: { value: null }, uLowRes: { value: new THREE.Vector2() }, uScale: { value: 1 },
        uOffset: { value: new THREE.Vector2() }, uMargin: { value: 1 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** (Re)allocate targets for a drawing buffer of w x h device pixels. */
  setSize(w: number, h: number): void {
    const s = lowResSize(w, h, this.options.targetHeight, this.margin);
    if (this.scene && s.w === this.lowW && s.h === this.lowH && s.scale === this.scale) return;
    this.scale = s.scale;
    this.lowW = s.w;
    this.lowH = s.h;
    this.scene?.dispose();
    this.postTarget?.dispose();
    const depth = new THREE.DepthTexture(s.w, s.h);
    depth.type = THREE.UnsignedIntType;
    this.scene = new THREE.WebGLRenderTarget(s.w, s.h, {
      count: 2,
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depth,
      depthBuffer: true,
    });
    this.postTarget = new THREE.WebGLRenderTarget(s.w, s.h, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
    });
  }

  /** Low-res aspect ratio (cameras must use this, it includes the margin). */
  get aspect(): number {
    return this.lowW / this.lowH;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, fogColor: THREE.Color): void {
    const r = this.three;
    const o = this.options;
    r.setRenderTarget(this.scene);
    r.clear();
    r.render(scene, camera);

    const u = this.postMat.uniforms;
    u.tColor.value = this.scene.textures[0];
    u.tNormal.value = this.scene.textures[1];
    u.tDepth.value = this.scene.depthTexture;
    u.uRes.value.set(this.lowW, this.lowH);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    u.uFogColor.value.copy(fogColor);
    u.uFogNear.value = o.fogNear;
    u.uFogFar.value = o.fogFar;
    u.uFogMax.value = o.fogMax;
    u.uMode.value = GRADE_INDEX[o.grade];
    u.uDither.value = o.grade === 'off' ? 0 : o.dither;
    u.uOutline.value = o.outline;
    u.uCrease.value = o.crease;
    u.uExposure.value = this.exposure;
    this.quad.material = this.postMat;
    r.setRenderTarget(this.postTarget);
    r.render(this.quadScene, this.quadCam);

    const b = this.blitMat.uniforms;
    b.tSrc.value = this.postTarget.texture;
    b.uLowRes.value.set(this.lowW, this.lowH);
    b.uScale.value = this.scale;
    b.uMargin.value = this.margin;
    b.uOffset.value.set(this.subPixel.x * this.scale, this.subPixel.y * this.scale);
    this.quad.material = this.blitMat;
    r.setRenderTarget(null);
    r.render(this.quadScene, this.quadCam);
  }
}
