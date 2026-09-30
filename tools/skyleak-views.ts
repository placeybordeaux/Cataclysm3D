// Viewpoints for tools/skyleak.ts: inside and on top of tall and deep buildings, where a fixed
// window of levels around the player used to leave roofs, floors or the street unbuilt. When the
// user finds another spot where the sky shows through the world, add it here.
//
//   at.tile   exact tile [x, y, z] (from the user's F3 dump / place name; seed must match)
//   at.omt    the nearest overmap tile (z 0) whose id contains this text, then `where`:
//               'inside' a covered, walkable tile on level `z` (default 0), the most enclosed one
//               'roof'   a walkable tile open to the sky on the column's highest walkable level
//   looks     [yaw°, pitch°] pairs (yaw 0 = north, pitch up +)

export interface SkyLeakView {
  name: string;
  seed: number;
  at: { tile: [number, number, number] } | { omt: string; where: 'inside' | 'roof'; z?: number };
  looks: [number, number][];
  /** default 12 (noon: the sun would be in view through a hole) */
  hour?: number;
}

const UP: [number, number][] = [[0, 55], [90, 55], [180, 55], [270, 55], [45, 80]];
const DOWN: [number, number][] = [[0, -35], [90, -35], [180, -35], [270, -35]];

export const SKYLEAK_VIEWS: SkyLeakView[] = [
  // The report: inside the fire station's two-storey engine bay, looking up at the roof (z3)
  { name: 'firestation-bay', seed: 443226190, at: { tile: [942, 1539, 0] }, looks: [...UP, [20, 12]] },
  { name: 'firestation-roof', seed: 443226190, at: { omt: 'urban_32_6', where: 'roof' }, looks: DOWN },
  { name: 'cathedral-inside', seed: 1, at: { omt: 'cathedral', where: 'inside' }, looks: UP },
  { name: 'cathedral-roof', seed: 1, at: { omt: 'cathedral', where: 'roof' }, looks: DOWN },
  { name: 'apartments-top-inside', seed: 1, at: { omt: 'apartment', where: 'inside', z: 2 }, looks: UP },
  { name: 'apartments-roof', seed: 1, at: { omt: 'apartment', where: 'roof' }, looks: DOWN },
  { name: 'office-tower-inside', seed: 1, at: { omt: 'office_tower', where: 'inside', z: 1 }, looks: UP },
  { name: 'office-tower-roof', seed: 1, at: { omt: 'office_tower', where: 'roof' }, looks: DOWN },
  { name: 'parking-garage-inside', seed: 1, at: { omt: 'parking_garage', where: 'inside' }, looks: UP },
  // (BN has no water tower OMT; the hotel tower is the tallest common building: roof at z4)
  { name: 'hotel-tower-top-floor', seed: 1, at: { omt: 'hotel_tower', where: 'inside', z: 3 }, looks: UP },
  { name: 'hotel-tower-roof', seed: 1, at: { omt: 'hotel_tower', where: 'roof' }, looks: DOWN },
  { name: 'house-basement', seed: 1, at: { omt: 'house', where: 'inside', z: -1 }, looks: UP },
  { name: 'lab-inside', seed: 1, at: { omt: 'lab', where: 'inside', z: -2 }, looks: UP },
];
