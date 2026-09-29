// Time-sliced work: long builds (chunk meshing, 3D trees, grass, the skyline) are written as
// generators that yield at natural boundaries (a row of tiles, a tree). A caller either runs
// one to completion (tests, flushChunks) or steps it under a per-frame budget, keeping the
// previous result on screen until the new one is complete.

/** Run a time-sliced generator to completion. */
export function runSteps<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

/**
 * Step `g` until it finishes or `deadline` (performance.now() ms) passes; at least one step
 * always runs so a job can't starve. Returns `{ done: true, value }` or `{ done: false }`.
 */
export function stepUntil<T>(g: Generator<void, T>, deadline: number): { done: true; value: T } | { done: false } {
  do {
    const r = g.next();
    if (r.done) return { done: true, value: r.value };
  } while (performance.now() < deadline);
  return { done: false };
}
