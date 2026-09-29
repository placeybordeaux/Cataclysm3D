import type { Field, ItemSpawn } from '../map';

// Working grid for one OMT while mapgen runs. Uses string ids (not registry indices) so
// region pseudo-terrain (t_region_*) and unknown ids can be resolved/reported at the end.
// Everything placed here uses local 0..23 coordinates; rotation is applied to the whole
// buffer like CDDA's map::rotate.

export const OMT = 24;

export interface LocalSpawn {
  kind: 'monster' | 'group';
  id: string;
  x: number;
  y: number;
  /** For group area spawns: inclusive local rectangle */
  x2?: number;
  y2?: number;
  density?: number;
  chance?: number;
  count?: number;
  name?: string;
  friendly?: boolean;
}

export interface LocalVehicle {
  id: string;
  x: number;
  y: number;
  rotation?: number;
  chance?: number;
  status?: number;
  fuel?: number;
}

export interface LocalZone {
  type: string;
  faction?: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** '' in ter/furn means "not written" (used by overlay buffers for other z-levels). */
export class MapBuffer {
  readonly ter: string[];
  readonly furn: string[];
  readonly traps = new Map<number, string>();
  items = new Map<number, ItemSpawn[]>();
  fields = new Map<number, Field[]>();
  signs = new Map<number, string>();
  graffiti = new Map<number, string>();
  computers = new Map<number, Record<string, unknown>>();
  radiation = new Map<number, number>();
  spawns: LocalSpawn[] = [];
  vehicles: LocalVehicle[] = [];
  zones: LocalZone[] = [];

  constructor(fillTer = '', fillFurn = '') {
    this.ter = new Array(OMT * OMT).fill(fillTer);
    this.furn = new Array(OMT * OMT).fill(fillFurn);
  }

  static idx(x: number, y: number): number {
    return y * OMT + x;
  }
  static inb(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < OMT && y < OMT;
  }

  addItem(i: number, it: ItemSpawn): void {
    let l = this.items.get(i);
    if (!l) this.items.set(i, (l = []));
    l.push(it);
  }
  addField(i: number, type: string, intensity: number, age = 0): void {
    let l = this.fields.get(i);
    if (!l) this.fields.set(i, (l = []));
    const f = l.find((f) => f.type === type);
    if (f) f.intensity = Math.max(f.intensity, intensity);
    else l.push({ type, intensity, age });
  }
  clearTile(i: number): void {
    this.furn[i] = '';
    this.traps.delete(i);
    this.items.delete(i);
    this.fields.delete(i);
    this.signs.delete(i);
    this.graffiti.delete(i);
  }

  /** Rotate clockwise by `turns` * 90 degrees: (x, y) -> (23 - y, x), like CDDA point::rotate. */
  rotate(turns: number): void {
    turns = ((turns % 4) + 4) % 4;
    if (turns === 0) return;
    const rp = (x: number, y: number): [number, number] => {
      for (let t = 0; t < turns; t++) [x, y] = [OMT - 1 - y, x];
      return [x, y];
    };
    const ri = (i: number) => {
      const [x, y] = rp(i % OMT, Math.floor(i / OMT));
      return y * OMT + x;
    };
    const ter = this.ter.slice(), furn = this.furn.slice();
    for (let i = 0; i < OMT * OMT; i++) {
      const j = ri(i);
      this.ter[j] = ter[i];
      this.furn[j] = furn[i];
    }
    const remap = <T>(m: Map<number, T>): Map<number, T> => {
      const n = new Map<number, T>();
      for (const [k, v] of m) n.set(ri(k), v);
      return n;
    };
    const traps = remap(this.traps);
    this.traps.clear();
    for (const [k, v] of traps) this.traps.set(k, v);
    this.items = remap(this.items);
    this.fields = remap(this.fields);
    this.signs = remap(this.signs);
    this.graffiti = remap(this.graffiti);
    this.computers = remap(this.computers);
    this.radiation = remap(this.radiation);
    for (const s of this.spawns) {
      [s.x, s.y] = rp(s.x, s.y);
      if (s.x2 !== undefined && s.y2 !== undefined) {
        [s.x2, s.y2] = rp(s.x2, s.y2);
        [s.x, s.x2] = [Math.min(s.x, s.x2), Math.max(s.x, s.x2)];
        [s.y, s.y2] = [Math.min(s.y, s.y2), Math.max(s.y, s.y2)];
      }
    }
    for (const v of this.vehicles) {
      [v.x, v.y] = rp(v.x, v.y);
      // An unrotated vehicle (rotation omitted = 0) still turns with its rotated mapgen.
      v.rotation = ((v.rotation ?? 0) + 90 * turns) % 360;
    }
    for (const z of this.zones) {
      const [ax, ay] = rp(z.x0, z.y0), [bx, by] = rp(z.x1, z.y1);
      z.x0 = Math.min(ax, bx); z.x1 = Math.max(ax, bx);
      z.y0 = Math.min(ay, by); z.y1 = Math.max(ay, by);
    }
  }
}
