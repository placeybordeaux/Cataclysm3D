import type { MapItem } from '../../src/world/map';
import type { Ground } from '../../src/game/moves';

/** A map stand-in for item tests: tiles hold item lists; optional furniture per tile. */
export class FakeGround implements Ground {
  readonly tiles = new Map<string, MapItem[]>();
  readonly furn = new Map<string, { id: string; name?: string; max_volume?: number }>();
  itemsAt(x: number, y: number, z: number): MapItem[] {
    return this.tiles.get(`${x},${y},${z}`) ?? [];
  }
  addItem(x: number, y: number, z: number, it: MapItem): void {
    const k = `${x},${y},${z}`;
    if (!this.tiles.has(k)) this.tiles.set(k, []);
    this.tiles.get(k)!.push(it);
  }
  removeItem(x: number, y: number, z: number, it: MapItem): boolean {
    const l = this.tiles.get(`${x},${y},${z}`);
    const i = l ? l.indexOf(it) : -1;
    if (i < 0) return false;
    l!.splice(i, 1);
    return true;
  }
  furnAt(x: number, y: number, z: number) {
    return this.furn.get(`${x},${y},${z}`) ?? { id: 'f_null' };
  }
  /** Every tile that has anything, as [x, y, z]. */
  coords(): [number, number, number][] {
    return [...this.tiles.keys()].map((k) => k.split(',').map(Number) as [number, number, number]);
  }
}
