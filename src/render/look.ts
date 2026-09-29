// Visual styles ("looks"): switchable bundles of rendering features, so the same world can
// be seen as the original flat, chunky pixel style or with progressively more depth.
//
//   classic  the v1 look: ~360 px, sprites as billboards, flat ground
//   crisp    rendering quality without new assets: ~540-720 px (integer upscale), SSAO,
//            softer/larger shadows, pixel bump from texture luminance, rounded sprite
//            normals, rim + fill light, atmospheric perspective, bloom, lighter dither
//   voxel    sprites become volumes (extruded furniture/items, 3D trees built from their
//            sprite), architectural detail (window/door frames, sills, plinths, fences,
//            curbs, pitched roofs with eaves)
//   terrain  the ground stops being a table top: relief outside buildings, ditches, dense
//            grass cards, rocks/litter/puddles, macro colour variation, a distant skyline
//   full     crisp + voxel + terrain
//
// Selected by `?look=<name>` or Options > Visual style (persisted); `renderer.setLook(name)`
// applies it live. Geometry-producing features (voxel, terrain) rebuild the chunk meshes.
// The current look is a module-level singleton because the chunk mesher, sprite layer and
// materials all consult it and are otherwise free of renderer references.

export type LookName = 'classic' | 'crisp' | 'voxel' | 'terrain' | 'full';
export const LOOK_NAMES: LookName[] = ['classic', 'crisp', 'voxel', 'terrain', 'full'];

export interface LookFeatures {
  label: string;
  desc: string;
  // --- A: image quality -------------------------------------------------------------
  /** Pick the integer upscale that gives a ~540-720 px tall image instead of ~360. */
  autoRes: boolean;
  /** Ordered-dither amplitude (sRGB units). */
  dither: number;
  /** Screen-space ambient occlusion strength (0 = off). */
  ssao: number;
  /** Bloom around bright lights (0 = off). */
  bloom: number;
  /** Aerial perspective: distant things fade toward the horizon colour (0 = off). */
  atmosphere: number;
  /** Sky rim light on silhouettes (0 = off). */
  rim: number;
  /** Fill light opposite the sun, as a share of the sky light (0 = off). */
  fill: number;
  /** Per-texel bump from texture luminance on walls/floors (0 = off). */
  bump: number;
  /** Rounded (inflated) normals on billboards so creatures/props shade like volumes. */
  spriteRound: number;
  /** Sun shadow map size and half-extent (m); PCF gives a stepped penumbra after banding. */
  shadowSize: number;
  shadowExtent: number;
  softShadows: boolean;
  // --- B: volumes -------------------------------------------------------------------
  /** Furniture and ground items as extruded voxel volumes instead of billboards. */
  voxelProps: boolean;
  /** Trees and shrubs as trunk + leaf-clump volumes built from their sprite. */
  trees3d: boolean;
  /** Window/door frames, sills, plinths, cornices, fence geometry, curbs, roofs. */
  archDetail: boolean;
  // --- C: ground --------------------------------------------------------------------
  /** Visual micro-relief on natural ground (and road ditches). */
  relief: boolean;
  /** Dense 3D grass cards near the player (replaces the billboard tufts). */
  grass: boolean;
  /** Rocks, twigs, litter and puddles scattered by the mesher. */
  props: boolean;
  /** Large-scale colour variation on outdoor ground (breaks tiling). */
  macroTint: boolean;
  /** Low-poly silhouettes of towns/forests beyond the draw distance. */
  skyline: boolean;
}

const CLASSIC: LookFeatures = {
  label: 'Classic', desc: 'The original look: chunky ~360 px image, flat billboards, flat ground.',
  autoRes: false, dither: 0.035, ssao: 0, bloom: 0, atmosphere: 0, rim: 0, fill: 0, bump: 0, spriteRound: 0,
  shadowSize: 768, shadowExtent: 30, softShadows: false,
  voxelProps: false, trees3d: false, archDetail: false,
  relief: false, grass: false, props: false, macroTint: false, skyline: false,
};

const CRISP_A: Partial<LookFeatures> = {
  autoRes: true, dither: 0.018, ssao: 0.85, bloom: 0.55, atmosphere: 0.6, rim: 0.5, fill: 0.35, bump: 0.9, spriteRound: 0.9,
  shadowSize: 2048, shadowExtent: 40, softShadows: true,
};
const VOXEL_B: Partial<LookFeatures> = { voxelProps: true, trees3d: true, archDetail: true };
const TERRAIN_C: Partial<LookFeatures> = { relief: true, grass: true, props: true, macroTint: true, skyline: true };

export const LOOKS: Record<LookName, LookFeatures> = {
  classic: CLASSIC,
  crisp: { ...CLASSIC, ...CRISP_A, label: 'Crisp', desc: 'Sharper image and richer light: higher resolution, ambient occlusion, soft shadows, bump-mapped pixels, rim light, haze, bloom.' },
  voxel: { ...CLASSIC, ...VOXEL_B, label: 'Voxel', desc: 'Sprites become volumes: extruded furniture and items, 3D trees, window and door frames, curbs, fences and pitched roofs.' },
  terrain: { ...CLASSIC, ...TERRAIN_C, label: 'Terrain', desc: 'Living ground: gentle relief and ditches, dense grass, rocks, litter and puddles, a skyline on the horizon.' },
  full: { ...CLASSIC, ...CRISP_A, ...VOXEL_B, ...TERRAIN_C, label: 'Full', desc: 'Everything: the crisp image, volumetric props and trees, architectural detail and living terrain.' },
};

export const DEFAULT_LOOK: LookName = 'full';
const STORAGE_KEY = 'cdda3d.look';

/** The active look. Read-only for everyone but Renderer.setLook. */
export const look: { name: LookName; f: LookFeatures; version: number } = { name: DEFAULT_LOOK, f: { ...LOOKS[DEFAULT_LOOK] }, version: 0 };

export function isLookName(s: string | null | undefined): s is LookName {
  return !!s && (LOOK_NAMES as string[]).includes(s);
}

/** URL `look=` wins, then the stored choice, then the default. Unknown names fail loudly. */
export function initialLook(): LookName {
  const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
  const p = params.get('look');
  if (p !== null) {
    if (!isLookName(p)) throw new Error(`unknown look "${p}" (expected ${LOOK_NAMES.join('|')})`);
    return p;
  }
  try {
    const s = localStorage.getItem(STORAGE_KEY);
    if (isLookName(s)) return s;
  } catch {
    // storage blocked: default
  }
  return DEFAULT_LOOK;
}

export function storeLook(name: LookName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    // private mode: the choice just doesn't persist
  }
}

/** Switch the singleton (Renderer.setLook does the rest). Bumps `version` for caches. */
export function setLookState(name: LookName): void {
  look.name = name;
  look.f = { ...LOOKS[name] };
  look.version++;
}
