import * as THREE from 'three';

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

/** Uniforms shared by reference across all patched materials (update .value only). */
export const shared = {
  uBands: { value: 5.0 },
  uCutFloor: { value: -1e6 }, // only vertices above this Y are affected (current level)
  uCutTo: { value: 1e6 }, // clamp height
  uSpriteTilt: { value: 0.0 }, // 0 = upright cylindrical billboards, 1 = face camera fully
  uTime: { value: 0 },
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

// Ambient (hemisphere) light scaled by SKYVIS: interiors under a roof get a fraction of
// the sky's light, so a house at night is darker than the moonlit street outside.
const INDIRECT = /* glsl */ `
#ifndef SKYVIS
#define SKYVIS 1.0
#endif
void RE_IndirectDiffuse_Lambert( const in vec3 irradiance, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in LambertMaterial material, inout ReflectedLight reflectedLight ) {
  reflectedLight.indirectDiffuse += irradiance * SKYVIS * BRDF_Lambert( material.diffuseColor );
}`;

function patchBandedLambert(shader: Shader): void {
  shader.uniforms.uBands = shared.uBands;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_lambert_pars_fragment>',
    THREE.ShaderChunk.lights_lambert_pars_fragment
      .replace(/void RE_Direct_Lambert[\s\S]*?\n}\n/, BANDED_DIRECT + '\n')
      .replace(/void RE_IndirectDiffuse_Lambert[\s\S]*?\n}\n/, INDIRECT + '\n'),
  );
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
`;
const WORLD_VERT_CUT = /* glsl */ `
#include <begin_vertex>
vUvRect = uvRect;
vSkyVis = skyVis;
// cut: 0 = static, 1 = lowered in cut mode, 2 = lowered in cut mode and otherwise hidden
// (wall caps under a floor slab: only needed when top-down cuts the walls open)
bool inCut = transformed.y > uCutFloor + 0.01 && transformed.y < uCutFloor + 3.0;
if (cut > 1.5 && !inCut) transformed = vec3(0.0);
else if (cut > 0.5 && inCut) transformed.y = min(transformed.y, uCutTo);
`;
const WORLD_FRAG_PARS = 'varying vec4 vUvRect;\nvarying float vSkyVis;\n#define SKYVIS vSkyVis\n';
// Mip level is chosen from the *unwrapped* UV derivatives: fract() makes hardware LOD
// selection spike at every tile seam (1px lines), and without mips distant floors turn
// into moire. Clamped to a few levels so atlas neighbours (1px extrusion) barely bleed.
const WORLD_MAP = /* glsl */ `
#ifdef USE_MAP
  vec2 texel = vMapUv * vUvRect.zw * vec2(textureSize(map, 0));
  vec2 ddx = dFdx(texel), ddy = dFdy(texel);
  float lod = clamp(0.5 * log2(max(dot(ddx, ddx), dot(ddy, ddy))) - 0.35, 0.0, 3.0);
  vec2 tileUv = clamp(fract(vMapUv), 0.0005, 0.9995);
  vec4 sampledDiffuseColor = textureLod( map, vUvRect.xy + tileUv * vUvRect.zw, lod );
  diffuseColor *= sampledDiffuseColor;
#endif
`;

/** World pages get nearest-mipmap filtering (see WORLD_MAP). Idempotent. */
function enableMips(t: THREE.Texture): void {
  if (t.minFilter === THREE.NearestMipmapNearestFilter) return;
  t.generateMipmaps = true;
  t.minFilter = THREE.NearestMipmapNearestFilter;
  t.needsUpdate = true;
}

function patchWorldVertex(shader: Shader): void {
  shader.uniforms.uCutFloor = shared.uCutFloor;
  shader.uniforms.uCutTo = shared.uCutTo;
  shader.vertexShader = WORLD_VERT_PARS + shader.vertexShader.replace('#include <begin_vertex>', WORLD_VERT_CUT);
  shader.fragmentShader = WORLD_FRAG_PARS + shader.fragmentShader.replace('#include <map_fragment>', WORLD_MAP);
}

const worldCache = new Map<THREE.Texture, { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial }>();

/** Material for merged chunk geometry textured from one atlas page. Cached per page. */
export function worldMaterials(page: THREE.Texture): { mat: THREE.MeshLambertMaterial; depth: THREE.MeshDepthMaterial } {
  let m = worldCache.get(page);
  if (m) return m;
  enableMips(page);
  const mat = new THREE.MeshLambertMaterial({ map: page, vertexColors: true, alphaTest: 0.5, side: THREE.FrontSide });
  mat.onBeforeCompile = (shader) => {
    patchWorldVertex(shader);
    patchBandedLambert(shader);
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
varying vec4 vInstRect;
varying vec4 vFlash;
varying float vSkyVis;
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
`;
const SPRITE_FRAG_PARS = 'varying vec4 vInstRect;\nvarying vec4 vFlash;\nvarying float vSkyVis;\n#define SKYVIS vSkyVis\n';
const SPRITE_MAP = /* glsl */ `
#ifdef USE_MAP
  vec4 sampledDiffuseColor = texture2D( map, vInstRect.xy + clamp(vMapUv, 0.001, 0.999) * vInstRect.zw );
  diffuseColor *= sampledDiffuseColor;
#endif
diffuseColor.rgb = mix(diffuseColor.rgb, vFlash.rgb, vFlash.a);
`;

const spriteCache = new Map<THREE.Texture, THREE.MeshLambertMaterial>();

export function spriteMaterial(page: THREE.Texture): THREE.MeshLambertMaterial {
  let m = spriteCache.get(page);
  if (m) return m;
  m = new THREE.MeshLambertMaterial({ map: page, alphaTest: 0.5, side: THREE.DoubleSide });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSpriteTilt = shared.uSpriteTilt;
    shader.vertexShader = SPRITE_VERT_PARS + shader.vertexShader
      .replace('#include <beginnormal_vertex>', SPRITE_BEGIN_NORMAL)
      .replace('#include <begin_vertex>', SPRITE_BEGIN);
    shader.fragmentShader = SPRITE_FRAG_PARS + shader.fragmentShader
      .replace('#include <map_fragment>', SPRITE_MAP)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vFlash.rgb * vFlash.a * 0.8;');
    patchBandedLambert(shader);
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
