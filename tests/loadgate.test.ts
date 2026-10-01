import { describe, expect, it } from 'vitest';
import { GATE_TUNING, LoadGate, type GateInput } from '../src/loadgate/gate';

// The load gate's state machine (src/loadgate/gate.ts): when the game is held while the world
// around the player is unbuilt, and that it never flickers during normal play.

const built: GateInput = { core: 0, near: 0, far: 0, wanted: 60 };
const lost: GateInput = { core: 9, near: 40, far: 60, wanted: 60 };
const hole: GateInput = { core: 0, near: 1, far: 3, wanted: 60 };
const outer: GateInput = { core: 0, near: 0, far: 2, wanted: 60 };
const dt = 1 / 60;

/** Run `s` seconds of frames with the same input; returns how many frames were closed. */
function run(g: LoadGate, inp: GateInput, s: number, active = true): number {
  let closed = 0;
  for (let t = 0; t < s - 1e-9; t += dt) if (g.update(dt, inp, active).closed) closed++;
  return closed;
}

describe('load gate', () => {
  it('a load / teleport (own 3x3 missing) closes at once with the full screen in auto, and opens once the wider ring is built', () => {
    const g = new LoadGate('auto');
    const s = g.update(dt, lost);
    expect(s).toMatchObject({ closed: true, closedNow: true, style: 'block', reason: 'core' });
    expect(s.progress).toBe(0);
    run(g, outer, 2);
    expect(g.isClosed).toBe(true); // 3x3 there, the 64 m ring not yet
    const o = g.update(dt, built);
    expect(o).toMatchObject({ closed: false, openedNow: true });
  });

  it('stays closed at least minHold even when everything arrives at once', () => {
    const g = new LoadGate('auto');
    g.update(dt, lost);
    expect(run(g, built, GATE_TUNING.minHold - 0.05)).toBeGreaterThan(0);
    expect(g.isClosed).toBe(true);
    run(g, built, 0.1);
    expect(g.isClosed).toBe(false);
  });

  it('a hole in the 40 m ring closes only after the debounce, with the soft note in auto', () => {
    const g = new LoadGate('auto');
    run(g, hole, GATE_TUNING.debounce - 0.05);
    expect(g.isClosed).toBe(false);
    const s = g.update(0.06, hole);
    expect(s).toMatchObject({ closed: true, style: 'soft', reason: 'near' });
  });

  it('chunks a frame or two late never show anything (no flicker in normal play)', () => {
    const g = new LoadGate('auto');
    let closed = 0;
    for (let i = 0; i < 600; i++) closed += g.update(dt, i % 30 < 6 ? hole : built).closed ? 1 : 0;
    expect(closed).toBe(0);
  });

  it('just after opening, a new hole has to last recloseDebounce, not debounce', () => {
    const g = new LoadGate('auto');
    g.update(dt, lost);
    run(g, built, 0.5);
    expect(g.isClosed).toBe(false);
    run(g, hole, GATE_TUNING.recloseDebounce - 0.1);
    expect(g.isClosed).toBe(false);
    run(g, hole, 0.2);
    expect(g.isClosed).toBe(true);
    // ...but the 3x3 going missing (a fall into an unbuilt level) closes at once
    const h = new LoadGate('auto');
    h.update(dt, lost);
    run(h, built, 0.5);
    expect(h.update(dt, lost).closed).toBe(true);
  });

  it('auto: soft upgrades to the full screen when the 3x3 goes missing, never back while closed', () => {
    const g = new LoadGate('auto');
    run(g, hole, 0.5);
    expect(g.update(dt, hole).style).toBe('soft');
    expect(g.update(dt, lost).style).toBe('block');
    expect(g.update(dt, outer).style).toBe('block');
  });

  it("block / soft always show that way; 'off' never holds, and switching to it opens a closed gate", () => {
    for (const mode of ['block', 'soft'] as const) {
      const g = new LoadGate(mode);
      expect(g.update(dt, lost).style).toBe(mode);
      run(g, built, 1);
      run(g, hole, GATE_TUNING.recloseDebounce + 0.1);
      expect(g.update(dt, hole)).toMatchObject({ closed: true, style: mode });
    }
    const off = new LoadGate('off');
    expect(run(off, lost, 3)).toBe(0);
    const g = new LoadGate('auto');
    g.update(dt, lost);
    g.mode = 'off';
    expect(g.update(dt, lost)).toMatchObject({ closed: false, openedNow: true });
  });

  it('inactive (title screen, dead) never holds', () => {
    const g = new LoadGate('auto');
    expect(run(g, lost, 1, false)).toBe(0);
  });

  it('a stuck build never locks the game: gives up after maxHold and stays off for a while', () => {
    const g = new LoadGate('auto', { maxHold: 2, suppress: 5 });
    let timedOut = 0;
    for (let t = 0; t < 2.1; t += dt) timedOut += g.update(dt, lost).timedOut ? 1 : 0;
    expect(timedOut).toBe(1);
    expect(g.isClosed).toBe(false);
    expect(run(g, lost, 4.8)).toBe(0);
    run(g, lost, 0.3);
    expect(g.isClosed).toBe(true);
    expect(g.counts).toEqual({ closes: 2, timeouts: 1 });
  });

  it('progress is the share of the wider ring built', () => {
    const g = new LoadGate('auto');
    expect(g.update(dt, { core: 1, near: 10, far: 15, wanted: 60 }).progress).toBeCloseTo(0.75);
    expect(g.update(dt, { core: 0, near: 0, far: 0, wanted: 0 }).progress).toBe(1);
  });
});
