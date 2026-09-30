import type { DebugApi } from '../../debug';
import { registerOption } from '../../ui/options';
import type { Renderer } from '../renderer';
import { FURNITURE_STYLES, furnitureState, modelStats, storeFurnitureStyle, type FurnitureStyle } from './index';

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
