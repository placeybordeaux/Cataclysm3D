import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { Atlas } from '../render/atlas';
import type { WorldGenerator } from '../world/worldgen';
import type { OterDef } from '../world/worldgen_data';
import { CHUNK } from '../world/coords';
import type { MoodFace, NameLists } from './format';
import { DATA_BASE } from '../core/assets';

// Everything the screens need, gathered once in installUi (src/ui/index.ts).

/** public/data/ui.json (tools/extract/ui.ts). */
export interface UiData {
  title: string[];
  tombstone: { picture: string[]; added_info: [[number, number], string][]; last_words_label?: string };
  names: NameLists;
  help: { name: string; messages: string[] }[];
  moodFaces: MoodFace[];
  /** CDDA "tip" snippets (data/core/tips.json): tip of the day / hints popup. */
  tips?: string[];
}

export interface UiContext {
  game: Game;
  renderer: Renderer;
  worldgen: WorldGenerator | null;
  data: UiData;
  /** Display names chosen at character creation (for the '@' sheet and memorial). */
  build?: { scenario: string; profession: string };
}

export async function loadUiData(base = DATA_BASE): Promise<UiData> {
  const res = await fetch(base + 'ui.json');
  if (!res.ok) throw new Error(`Failed to load ${base}ui.json: HTTP ${res.status} (run \`npm run extract:ui\`)`);
  return res.json();
}

/** The UltiCa atlas, if the renderer is using it (procedural fallback has no sprites). */
export function atlasOf(renderer: Renderer): Atlas | null {
  // AtlasTextureSource keeps the atlas private; reading it avoids loading the atlas twice.
  return ((renderer.source as unknown as { atlas?: Atlas }).atlas) ?? null;
}

/** <img> tag for an item/monster/terrain id's sprite, or '' when there is none. */
export function spriteImg(renderer: Renderer, id: string, cls = 'icon'): string {
  const a = atlasOf(renderer);
  const url = a?.spriteDataURL(id);
  return url ? `<img class="${cls}" src="${url}" alt="">` : '';
}

export interface OmtLabel {
  id: string;
  name: string;
  sym: string;
  color: string;
  city?: string;
}

/** Overmap terrain under a tile position (null without a world generator, e.g. gen=test). */
export function omtLabel(ctx: UiContext, omx: number, omy: number, z: number): OmtLabel | null {
  const wg = ctx.worldgen;
  if (!wg) return null;
  const o = wg.overmap.omtAt(omx, omy, z);
  const def: OterDef | undefined = wg.wg.overmap.terrains[o.type];
  return { id: o.id, name: def?.name ?? o.type, sym: def?.sym ?? '?', color: def?.color ?? 'light_gray', city: o.special?.city?.name };
}

export function playerOmt(ctx: UiContext): { x: number; y: number; z: number } {
  const p = ctx.game.player;
  return { x: Math.floor(p.x / CHUNK), y: Math.floor(p.y / CHUNK), z: p.z };
}
