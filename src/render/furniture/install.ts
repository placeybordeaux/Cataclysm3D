import type { DebugApi } from '../../debug';
import { registerOption } from '../../ui/options';
import type { Renderer } from '../renderer';
import { FURNITURE_STYLES, furnitureState, modelStats, storeFurnitureStyle, type FurnitureStyle } from './index';
import type { Game } from '../../game/game';
import { look } from '../look';
import { AtlasTextureSource } from '../atlasSource';
import { SURFACE_STYLES, SurfacePainter, storeSurfaceStyle, surfaceState, type SurfaceStyle } from '../surfaces';
import { Dresser, buildingState } from '../dressing';

// Options > Furniture and the automation hooks for the furniture style (docs/FURNITURE.md):
//   cdda.setFurnitureStyle('voxel')   switch live (not persisted; Options persists)
//   cdda.furnitureStats                models built / placed, quads, atlas pages

const LABEL: Record<FurnitureStyle, string> = { model: 'Modelled', voxel: 'Voxel' };

export function installFurniture(renderer: Renderer, api: DebugApi): void {
  const set = (s: FurnitureStyle, persist: boolean) => {
    if (!FURNITURE_STYLES.includes(s)) throw new Error(`unknown furniture style ${s}: ${FURNITURE_STYLES.join('|')}`);
    furnitureState.style = s;
    if (persist) storeFurnitureStyle(s);
    renderer.chunks.invalidateAll();
  };
  registerOption({
    name: 'Furniture',
    value: () => LABEL[furnitureState.style],
    change: (d) => {
      const i = FURNITURE_STYLES.indexOf(furnitureState.style);
      set(FURNITURE_STYLES[(i + d + FURNITURE_STYLES.length) % FURNITURE_STYLES.length], true);
    },
    desc: 'Modelled: furniture, fixtures, doors, windows and dropped items are low-poly models with pixel textures.\nVoxel: the older look, tileset sprites inflated into voxel volumes. (Needs a look with volumes: Full or Voxel.)',
  });
  const a = api as DebugApi & Record<string, unknown>;
  a.setFurnitureStyle = (s: string) => {
    set(s as FurnitureStyle, false);
    return s;
  };
  a.furnitureStats = () => ({ ...modelStats, style: furnitureState.style, atlasPages: renderer.models.atlas.pageCount, frames: renderer.models.atlas.frameCount, texels: renderer.models.atlas.texels });
}

const SLABEL: Record<SurfaceStyle, string> = { painted: 'Painted', sprite: 'Tileset' };

/**
 * Painted architectural surfaces (surfaces.ts): walls, floors, ceilings, roofs, trim.
 *   cdda.setSurfaceStyle('sprite')   switch live (not persisted; Options > Surfaces persists)
 * Active in the looks with architectural detail (voxel, full), like the models.
 */
export function installSurfaces(renderer: Renderer, api: DebugApi, game: Game): void {
  // shares the furniture atlas pages: no extra draw call per chunk
  const painter = new SurfacePainter(game.data.terrain, renderer.models.atlas);
  const dresser = new Dresser(renderer.models.atlas);
  // set dressing (dressing.ts) rides on painted surfaces; `?dressing=off` / cdda.setDressing(false) for the bare rooms
  const dq = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('dressing') : null;
  if (dq && dq !== 'on' && dq !== 'off') throw new Error(`?dressing must be on|off, got ${dq}`);
  const dressState = { on: dq !== 'off' };
  /** Building state of the chunk at OMT (cx, cy): 0 kept, 1 dirty, 2 wrecked (dressing.ts). */
  (api as DebugApi & Record<string, unknown>).buildingLevel = (cx: number, cy: number) => buildingState((Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) >>> 0).level;
  (api as DebugApi & Record<string, unknown>).setDressing = (on: boolean) => {
    dressState.on = !!on;
    renderer.chunks.invalidateAll();
    return dressState.on;
  };
  const sync = () => {
    surfaceState.enabled = look.f.archDetail;
  };
  sync();
  renderer.lookLayers.push({ name: 'surfaces', apply: sync });
  void renderer.ready.then(() => {
    if (renderer.source instanceof AtlasTextureSource) renderer.source.surfaces = painter;
    renderer.chunks.invalidateAll();
  });
  // the mesher's per-look inputs: interior finishes/trim, and painted shingles on roofs
  const prev = renderer.chunks.extras;
  renderer.chunks.extras = (near) => {
    const e = prev?.(near);
    if (!e || !painter.active()) return e;
    return { ...e, surfaces: painter, dressing: dressState.on ? dresser : undefined, arch: e.arch ? { ...e.arch, shingle: painter.shingles() } : e.arch };
  };
  const set = (s: SurfaceStyle, persist: boolean) => {
    if (!SURFACE_STYLES.includes(s)) throw new Error(`unknown surface style ${s}: ${SURFACE_STYLES.join('|')}`);
    surfaceState.style = s;
    if (persist) storeSurfaceStyle(s);
    renderer.chunks.invalidateAll();
  };
  registerOption({
    name: 'Surfaces',
    value: () => SLABEL[surfaceState.style],
    change: (d) => {
      const i = SURFACE_STYLES.indexOf(surfaceState.style);
      set(SURFACE_STYLES[(i + d + SURFACE_STYLES.length) % SURFACE_STYLES.length], true);
    },
    desc: 'Painted: walls, floors, ceilings and roofs painted at 32 texels/m in real-world scale (brick courses, boards, tiles), interior finishes, baseboards.\nTileset: the older look, UltiCa sprites stretched over walls and floors. (Needs Full or Voxel.)',
  });
  (api as DebugApi & Record<string, unknown>).setSurfaceStyle = (s: string) => {
    set(s as SurfaceStyle, false);
    return s;
  };
}
