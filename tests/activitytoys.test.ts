import { describe, expect, it, vi } from 'vitest';
import { Activity } from '../src/game/activity';
import { ActivityToyController, partFree, teardownParts } from '../src/game/activitytoys/controller';
import { createItem, Item } from '../src/game/item';
import { makeData } from './fixtures/gamedata';
const data = makeData();
import type { ToyHost } from '../src/game/activitytoys/controller';

function fixture() {
  const item = createItem(data, 'rag');
  let progress = 0;
  const a = new Activity({ kind: 'construction', name: 'constructing', target: item, duration: 100, onProgress: (_dt, f) => progress = f, onComplete() {} });
  const host = { data, activities: { current: a }, player: { getSkill: () => 0, practice: vi.fn() }, simSpeed: 1 } as unknown as ToyHost;
  const toy = new ActivityToyController(host, () => true);
  const tick = (seconds: number) => { for (let i = 0; i < Math.round(seconds * 10); i++) toy.update(.1); };
  return { item, a, host, toy, tick, progress: () => progress };
}
describe('optional activity toys', () => {
  it('ignoring or missing timing changes no elapsed work; hits synchronise saved progress once per beat and cap at 20%', () => {
    const { a, item, toy, tick, progress } = fixture();
    tick(.1);
    expect(toy.press()).toBe(false);
    expect(a.elapsed).toBe(0);
    tick(.5);
    expect(toy.press()).toBe(true);
    expect(toy.press()).toBe(false);
    expect(progress()).toBeCloseTo(.04);
    for (let i = 0; i < 9; i++) { tick(1.2); toy.press(); }
    expect(a.elapsed).toBeCloseTo(20);
    expect(item.vars.activity_toy_construction).toBeCloseTo(.2);
  });
  it('freezes timing and rejects input while paused or fast-forwarding; cancels immediately and budget survives resume', () => {
    const { a, item, host, toy, tick } = fixture();
    tick(.6); toy.press();
    const phase = toy.phase();
    host.simSpeed = 8; toy.update(.1);
    expect(toy.phase()).toBe(phase); expect(toy.press()).toBe(false);
    host.simSpeed = 1; toy.update(.1, true);
    expect(toy.phase()).toBe(phase); expect(toy.press()).toBe(false);
    host.activities.current = null;
    expect(toy.press()).toBe(false);
    toy.update(.1); expect(toy.activity).toBe(null);
    host.activities.current = new Activity({ ...a.spec, duration: 96 });
    tick(.6); expect(toy.press()).toBe(true);
    expect(item.vars.activity_toy_construction).toBeCloseTo(.08);
  });
  it('persists the anti-farming bonus ledger through item save/load', () => {
    const { item, toy, tick, host } = fixture();
    for (let i = 0; i < 5; i++) { tick(i === 0 ? .6 : 1.2); toy.press(); }
    const restored = Item.fromJSON(data, item.toJSON());
    expect(restored.vars.activity_toy_construction).toBeCloseTo(.2);
    host.activities.current = new Activity({ kind: 'construction', name: 'resumed', target: restored, duration: 80, onComplete() {} });
    const resumed = new ActivityToyController(host, () => true);
    for (let i = 0; i < 6; i++) resumed.update(.1);
    expect(resumed.press()).toBe(false);
    expect(host.activities.current.elapsed).toBe(0);
  });
  it('rejects an input immediately after off, pause or fast-forward changes before a UI update', () => {
    const { host, a } = fixture();
    let enabled = true;
    const toy = new ActivityToyController(host, () => enabled);
    for (let i = 0; i < 6; i++) toy.update(.1);
    enabled = false; expect(toy.press()).toBe(false);
    enabled = true; host.simSpeed = 8; expect(toy.press()).toBe(false);
    host.simSpeed = 1; host.paused = true; expect(toy.press()).toBe(false);
    host.paused = false; host.input = { captured: true, captureTimeFlows: false }; expect(toy.press()).toBe(false);
    expect(a.elapsed).toBe(0);
  });
  it('off never attaches to the activity', () => {
    const { host, a } = fixture();
    const off = new ActivityToyController(host, () => false);
    off.update(1); expect(off.activity).toBe(null); expect(off.press()).toBe(false); expect(a.elapsed).toBe(0);
  });
  it('makes familiar teardown shallower with more free entry points, while component count scales size', () => {
    const labels = ['casing', 'plate', 'wire', 'board', 'switch', 'battery', 'spring', 'handle'];
    const novice = teardownParts(labels, 0, 3);
    const expert = teardownParts(labels, 9, 3);
    expect(expert.filter((_, i) => partFree(expert, i)).length).toBeGreaterThan(novice.filter((_, i) => partFree(novice, i)).length);
    const depth = (parts: ReturnType<typeof teardownParts>, index: number): number => parts[index].blockedBy.length ? 1 + depth(parts, parts[index].blockedBy[0]) : 0;
    expect(depth(expert, 7)).toBeLessThan(depth(novice, 7));
    expect(teardownParts(labels.slice(0, 3))).toHaveLength(3);
  });
  it('generates a fully solvable teardown and forbids covered or already removed parts without damage', () => {
    const parts = teardownParts(['casing', 'plate', 'wire', 'board', 'switch', 'battery']);
    expect(partFree(parts, 1)).toBe(false);
    for (let i = 0; i < parts.length; i++) {
      expect(partFree(parts, i)).toBe(true);
      parts[i].removed = true;
      expect(partFree(parts, i)).toBe(false);
    }
    expect(parts.every(p => p.removed)).toBe(true);
  });
});
