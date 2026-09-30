import * as THREE from 'three';
import { buildLut, lowResSize } from './grading';
import { SKY_GRADIENT } from './sky';
import type { SkyState } from './lights';

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
  /**
   * What the ordered dither pattern is fixed to. 'screen': low-res pixel grid (classic).
   * 'view': the screen grid shifted by the camera's yaw/pitch in whole pixel-angles, so
   * when the camera turns the pattern scrolls with the image (exactly at the screen
   * centre, where a snapped turn moves content by whole pixels) instead of the image
   * crawling under a fixed pattern. (Anchoring to true view angles was tried too: it
   * distorts the Bayer cells toward the screen edges.)
   */
  ditherAnchor: 'screen' | 'view';
  /** Screen-space ambient occlusion strength (0 = off, skips the pass). */
  ssao: number;
  /** Bloom strength (0 = off, skips the passes). */
  bloom: number;
  /** Aerial-perspective strength (0 = off). */
  atmosphere: number;
  /** How much the distant skyline fades into the fog colour. */
  skylineFog: number;
  /** atmosphere.ts: 0 = legacy grey fog, 1 = sky-matched fade (fog* then = fade range). */
  atmosMode: number;
  /** Aerial perspective e-folding distance (m), share at infinity, desaturated share. */
  hazeDist: number;
  hazeMax: number;
  hazeDesat: number;
  /** Outlines/SSAO fade from this fraction of fogFar (distance detail is shimmer). */
  detailFade: number;
  /** Sky-matched fade: share reached at fogFar, and where it reaches 1 (m). */
  edgeLevel: number;
  farEnd: number;
  farMax: number;
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
uniform float uHurt;
uniform float uNightVision;
uniform vec2 uDitherOffset;
uniform vec2 uTan;        // tan(fov/2) * (aspect, 1): view-space position from depth
uniform float uSsao;
uniform float uAtmos;
uniform vec3 uHaze;
uniform float uSkylineFog;
uniform float uBloom;
uniform sampler2D tBloom;
uniform int uDebugView;
uniform int uAtmosMode;
uniform float uHazeDist;
uniform float uHazeMax;
uniform float uHazeDesat;
uniform float uDetailFade;
uniform float uEdgeLevel;
uniform float uFarEnd;
uniform float uFarMax;
uniform mat3 uCamRot;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;
varying vec2 vUv;
${SKY_GRADIENT}

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

vec3 viewPos(vec2 uv, float d) {
  return vec3((uv * 2.0 - 1.0) * uTan * d, -d);
}

// Normal-oriented hemisphere SSAO at low resolution. The kernel is rotated per pixel by a
// 4x4 Bayer angle, so the residual noise is an ordered pattern like the colour dither
// (reads as pixel-art shading and needs no blur pass).
float ssao(vec2 uv, float d, vec3 n) {
  vec3 p = viewPos(uv, d);
  float a = bayer4(gl_FragCoord.xy + uDitherOffset) * 6.2831853;
  vec3 rnd = vec3(cos(a), sin(a), 0.0);
  vec3 t = rnd - n * dot(rnd, n);
  t = dot(t, t) < 1e-4 ? vec3(0.0, 1.0, 0.0) : normalize(t);
  vec3 b = cross(n, t);
  const float R = 0.6;
  float occ = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i);
    float r = (fi + 1.0) / 8.0;
    r = mix(0.15, 1.0, r * r);
    float ang = fi * 2.39996;
    vec3 k = vec3(cos(ang) * 0.8, sin(ang) * 0.8, 0.3 + 0.6 * fract(fi * 0.618));
    vec3 s = p + (t * k.x + b * k.y + n * k.z) * (R * r);
    vec2 su = (s.xy / (-s.z)) / uTan * 0.5 + 0.5;
    if (su.x < 0.0 || su.y < 0.0 || su.x > 1.0 || su.y > 1.0) continue;
    float diff = -s.z - linDepth(su);
    if (diff > 0.02 * d / 10.0 + 0.02) occ += smoothstep(0.0, 1.0, R / diff);
  }
  return 1.0 - occ / 8.0;
}

// Sky-matched distance model (atmosphere.ts). Two parts:
//  * aerial perspective: a light in-scatter toward the sky colour along this ray (warm
//    toward a low sun, blue elsewhere), capped at uHazeMax, so silhouettes and dark shapes
//    (a zombie on the road at 50 m) keep their contrast;
//  * distance fade: reaches uEdgeLevel over the last stretch of the drawn chunks, then
//    keeps going over the far ground ring and skyline (skyline.ts, true distance from the
//    normal target) to fully sky at uFarEnd, so the ground meets the sky at the horizon
//    instead of stopping at a fog wall.
vec3 atmosphere(vec3 col, float d, vec3 skyC, vec3 hazeC) {
  if (uAtmos > 0.0) {
    float a = uAtmos * uHazeMax * (1.0 - exp(-d / uHazeDist));
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    col = mix(col, vec3(l), a * uHazeDesat);
    col = mix(col, hazeC, a);
  }
  float e = uEdgeLevel * smoothstep(uFogNear, uFogFar, d) + (max(uFarMax, uEdgeLevel) - uEdgeLevel) * smoothstep(uFogFar, uFarEnd, d);
  return mix(col, skyC, e * uFogMax);
}

void main() {
  vec2 px = 1.0 / uRes;
  vec3 col = texture2D(tColor, vUv).rgb * uExposure;
  if (uBloom > 0.0) col += texture2D(tBloom, vUv).rgb * uBloom * uExposure;
  float dC = linDepth(vUv);
  bool sky = dC > 1e5;
  // alpha 0.5 in the normal target marks the distant skyline: no outlines, its own haze
  // (r = true distance / 1024: the impostor is pulled in, so its depth isn't its distance)
  vec4 nS = texture2D(tNormal, vUv);
  bool skyline = abs(nS.a - 0.5) < 0.2;

  // the sky right behind this pixel (world-space view ray): what distance fades into
  vec3 ray = normalize(uCamRot * vec3((vUv * 2.0 - 1.0) * uTan, -1.0));
  vec3 skyC = uAtmosMode == 1 ? skyGradient(ray) : uFogColor;
  // Haze toward a low sun takes only a third of its glow: with all of it, looking into the
  // afternoon sun washed every building past 40 m into the same bright blur
  vec3 hazeC = uAtmosMode == 1 ? skyGradientGlow(ray, 0.35) : uFogColor;
  if (skyline) {
    col = uAtmosMode == 1 ? atmosphere(col, nS.r * 1024.0, skyC, hazeC) : mix(col, skyC, uSkylineFog);
  } else if (!sky) {
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
    if (uDebugView == 2) { gl_FragColor = vec4(nC4.rgb, 1.0); return; }
    if (uSsao > 0.0 && nC4.a > 0.75) {
      float ao = ssao(vUv, dC, normalize(nC));
      if (uDebugView == 1) { gl_FragColor = vec4(vec3(ao), 1.0); return; }
      col *= mix(1.0, ao, uSsao * (1.0 - smoothstep(uFogFar * uDetailFade, uFogFar, dC)));
    }
    float fog = uFogMax * smoothstep(uFogNear, uFogFar, dC);
    float near = 1.0 - smoothstep(uFogFar * uDetailFade, uFogFar, dC);
    if (sil > 0.5) col *= mix(1.0, 1.0 - uOutline, near);
    else if (convex > 0.5) col = col * (1.0 + uCrease * near) + uCrease * 0.02 * near;
    else if (concave > 0.5) col *= 1.0 - uCrease * 0.5 * near;

    // --- aerial perspective + fog -----------------------------------------------------
    if (uAtmosMode == 1) col = atmosphere(col, dC, skyC, hazeC);
    else if (uAtmos > 0.0) {
      // distance desaturates and shifts toward the haze colour well before the fog wall,
      // which is what separates planes of depth (full-spectrum, graded afterwards)
      float a = uAtmos * (1.0 - exp(-dC / 60.0));
      float l = dot(col, vec3(0.3, 0.59, 0.11));
      col = mix(col, vec3(l), a * 0.4);
      col = mix(col, uHaze, a * 0.45);
    }
    if (uAtmosMode != 1) col = mix(col, uFogColor, fog);
  }

  // night vision (mutations / bionic NV): amplified, green-tinted luminance
  if (uNightVision > 0.0) {
    float l = dot(col, vec3(0.3, 0.59, 0.11));
    vec3 nv = vec3(0.42, 1.0, 0.48) * min(1.0, pow(l * 6.0, 0.7) * 0.55);
    col = mix(col, max(col, nv), uNightVision);
  }

  // hurt flash: red vignette, strongest at the edges, before grading so it gets dithered
  if (uHurt > 0.0) {
    vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);
    float v = smoothstep(0.25, 0.8, length(q));
    col = mix(col, vec3(0.55, 0.02, 0.015), uHurt * (0.06 + 0.6 * v));
  }

  vec3 s = toSrgb(col);
  if (uMode != 2) {
    s += (bayer4(gl_FragCoord.xy + uDitherOffset) - 0.5) * uDither;
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

const _euler = new THREE.Euler();
const _proj = new THREE.Matrix4(), _projInv = new THREE.Matrix4();
/** clip z' = 0.001 z - 0.999 w: NDC depth [-1, 1] -> [-1, -0.998] (see render). */
const _squeeze = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.001, -0.999, 0, 0, 0, 1);

// Bloom: bright-pass at half the low resolution, then a separable blur, added back in the
// post pass before grading (so the glow is dithered and palette-snapped like the rest).
const BRIGHT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform float uExposure;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * uExposure;
  float l = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * max(l - uThreshold, 0.0) / max(l, 1e-4), 1.0);
}`;
const BLUR_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.227;
  c += (texture2D(tSrc, vUv + uDir * 1.385).rgb + texture2D(tSrc, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture2D(tSrc, vUv + uDir * 3.23).rgb + texture2D(tSrc, vUv - uDir * 3.23).rgb) * 0.070;
  gl_FragColor = vec4(c, 1.0);
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
  /** @internal graded low-res image (read back by the shimmer test) */
  postTarget!: THREE.WebGLRenderTarget;
  private postMat: THREE.ShaderMaterial;
  private blitMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  /** Debug output of the post pass: 0 normal, 1 SSAO term, 2 view normals. */
  debugView = 0;
  /** Haze colour for aerial perspective (renderer sets it from the sky each frame). */
  readonly haze = new THREE.Color();
  /** Sky the sky-matched fade blends into (renderer: setSky each frame). */
  private skyState: SkyState | null = null;
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
  /** 0..1 red hurt vignette (renderer.hurtFlash decays it). */
  hurt = 0;
  /** 0..1 night-vision amplification + green tint (renderer.nightVision at night). */
  nightVision = 0;
  /** @internal signs of the view-anchored dither offset (verified with cdda.shimmerTest) */
  dirX = 1;
  dirY = 1;

  constructor(private three: THREE.WebGLRenderer, opts: Partial<PipelineOptions> = {}) {
    this.options = {
      targetHeight: 360, grade: 'palette', dither: 0.035, outline: 0.55, crease: 0.22,
      fogNear: 28, fogFar: 96, fogMax: 0.92, ditherAnchor: 'view', ssao: 0, bloom: 0, atmosphere: 0, skylineFog: 0.7,
      atmosMode: 0, hazeDist: 60, hazeMax: 1, hazeDesat: 0.4, detailFade: 0.28, edgeLevel: 1, farEnd: 400, farMax: 1, ...opts,
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
        uExposure: { value: 1 }, uHurt: { value: 0 }, uNightVision: { value: 0 },
        uDitherOffset: { value: new THREE.Vector2() },
        uTan: { value: new THREE.Vector2(1, 1) }, uSsao: { value: 0 }, uAtmos: { value: 0 },
        uHaze: { value: new THREE.Color() }, uSkylineFog: { value: 0.7 }, uBloom: { value: 0 }, tBloom: { value: null }, uDebugView: { value: 0 },
        uEdgeLevel: { value: 1 }, uFarEnd: { value: 400 }, uFarMax: { value: 1 }, uAtmosMode: { value: 0 }, uHazeDist: { value: 60 }, uHazeMax: { value: 1 }, uHazeDesat: { value: 0.4 }, uDetailFade: { value: 0.28 },
        uCamRot: { value: new THREE.Matrix3() }, uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunColor: { value: new THREE.Color() }, uNight: { value: 0 },
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
    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BRIGHT_FRAG,
      uniforms: { tSrc: { value: null }, uExposure: { value: 1 }, uThreshold: { value: 1.4 } },
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG,
      uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false, depthWrite: false,
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
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    const bo = { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.bloomA = new THREE.WebGLRenderTarget(Math.max(1, s.w >> 1), Math.max(1, s.h >> 1), bo);
    this.bloomB = new THREE.WebGLRenderTarget(Math.max(1, s.w >> 1), Math.max(1, s.h >> 1), bo);
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

  /** The sky dome's current colours/sun (the sky-matched distance fade must match it). */
  setSky(sky: SkyState): void {
    this.skyState = sky;
  }

  /** Low-res aspect ratio (cameras must use this, it includes the margin). */
  get aspect(): number {
    return this.lowW / this.lowH;
  }

  /**
   * `overlay` (the first-person viewmodel) is drawn into the same low-res target after the
   * world with depth cleared, so it is outlined, dithered and graded like everything else.
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, fogColor: THREE.Color,
    overlay?: { scene: THREE.Scene; camera: THREE.Camera }): void {
    const r = this.three;
    const o = this.options;
    r.setRenderTarget(this.scene);
    r.clear();
    r.render(scene, camera);
    if (overlay) {
      // The overlay keeps its own depth order but must not erase the world's depth (the
      // post pass reads it for fog, outlines and SSAO; clearing it made the whole first-
      // person world "sky" there). Squeeze the overlay camera's depth into the first
      // 0.1% of the range instead: always in front of the world, still self-occluding.
      const auto = r.autoClear;
      r.autoClear = false;
      const cam = overlay.camera;
      _proj.copy(cam.projectionMatrix);
      _projInv.copy(cam.projectionMatrixInverse);
      cam.projectionMatrix.premultiply(_squeeze);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
      r.render(overlay.scene, cam);
      cam.projectionMatrix.copy(_proj);
      cam.projectionMatrixInverse.copy(_projInv);
      r.autoClear = auto;
    }

    if (o.bloom > 0 && this.bloomA && this.bloomB) {
      const A = this.bloomA, B = this.bloomB;
      this.brightMat.uniforms.tSrc.value = this.scene.textures[0];
      this.brightMat.uniforms.uExposure.value = this.exposure;
      this.quad.material = this.brightMat;
      r.setRenderTarget(A);
      r.render(this.quadScene, this.quadCam);
      this.quad.material = this.blurMat;
      const bu = this.blurMat.uniforms;
      // two blur iterations with growing step: a wide soft halo from a half-res target
      for (const step of [1, 2.2]) {
        bu.tSrc.value = A.texture;
        bu.uDir.value.set(step / A.width, 0);
        r.setRenderTarget(B);
        r.render(this.quadScene, this.quadCam);
        bu.tSrc.value = B.texture;
        bu.uDir.value.set(0, step / A.height);
        r.setRenderTarget(A);
        r.render(this.quadScene, this.quadCam);
      }
    }

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
    u.uHurt.value = this.hurt;
    u.uNightVision.value = this.nightVision;
    const ty = Math.tan((camera.fov * Math.PI) / 360);
    u.uTan.value.set(ty * camera.aspect, ty);
    u.uSsao.value = o.ssao;
    u.uDebugView.value = this.debugView;
    u.uAtmos.value = o.atmosphere;
    u.uHaze.value.copy(this.haze);
    u.uSkylineFog.value = o.skylineFog;
    u.uAtmosMode.value = o.atmosMode;
    u.uHazeDist.value = o.hazeDist;
    u.uHazeMax.value = o.hazeMax;
    u.uHazeDesat.value = o.hazeDesat;
    u.uDetailFade.value = o.detailFade;
    u.uEdgeLevel.value = o.edgeLevel;
    u.uFarEnd.value = o.farEnd;
    u.uFarMax.value = o.farMax;
    u.uCamRot.value.setFromMatrix4(camera.matrixWorld);
    const sk = this.skyState;
    if (sk) {
      // same uniforms as sky.ts (Sky.update), so skyGradient gives the dome's colour
      u.uZenith.value.copy(sk.zenith);
      u.uHorizon.value.copy(sk.horizon);
      u.uGround.value.copy(sk.fog).multiplyScalar(0.6);
      u.uSunDir.value.copy(sk.sunDir);
      u.uSunColor.value.copy(sk.sunColor);
      u.uNight.value = sk.night;
    }
    u.uBloom.value = o.bloom > 0 && this.bloomA ? o.bloom : 0;
    u.tBloom.value = this.bloomA?.texture ?? null;
    if (o.ditherAnchor === 'view') {
      // camera yaw/pitch in pixel-angles (rotation order YXZ: y = -yaw, x = pitch)
      const q = (2 * Math.tan((camera.fov * Math.PI) / 360)) / this.lowH;
      _euler.setFromQuaternion(camera.quaternion, 'YXZ');
      u.uDitherOffset.value.set(Math.round(-_euler.y / q) * this.dirX, Math.round(_euler.x / q) * this.dirY);
    } else u.uDitherOffset.value.set(0, 0);
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
