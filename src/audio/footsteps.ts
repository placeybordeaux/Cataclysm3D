// Footstep variant choice, mirroring CDDA sfx::do_footstep (sounds.cpp): water first, then
// barefoot, then an exact terrain-id variant if the pack has one, then material groups,
// else "walk_tarmac".

const GRASS = new Set([
  't_grass', 't_shrub', 't_shrub_peanut', 't_shrub_peanut_harvested', 't_shrub_blueberry', 't_shrub_blueberry_harvested',
  't_shrub_strawberry', 't_shrub_strawberry_harvested', 't_shrub_blackberry', 't_shrub_blackberry_harvested',
  't_shrub_huckleberry', 't_shrub_huckleberry_harvested', 't_shrub_raspberry', 't_shrub_raspberry_harvested',
  't_shrub_grape', 't_shrub_grape_harvested', 't_shrub_rose', 't_shrub_rose_harvested', 't_shrub_hydrangea',
  't_shrub_hydrangea_harvested', 't_shrub_lilac', 't_shrub_lilac_harvested', 't_underbrush', 't_underbrush_harvested',
  't_moss', 't_grass_white', 't_grass_long', 't_grass_tall', 't_grass_dead', 't_grass_golf', 't_golf_hole', 't_trunk', 't_stump',
]);
const DIRT = new Set([
  't_dirt', 't_dirtmound', 't_dirtmoundfloor', 't_sand', 't_clay', 't_dirtfloor', 't_palisade_gate_o', 't_sandbox',
  't_claymound', 't_sandmound', 't_rootcellar', 't_railroad_rubble', 't_railroad_track', 't_railroad_track_h',
  't_railroad_track_v', 't_railroad_track_d', 't_railroad_track_d1', 't_railroad_track_d2', 't_railroad_tie',
  't_railroad_tie_d', 't_railroad_tie_h', 't_railroad_tie_v', 't_railroad_track_on_tie', 't_railroad_track_h_on_tie',
  't_railroad_track_v_on_tie', 't_railroad_track_d_on_tie', 't_railroad_tie_d1', 't_railroad_tie_d2', 't_forestfloor',
]);
const METAL = new Set(['t_ov_smreb_cage', 't_metal_floor', 't_grate', 't_bridge', 't_elevator', 't_guardrail_bg_dp', 't_slide', 't_conveyor']);

export interface FootstepInput {
  terrainId: string;
  terrainFlags: readonly string[];
  barefoot?: boolean;
  /** does the soundset have plmove/<variant> (with default fallback)? */
  hasVariant: (variant: string) => boolean;
}

export function footstepVariant(f: FootstepInput): string {
  if (f.terrainFlags.includes('DEEP_WATER') || f.terrainFlags.includes('SHALLOW_WATER')) return 'walk_water';
  if (f.barefoot) return 'walk_barefoot';
  if (f.hasVariant(f.terrainId)) return f.terrainId;
  if (GRASS.has(f.terrainId)) return 'walk_grass';
  if (DIRT.has(f.terrainId)) return 'walk_dirt';
  if (METAL.has(f.terrainId)) return 'walk_metal';
  if (f.terrainId === 't_chainfence') return 'clear_obstacle';
  return 'walk_tarmac';
}

/** Metres between footfalls; CDDA plays one per tile, which is too busy at 3 tiles/s. */
export function strideLength(running: boolean, crouching: boolean): number {
  return running ? 1.7 : crouching ? 0.8 : 1.15;
}
