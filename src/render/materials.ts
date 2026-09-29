import * as THREE from 'three';
import { lmUniforms } from './lightmap';

// Every material drawn into the low-res scene target is a built-in three.js material with
// a few shader patches, so we keep three's lights/shadows machinery:
//
//  * MRT normal output: the scene target has two attachments; attachment 1 receives the
//    view-space normal (rgb) and an "outline me" flag (a). The post pass uses it for
//    crease outlines. Anything rendered into the scene MUST be patched with
//    `patchNormalOutput` (the renderer auto-patches unpatched scene materials each frame,
//    see Renderer.autoPatch) or attachment 1 is undefined for its pixels.
//  * Banded lighting: each direct light's irradiance is quantized into a few steps
//    (in sqrt space so darks get more steps). This gives the hard light pools and
//    stepped falloff of hand-shaded pixel art.
//  * Atlas tiling: chunk geometry carries UVs in tile units plus a per-vertex atlas rect;
//    the fragment wraps UVs inside the rect, so a 2.6 m wall repeats a 1 m texture
//    without splitting quads, and atlas frames can come from any page position.
//  * Wall cut: top-down mode lowers vertices flagged `cut` on the current level.
//  * Light map (lightmap.ts): world faces sample the CDDA-style tile light map at their
//    position pushed half a tile along the normal (so a wall face reads the light of the
//    room it faces, never the other side); sprites sample it once per instance in the
//    vertex shader. Its natural channel replaces the old per-vertex sky share for ambient
//    and gates the sun; its artificial channel adds shadowcast lamp/fire light.

/** Uniforms shared by reference across all patched materials (update .value only). */
export const shared = {
  uBands: { value: 5.0 },
  uCutFloor: { value: -1e6 }, // only vertices above this Y are affected (current level)
  uCutTo: { value: 1e6 }, // clamp height
  uSpriteTilt: { value: 0.0 }, // 0 = upright cylindrical billboards, 1 = face camera fully
  uTime: { value: 0 },
  // look.ts features (0 = off): sky rim light, luminance bump on world faces, rounded
  // sprite normals. Uniforms rather than defines so switching looks never recompiles.
  uRim: { value: 0 },
  uRimColor: { value: new THREE.Color(0, 0, 0) },
  uBump: { value: 0 },
  uSpriteRound: { value: 0 },
  /** Pitched roofs (cut >= 1000 + level) vanish while the player is on/above that level. */
  uPlayerLevel: { value: 0 },
};

const NORMAL_OUT_DECL = 'layout(location = 1) out highp vec4 gNormal;\n';

/** Append attachment-1 output. `flag` is written to alpha: 1 = participates in outlines. */
export function normalOutputChunk(hasNormal: boolean, flag: number): string {
  return hasNormal
    ? `gNormal = vec4(normalize(normal) * 0.5 + 0.5, ${flag.toFixed(1)});`
    : `gNormal = vec4(0.5, 0.5, 1.0, ${flag.toFixed(1)});`;
}

type Shader = THREE.WebGLProgramParametersWithUniforms;

/** Adds the gNormal MRT output to any built-in material's fragment shader. */
function addNormalOutput(shader: Shader, hasNormal: boolean, flag: number): void {
  shader.fragmentShader = NORMAL_OUT_DECL + shader.fragmentShader.replace(
    /}\s*$/,
    `  ${normalOutputChunk(hasNormal, flag)}\n}`,
  );
}

const BANDED_DIRECT = /* glsl */ `
uniform float uBands;
vec3 bandLight(vec3 irr) {
  float l = max(max(irr.r, irr.g), irr.b);
  if (l < 1e-4) return vec3(0.0);
  float s = sqrt(l);
  float q = floor(s * uBands + 0.5) / uBands;
  return irr * (q * q / l);
}
void RE_Direct_Lambert( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  float dotNL = saturate( dot( geometryNormal, directLight.direction ) );
  vec3 irradiance = bandLight( dotNL * directLight.color );
  reflectedLight.directDiffuse += irradiance * BRDF_Lambert( material.diffuseColor );
}`;

// Light-map sampling (see lightmap.ts). Texel (i, j) holds tile (ox + i, oy + j): rgb =
// artificial irradiance, a = natural light fraction or -1 for opaque tiles. The bilinear
// filter drops opaque taps, so light never interpolates through a wall.
export const LM_FUNCS = /* glsl */ `
uniform highp sampler2D tLightMap;
uniform vec4 uLmRect;
uniform vec2 uLmLevel;
vec4 lmTap(ivec2 c) {
  int n = int(uLmRect.z);
  if (c.x < 0 || c.y < 0 || c.x >= n || c.y >= n) return vec4(0.0, 0.0, 0.0, -1.0);
  return texelFetch(tLightMap, c, 0);
}
// wp: three.js world position. Returns (artificial rgb, natural); natural < 0 = no data.
vec4 lmSample(vec3 wp) {
  if (uLmRect.w < 0.5 || wp.y < uLmLevel.x - 0.3 || wp.y > uLmLevel.x + uLmLevel.y + 0.05) return vec4(0.0, 0.0, 0.0, -1.0);
  vec2 t = vec2(wp.x, wp.z) - uLmRect.xy - 0.5;
  vec2 f0 = floor(t);
  vec2 fr = t - f0;
  ivec2 c = ivec2(f0);
  vec4 a = lmTap(c), b = lmTap(c + ivec2(1, 0)), e = lmTap(c + ivec2(0, 1)), d = lmTap(c + ivec2(1, 1));
  vec4 w = vec4((1.0 - fr.x) * (1.0 - fr.y), fr.x * (1.0 - fr.y), (1.0 - fr.x) * fr.y, fr.x * fr.y);
  w *= step(0.0, vec4(a.w, b.w, e.w, d.w));
  float sw = w.x + w.y + w.z + w.w;
  if (sw > 1e-3) return (a * w.x + b * w.y + e * w.z + d * w.w) / sw;
  // Inside an opaque tile (top of a locker, a tree trunk): average the open neighbours.
  ivec2 m = ivec2(floor(vec2(wp.x, wp.z) - uLmRect.xy));
  vec4 acc = vec4(0.0);
  float n = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1);
    vec4 v = lmTap(m + o);
    if (v.w >= 0.0) { acc += v; n += 1.0; }
  }
  return n > 0.0 ? acc / n : vec4(0.0, 0.0, 0.0, -1.0);
}
`;

// Ambient (hemisphere) light scaled by the natural light share (light map, or SKYVIS where
// the light map has no data): interiors get only what comes in through windows and doors.
// Artificial light-map light is added on top, banded like direct light.
const INDIRECT = /* glsl */ `
#ifndef SKYVIS
#define SKYVIS 1.0
#endif
vec4 gLm = vec4(0.0, 0.0, 0.0, -1.0);
uniform float uRim;
uniform vec3 uRimColor;
float lmNatural() { return gLm.w >= 0.0 ? gLm.w : SKYVIS; }
// Sun/moon only reaches where the light map says sky light gets in (beyond the shadow
// map's range this is what keeps roofs from being see-through to sunlight).
float lmSunGate() { return gLm.w >= 0.0 ? smoothstep(0.02, 0.2, gLm.w) : 1.0; }
// Point lights are unoccluded; they only count where the light map has artificial light.
float lmPointGate() { return gLm.w >= 0.0 ? smoothstep(0.0, 0.25, max(gLm.r, max(gLm.g, gLm.b))) : 1.0; }
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * lmNatural() * BRDF_Lambert( material.diffuseColor );
  if (uRim > 0.0) {
    // sky rim on silhouettes of walls/props/creatures (not on ground seen at a grazing
    // angle): separates forms from what's behind them, like a painted edge highlight
    float upN = inverseTransformDirection( geometryNormal, viewMatrix ).y;
    float f = 1.0 - saturate( dot( geometryNormal, geometryViewDir ) );
    reflectedLight.indirectDiffuse += uRimColor * (uRim * f * f * f * (1.0 - max(upN, 0.0)) * lmNatural()) * material.diffuseColor;
  }
  if (gLm.w >= 0.0) {
    // The flat light-map term is strongest on floors: on walls a tile's light may have
    // come from either side (the point lights add the directional part).
    float up = inverseTransformDirection( geometryNormal, viewMatrix ).y;
    reflectedLight.indirectDiffuse += bandLight( gLm.rgb * (0.45 + 0.55 * max(up, 0.0)) ) * BRDF_Lambert( material.diffuseColor );
  }
}`;

function patchChunk(src: string, find: string, add: string): string {
  if (!src.includes(find)) throw new Error(`materials: patch point not found: ${find}`);
  return src.replace(find, `${find}\n\t\t${add}`);
}
const LIGHTS_BEGIN = patchChunk(
  patchChunk(THREE.ShaderChunk.lights_fragment_begin, 'getDirectionalLightInfo( directionalLight, directLight );', 'directLight.color *= lmSunGate();'),
  'getPointLightInfo( pointLight, geometryPosition, directLight );', 'directLight.color *= lmPointGate();',
);

/** How a banded-Lambert material gets its light-map sample. */
type LmMode = 'world' | 'sprite' | 'none';

function patchBandedLambert(shader: Shader, lm: LmMode = 'none'): void {
  shader.uniforms.uBands = shared.uBands;
  shader.uniforms.uRim = shared.uRim;
  shader.uniforms.uRimColor = shared.uRimColor;
  const assign = lm === 'world' ? 'gLm = lmSample(vLmPos);\n' : lm === 'sprite' ? 'gLm = vLmS;\n' : '';
  if (lm !== 'none') Object.assign(shader.uniforms, lmUniforms);
  shader.fragmentShader = shader.fragmentShader
    .replace(
      '#include <lights_lambert_pars_fragment>',
      (lm === 'world' ? LM_FUNCS + 'varying vec3 vLmPos;\n' : lm === 'sprite' ? 'varying vec4 vLmS;\n' : '') +
      THREE.ShaderChunk.lights_lambert_pars_fragment
        .replace(/void RE_Direct_Lambert[\s\S]*?\n}\n/, BANDED_DIRECT + '\n')
        .replace(/void RE_IndirectDiffuse_Lambert[\s\S]*?\n}\n/, INDIRECT + '\n'),
    )
    .replace('#include <lights_fragment_begin>', assign + LIGHTS_BEGIN);
}

// --- world (chunk) material ----------------------------------------------------------

const WORLD_VERT_PARS = /* glsl */ `
attribute vec4 uvRect;
attribute float cut;
attribute float skyVis;
varying vec4 vUvRect;
varying float vSkyVis;
uniform float uCutFloor;
uniform float uCutTo;
uniform float uPlayerLevel;
#ifdef LM_WORLD
varying vec3 vLmPos;
#endif
`;
const WORLD_VERT_CUT = /* glsl */ `
#include <begin_vertex>
vUvRect = uvRect;
vSkyVis = skyVis;
// cut: 0 = static, 1 = lowered in cut mode, 2 = lowered in cut mode and otherwise hidden
// (wall caps under a floor slab: only needed when top-down cuts the walls open)
bool inCut = transformed.y > uCutFloor + 0.01 && transformed.y < uCutFloor + 3.0;
if (cut > 999.0) { if (uPlayerLevel >= cut - 1000.0) transformed = vec3(0.0); }
else if (cut > 1.5 && !inCut) transformed = vec3(0.0);
else if (cut > 0.5 && inCut) transformed.y = min(transformed.y, uCutTo);
#ifdef LM_WORLD
// half a tile along the normal: a face reads the light of the space it faces
vLmPos = (modelMatrix * vec4(transformed, 1.0)).xyz + normalize(objectNormal) * 0.45;
#endif
`;
const WORLD_FRAG_PARS = 'varying vec4 vUvRect;\nvarying float vSkyVis;\n#define SKYVIS vSkyVis\nuniform float uBump;\nvec2 gBump = vec2(0.0);\n';
// Mip level is chosen from the *unwrapped* UV derivatives: fract() makes hardware LOD
// selection spike at every tile seam (1px lines), and without mips distant floors turn
// into moire. Clamped to a few levels so atlas neighbours (1px extrusion) barely bleed.
const WORLD_MAP = /* glsl */ `
#ifdef USE_MAP
  vec2 texel = vMapUv * vUvRect.zw * vec2(textureSize(map, 0));
  vec2 ddx = dFdx(texel), ddy = dFdy(texel);
  float lod = clamp(0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))) - 0.35, 0.0, 3.0);
  vec2 tileUv = clamp(fract(vMapUv), 0.0005, 0.9995);
  vec2 atlasUv = vUvRect.xy + tileUv * vUvRect.zw;
  vec4 sampledDiffuseColor = textureLod( map, atlasUv, lod );
  // Coverage comes from the full-resolution texel: a mip texel at a tile's edge averages in
  // the transparent gutter around the frame, and the alpha test then punched dotted holes
  // along every floor/ceiling seam (the sky showed through on real GPUs). Undo the darkening
  // those transparent (black) neighbours add to the colour for the same reason.
  sampledDiffuseColor.rgb = min(sampledDiffuseColor.rgb / max(sampledDiffuseColor.a, 0.02), vec3(1.0));
  sampledDiffuseColor.a = textureLod( map, atlasUv, 0.0 ).a;
  diffuseColor *= sampledDiffuseColor;
  if (uBump > 0.0 && lod < 1.5) {
    // Pixel bump: treat each texel's luminance as height (mortar and board gaps are dark,
    // so they recess). One texel steps in tile space, wrapped like the colour lookup.
    vec2 ts = 1.0 / (vUvRect.zw * vec2(textureSize(map, 0)));
    vec3 LW = vec3(0.3, 0.59, 0.11);
    float lL = dot(textureLod(map, vUvRect.xy + clamp(fract(tileUv - vec2(ts.x, 0.0)), 0.0005, 0.9995) * vUvRect.zw, 0.0).rgb, LW);
    float lR = dot(textureLod(map, vUvRect.xy + clamp(fract(tileUv + vec2(ts.x, 0.0)), 0.0005, 0.9995) * vUvRect.zw, 0.0).rgb, LW);
    float lD = dot(textureLod(map, vUvRect.xy + clamp(fract(tileUv - vec2(0.0, ts.y)), 0.0005, 0.9995) * vUvRect.zw, 0.0).rgb, LW);
    float lU = dot(textureLod(map, vUvRect.xy + clamp(fract(tileUv + vec2(0.0, ts.y)), 0.0005, 0.9995) * vUvRect.zw, 0.0).rgb, LW);
    // relative to the local brightness so dark and light materials bump alike
    float lc = max(dot(sampledDiffuseColor.rgb, LW), 0.04);
    gBump = vec2(lR - lL, lU - lD) / (lc + 0.15) * uBump * (1.0 - smoothstep(0.5, 1.5, lod)) * 0.35;
  }
#endif
`;
// Applied after three's normal setup: tilt the face normal along the bump gradient using a
// cotangent frame from screen derivatives (works for every face orientation and rotated
// floor frames without tangent attributes). Derivatives are taken unconditionally.
const WORLD_BUMP = /* glsl */ `
#include <normal_fragment_maps>
{
  vec3 dpx = dFdx(-vViewPosition), dpy = dFdy(-vViewPosition);
  vec2 dux = dFdx(vMapUv), duy = dFdy(vMapUv);
  vec3 dp2perp = cross(dpy, normal), dp1perp = cross(normal, dpx);
  vec3 bT = dp2perp * dux.x + dp1perp * duy.x;
  vec3 bB = dp2perp * dux.y + dp1perp * duy.y;
  float bim = inversesqrt(max(max(dot(bT, bT), dot(bB, bB)), 1e-12));
  if (dot(gBump, gBump) > 0.0) normal = normalize(normal - (bT * gBump.x + bB * gBump.y) * bim);
}
`;

/** World pages get nearest-mipmap filtering (see WORLD_MAP). Idempotent. */
function enableMips(t: THREE.Texture): void {
  if (t.minFilter === THREE.NearestMipmapNearestFilter) return;
  t.generateMipmaps = true;
  t.minFilter = THREE.NearestMipmapNearestFilter;
  t.needsUpdate = true;
}

function patchWorldVertex(shader: Shader, lm = false): void {
  shader.uniforms.uCutFloor = shared.uCutFloor;
  shader.uniforms.uCutTo = shared.uCutTo;
  shader.vertexShader = (lm ? '#define LM_WORLD\n' : '') + WORLD_VERT_PARS + shader.vertexShader.replace('#include <begin_vertex>', WORLD_VERT_CUT);
  shader.uniforms.uBump = shared.uBump;
  shader.uniforms.uPlayerLevel = shared.uPlayerLevel;
  shader.fragmentShader = WORLD_FRAG_PARS + shader.fragmentShader.replace('#include <map_fragment>', WORLD_MAP);
  if (shader.fragmentShader.includes('#include <normal_fragment_maps>')) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', WORLD_BUMP);
}

const worldCache = new Map<THREE.Texture, { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial }>();

/** Material for merged chunk geometry textured from one atlas page. Cached per page. */
export function worldMaterials(page: THREE.Texture): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  let m = worldCache.get(page);
  if (m) return m;
  enableMips(page);
  const mat = new THREE.MeshLambertMaterial({ map: page, vertexColors: true, alphaTest: 0.5, side: THREE.FrontSide });
  mat.onBeforeCompile = (shader) => {
    patchWorldVertex(shader, true);
    patchBandedLambert(shader, 'world');
    addNormalOutput(shader, true, 1);
  };
  mat.customProgramCacheKey = () => 'cdda-world';
  (mat.userData as any).mrt = true;
  // Shadow casters need the same atlas-rect alpha test (tree canopies) and wall cut.
  const depth = new THREE.MeshDepthMaterial({ map: page, alphaTest: 0.5, depthPacking: THREE.RGBADepthPacking });
  depth.onBeforeCompile = (shader) => patchWorldVertex(shader);
  depth.customProgramCacheKey = () => 'cdda-world-depth';
  m = { mat, depth };
  worldCache.set(page, m);
  return m;
}

// --- sprite (billboard) material -----------------------------------------------------

const SPRITE_VERT_PARS = /* glsl */ `
attribute vec4 instRect;   // atlas rect u0 v0 du dv
attribute vec4 instSize;   // width m, height m, vertical offset m, sky visibility
attribute vec4 instFlash;  // rgb + strength
attribute vec4 instExtra;  // opacity, fade-when-near flag
varying vec4 vInstRect;
varying vec4 vFlash;
varying float vSkyVis;
varying float vOpacity;
varying vec4 vLmS;
uniform float uSpriteTilt;
`;
// Cylindrical billboard: the quad's right axis is the camera's right projected onto the
// ground plane; the up axis is world up, optionally tilted toward camera-up in top-down so
// sprites don't foreshorten to slivers. The instance matrix holds translation only.
const SPRITE_BEGIN_NORMAL = /* glsl */ `
vec3 camToward = vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
vec3 objectNormal = normalize(vec3(camToward.x, 0.0, camToward.z) + vec3(0.0, 0.8, 0.0));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif
`;
const SPRITE_BEGIN = /* glsl */ `
vec3 camRight = vec3(viewMatrix[0][0], 0.0, viewMatrix[2][0]);
camRight = normalize(camRight + vec3(1e-5, 0.0, 0.0));
vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
vec3 upAxis = normalize(mix(vec3(0.0, 1.0, 0.0), camUp, uSpriteTilt));
vec3 transformed = camRight * position.x * instSize.x + upAxis * (position.y * instSize.y + instSize.z);
vInstRect = instRect;
vFlash = instFlash;
vSkyVis = instSize.w;
vOpacity = instExtra.x;
// trees etc. dissolve as the camera walks into them instead of filling the view with
// a few giant texels
if (instExtra.y > 0.5) vOpacity *= smoothstep(0.9, 2.4, length(instanceMatrix[3].xz - cameraPosition.xz));
// one light-map sample per sprite, at its foot + chest height (instance matrix = translation)
vLmS = lmSample(instanceMatrix[3].xyz + vec3(0.0, 0.6, 0.0));
// ground-level lamp/fire light fades up tall sprites (tree canopies over a campfire)
vLmS.rgb *= clamp(1.0 - (transformed.y - 1.8) / 3.0, 0.3, 1.0);
`;
const SPRITE_FRAG_PARS = /* glsl */ `
varying vec4 vInstRect;
varying vec4 vFlash;
varying float vSkyVis;
varying float vOpacity;
#define SKYVIS vSkyVis
uniform float uSpriteRound;
vec2 gSprN = vec2(0.0);
float spriteBayer(vec2 p) {
  ivec2 i = ivec2(mod(p, 4.0));
  int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
  return (float(m[i.x + i.y * 4]) + 0.5) / 16.0;
}
`;
const SPRITE_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vInstRect.xy + clamp(vMapUv, 0.001, 0.999) * vInstRect.zw );
  diffuseColor *= sampledDiffuseColor;
  if (uSpriteRound > 0.0) {
    // Inflate the silhouette: alpha differences at 2 and 5 texels tilt the normal outward
    // near the edges, so a flat billboard shades like a rounded volume (sun side, rim).
    vec2 d = 1.0 / (vInstRect.zw * vec2(textureSize(map, 0)));
    vec2 u0 = clamp(vMapUv, 0.001, 0.999);
    #define SA(o) texture2D(map, vInstRect.xy + clamp(u0 + (o) * d, 0.001, 0.999) * vInstRect.zw).a
    vec2 g = vec2(SA(vec2(-2.0, 0.0)) - SA(vec2(2.0, 0.0)), SA(vec2(0.0, -2.0)) - SA(vec2(0.0, 2.0)))
           + vec2(SA(vec2(-5.0, 0.0)) - SA(vec2(5.0, 0.0)), SA(vec2(0.0, -5.0)) - SA(vec2(0.0, 5.0))) * 0.6;
    #undef SA
    gSprN = g * uSpriteRound * 0.8;
  }
#endif
diffuseColor.rgb = mix(diffuseColor.rgb, vFlash.rgb, vFlash.a);
// screen-door transparency on the low-res pixel grid (stays crisp; no sorting needed)
if (vOpacity < 0.999 && spriteBayer(gl_FragCoord.xy) >= vOpacity) discard;
`;

const spriteCache = new Map<THREE.Texture, THREE.MeshLambertMaterial>();

export function spriteMaterial(page: THREE.Texture): THREE.MeshLambertMaterial {
  let m = spriteCache.get(page);
  if (m) return m;
  m = new THREE.MeshLambertMaterial({ map: page, alphaTest: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSpriteTilt = shared.uSpriteTilt;
    shader.vertexShader = LM_FUNCS + SPRITE_VERT_PARS + shader.vertexShader
      .replace('#include <beginnormal_vertex>', SPRITE_BEGIN_NORMAL)
      .replace('#include <begin_vertex>', SPRITE_BEGIN);
    shader.uniforms.uSpriteRound = shared.uSpriteRound;
    shader.fragmentShader = SPRITE_FRAG_PARS + shader.fragmentShader
      .replace('#include <map_fragment>', SPRITE_MAP)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\nif (dot(gSprN, gSprN) > 0.0) normal = normalize(normal + vec3(gSprN.x, 0.0, 0.0) + (viewMatrix * vec4(0.0, gSprN.y, 0.0, 0.0)).xyz);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vFlash.rgb * vFlash.a * 0.8;');
    patchBandedLambert(shader, 'sprite');
    addNormalOutput(shader, true, 1);
  };
  m.customProgramCacheKey = () => 'cdda-sprite';
  (m.userData as any).mrt = true;
  spriteCache.set(page, m);
  return m;
}

// --- generic patching for materials other systems add ---------------------------------

/**
 * Make an arbitrary material safe to render into the MRT scene target. Lambert/Phong/
 * Standard get banded lighting too; everything else just writes a flat normal with
 * outlines disabled. Idempotent.
 */
export function patchNormalOutput(mat: THREE.Material, outline = true): void {
  const ud = mat.userData as any;
  if (ud.mrt) return;
  ud.mrt = true;
  if ((mat as THREE.ShaderMaterial).isShaderMaterial) {
    // ShaderMaterials own their source; they must declare gNormal themselves.
    const sm = mat as THREE.ShaderMaterial;
    if (!/gNormal/.test(sm.fragmentShader)) {
      sm.fragmentShader = NORMAL_OUT_DECL + sm.fragmentShader.replace(/}\s*$/, `  ${normalOutputChunk(false, 0)}\n}`);
      sm.needsUpdate = true;
    }
    return;
  }
  const lit = (mat as any).isMeshLambertMaterial || (mat as any).isMeshPhongMaterial || (mat as any).isMeshStandardMaterial;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prev?.call(mat, shader, r);
    if ((mat as any).isMeshLambertMaterial) patchBandedLambert(shader);
    addNormalOutput(shader, !!lit, lit && outline ? 1 : 0);
  };
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.customProgramCacheKey = () => prevKey() + '|mrt';
  mat.needsUpdate = true;
}

// --- instanced lit geometry (look.ts grass cards, tree leaf clumps) --------------------

export interface InstancedLitOptions {
  /** program cache key */
  key: string;
  /** GLSL declarations for the vertex shader (attributes, uniforms) */
  pars?: string;
  /** replaces three's beginnormal_vertex (must declare `vec3 objectNormal`) */
  normal?: string;
  /** GLSL run after begin_vertex: may change `transformed` (object space, pre-instance) */
  vertex?: string;
  /** light-map sample height above the instance origin (m) */
  lmLift?: number;
  uniforms?: Record<string, THREE.IUniform>;
  /** outline flag written to the normal target (1 = outlined, 0 = not) */
  outline?: number;
  /** GLSL declarations / code for the fragment shader (after map_fragment) */
  fragPars?: string;
  frag?: string;
}

/**
 * Banded-Lambert material for instanced world geometry: lit by the light map at the
 * instance origin (+ lmLift) like a sprite, sun/moon/hemisphere like the world, MRT normal
 * output. Also returns a matching depth material for shadow casting.
 */
export function instancedLitMaterial(params: THREE.MeshLambertMaterialParameters, o: InstancedLitOptions): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  const vert = (shader: Shader, lm: boolean) => {
    Object.assign(shader.uniforms, o.uniforms ?? {});
    shader.uniforms.uTime = shared.uTime;
    let v = (lm ? '#define LM_WORLD\nvarying vec3 vLmPos;\n' : '') + 'uniform float uTime;\n' + (o.pars ?? '') + shader.vertexShader;
    if (o.normal && v.includes('#include <beginnormal_vertex>')) v = v.replace('#include <beginnormal_vertex>', o.normal);
    const lmCode = lm ? `\nvLmPos = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz + vec3(0.0, ${(o.lmLift ?? 0.4).toFixed(2)}, 0.0);` : '';
    v = v.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (o.vertex ?? '') + lmCode);
    shader.vertexShader = v;
    if (o.fragPars || o.frag) {
      // after emissivemap_fragment: diffuseColor and totalEmissiveRadiance both exist there
      shader.fragmentShader = (o.fragPars ?? '') + shader.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n' + (o.frag ?? ''));
    }
  };
  const mat = new THREE.MeshLambertMaterial(params);
  mat.onBeforeCompile = (shader) => {
    vert(shader, true);
    patchBandedLambert(shader, 'world');
    addNormalOutput(shader, true, o.outline ?? 1);
  };
  mat.customProgramCacheKey = () => `cdda-inst-${o.key}`;
  (mat.userData as { mrt?: boolean }).mrt = true;
  const depth = new THREE.MeshDepthMaterial({ map: params.map ?? null, alphaTest: params.alphaTest ?? 0, depthPacking: THREE.RGBADepthPacking, side: params.side ?? THREE.FrontSide });
  depth.onBeforeCompile = (shader) => vert(shader, false);
  depth.customProgramCacheKey = () => `cdda-inst-depth-${o.key}`;
  return { mat, depth };
}
