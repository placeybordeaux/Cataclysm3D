// Mission log data (UI-free, unit-tested): what each mission asks, where it points, how long
// is left, and the map markers for active missions (exported through src/game/mapmarkers.ts
// so the map / compass can draw them).

import type { MissionInstance, MissionSystem } from '../../game/missions';
import type { MapMarker } from '../../game/mapmarkers';
import type { Tone } from '../../ui2';

const OMT = 24;
const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];

export interface Bearing {
  /** OMTs away (Chebyshev, like BN's mission direction text). */
  omts: number;
  dir: string;
  arrow: string;
  /** "12 OMT north-east" / "here". */
  text: string;
}

/** From the survivor's tile to an OMT (y grows south). */
export function bearing(px: number, py: number, omx: number, omy: number): Bearing {
  const dx = omx - Math.floor(px / OMT), dy = omy - Math.floor(py / OMT);
  const d = Math.max(Math.abs(dx), Math.abs(dy));
  if (d === 0) return { omts: 0, dir: 'here', arrow: '•', text: 'You are there' };
  const i = Math.round((((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360) / 45) % 8;
  return { omts: d, dir: DIRS[i], arrow: ARROWS[i], text: `${d} OMT ${DIRS[i]}` };
}

/** Where a mission points now: its target OMT, else its target monster, else nothing. */
export function missionTarget(m: MissionInstance): { omx: number; omy: number; z: number; x?: number; y?: number } | null {
  if (m.target) return { omx: m.target.x, omy: m.target.y, z: m.target.z };
  const t = m.targetMonster;
  if (t && !t.dead) return { omx: Math.floor(t.x / OMT), omy: Math.floor(t.y / OMT), z: t.z, x: t.x, y: t.y };
  return null;
}

export interface MissionEntry {
  uid: number;
  name: string;
  status: MissionInstance['status'];
  goal: string;
  giver: string | null;
  description: string;
  target: Bearing | null;
  /** Hours left, when there is a deadline. */
  hoursLeft: number | null;
  deadlineTone: Tone;
  /** BN mission value, cents (what the giver considers it worth). */
  value: number;
  difficulty: number;
}

export function missionEntry(sys: MissionSystem, m: MissionInstance, player: { x: number; y: number }, now: number, giverName: (uid: number) => string | null, describe: (s: string) => string = (s) => s): MissionEntry {
  const def = sys.def(m);
  const tgt = missionTarget(m);
  const hoursLeft = m.deadline !== undefined ? Math.max(0, (m.deadline - now) / 3600) : null;
  return {
    uid: m.uid,
    name: def?.name ?? m.id,
    status: m.status,
    goal: sys.goalText(m),
    giver: m.npcUid >= 0 ? giverName(m.npcUid) : null,
    description: def?.description ? describe(def.description) : '',
    target: tgt ? bearing(player.x, player.y, tgt.omx, tgt.omy) : null,
    hoursLeft,
    deadlineTone: hoursLeft === null ? 'dim' : hoursLeft < 6 ? 'bad' : hoursLeft < 24 ? 'warn' : 'dim',
    value: def?.value ?? 0,
    difficulty: def?.difficulty ?? 0,
  };
}

/** Map markers for the active missions that point somewhere. */
export function missionMarkers(sys: MissionSystem, tracked: number | null): MapMarker[] {
  const out: MapMarker[] = [];
  for (const m of sys.active()) {
    const t = missionTarget(m);
    if (!t) continue;
    out.push({ id: `mission:${m.uid}`, kind: 'mission', ...t, label: sys.def(m)?.name ?? m.id, detail: sys.goalText(m), tracked: m.uid === tracked || undefined });
  }
  return out;
}

/** "$25" style reward hint from a mission's value (cents). */
export function valueText(cents: number): string {
  return cents > 0 ? `$${Math.round(cents / 100)}` : '—';
}
