import type { BufferAttribute } from 'three';

/** Union pending writes into one upload span, in components (not instances).
 * Keep pending writes until Three consumes them: a mesh may skip several renders. */
export function touchInstanceRange(attribute: BufferAttribute, start: number, count: number): void {
  if (count <= 0) return;
  const ranges = attribute.updateRanges;
  if (ranges.length === 0) attribute.addUpdateRange(start, count);
  else {
    const range = ranges[0];
    const end = Math.max(range.start + range.count, start + count);
    range.start = Math.min(range.start, start);
    range.count = end - range.start;
  }
  attribute.needsUpdate = true;
}
