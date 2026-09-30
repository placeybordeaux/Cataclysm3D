// Render-only: furniture tiles the chunk mesher leaves out, because something else draws that
// piece right now (a dragged dresser sliding into the tile: src/render/grabView.ts). Game logic
// never reads this; the map still has the furniture there.

const hidden = new Set<string>();

const key = (x: number, y: number, z: number) => `${x},${y},${z}`;

export const furnitureHide = {
  has(x: number, y: number, z: number): boolean {
    return hidden.size > 0 && hidden.has(key(x, y, z));
  },
  add(x: number, y: number, z: number): void {
    hidden.add(key(x, y, z));
  },
  delete(x: number, y: number, z: number): void {
    hidden.delete(key(x, y, z));
  },
  get size(): number {
    return hidden.size;
  },
};
