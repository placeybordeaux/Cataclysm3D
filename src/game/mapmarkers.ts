// Map markers any system can contribute, for the overmap / minimap / compass to draw
// (UI-free). A provider returns the markers it wants shown *now*; readers call mapMarkers()
// whenever they redraw, so there is nothing to keep in sync.
//
//   import { mapMarkerProviders } from '../game/mapmarkers';
//   mapMarkerProviders.push(() => [{ id: 'mission:3', kind: 'mission', omx: 12, omy: -4, z: 0, label: 'Find the Sheriff' }]);
//
// Missions register theirs in src/screens/install.ts (targets of active missions; the one the
// player tracks has `tracked: true`).

export interface MapMarker {
  /** Stable per marker ("mission:<uid>"), so a map can remember what was clicked. */
  id: string;
  kind: 'mission' | 'npc' | 'vehicle' | 'note';
  /** Overmap tile (OMT = 24×24 tiles). */
  omx: number;
  omy: number;
  z: number;
  /** Exact tile when known (a mission's target monster), else the OMT centre is fine. */
  x?: number;
  y?: number;
  label: string;
  detail?: string;
  /** The one the player chose to follow (compass / HUD arrow). */
  tracked?: boolean;
}

export const mapMarkerProviders: (() => MapMarker[])[] = [];

export function mapMarkers(): MapMarker[] {
  const out: MapMarker[] = [];
  for (const p of mapMarkerProviders) out.push(...p());
  return out;
}
