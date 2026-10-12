import { describe, expect, it } from 'vitest';
import { Activity } from '../src/game/activity';
import { CraftAssemblyController } from '../src/game/activitytoys/assembly';
import type { ToyHost } from '../src/game/activitytoys/controller';
import { createItem, Item } from '../src/game/item';
import { makeData } from './fixtures/gamedata';

function fixture(batch = 1) {
  const data = makeData();
  data.items.craft = { ...data.items.rag, id: 'craft' };
  data.recipes = [{ id: 'toy', result: 'rag', components: Array.from({ length: 6 }, () => [{ id: 'rag', count: 1 }, { id: 'bandages', count: 1 }]), tools: [], qualities: [] }] as any;
  const item = createItem(data, 'craft');
  Object.assign(item.vars, { craft_recipe: 'toy', craft_batch: batch, craft_progress: 0, craft_next_failure: 2, craft_comps: JSON.stringify([{ id: 'rag', count: 6 * batch }, { id: 'bandages', count: 6 * batch }]) });
  let base = 0;
  const spec = { kind: 'craft' as const, name: 'crafting', target: item, duration: 100 * batch,
    onProgress: (_: number, f: number) => { item.vars.craft_progress = base + (1 - base) * f; }, onComplete() {} };
  const a = new Activity(spec);
  const host = { data, activities: { current: a }, simSpeed: 1 } as unknown as ToyHost;
  let enabled = true;
  const toy = new CraftAssemblyController(host, () => enabled);
  toy.update();
  return { data, item, a, host, toy, off: () => { enabled = false; }, resume: () => {
    base = Number(item.vars.craft_progress);
    host.activities.current = new Activity({ ...spec, duration: 100 * batch * (1 - base) });
    toy.update();
  } };
}
describe('optional crafting assembly', () => {
  it('accepts every alternative, rejects mismatches/duplicates and caps each batch at20%', () => {
    const { toy, a, item } = fixture();
    expect(toy.place(0, 'invalid')).toBe(false);
    expect(toy.place(0, 'bandages')).toBe(true);
    expect(toy.place(0, 'rag')).toBe(false);
    for (let i = 1; i < 6; i++) toy.place(i, 'rag');
    expect(a.elapsed).toBeCloseTo(20);
    expect(Number(item.vars.craft_progress)).toBeCloseTo(.2);
    expect(JSON.parse(String(item.vars.assembly_bonus))).toEqual([.2]);
  });
  it('autofills ignored work without changing ordinary elapsed time; off hides the toy', () => {
    const { toy, a, item, off } = fixture();
    a.elapsed = 50; a.spec.onProgress?.(0, a.fraction); toy.update();
    expect(toy.slots.filter(s => s.automatic)).toHaveLength(3);
    expect(a.elapsed).toBe(50);
    expect(item.vars.assembly_bonus).toBeUndefined();
    off(); expect(toy.place(4, 'rag')).toBe(false); toy.update(); expect(toy.activity).toBeNull();
  });
  it('retains saved budget and placements after cancel/resume and item round-trip', () => {
    const { toy, item, data, host, resume } = fixture();
    toy.place(0, 'rag'); resume();
    expect(toy.place(0, 'rag')).toBe(false);
    expect(toy.place(1, 'rag')).toBe(true);
    const restored = Item.fromJSON(data, item.toJSON());
    expect(restored.vars.assembly_bonus).toBe(item.vars.assembly_bonus);
    host.activities.current = null;
    expect(toy.place(2, 'rag')).toBe(false); toy.update(); expect(toy.activity).toBeNull();
  });
  it('gives separate batch budgets and rejects pause/fast/off changes at input time', () => {
    const { toy, item, a, host, off } = fixture(3);
    host.simSpeed = 8; expect(toy.place(0, 'rag')).toBe(false);
    host.simSpeed = 1; host.paused = true; expect(toy.place(0, 'rag')).toBe(false);
    host.paused = false; toy.update();
    for(let i=0;i<6;i++)toy.place(i,'rag');
    expect(a.elapsed).toBeCloseTo(20);
    a.elapsed = 100; a.spec.onProgress?.(0,a.fraction); toy.update();
    expect(toy.batchIndex).toBe(1);
    expect(toy.place(0,'bandages')).toBe(true);
    expect(JSON.parse(String(item.vars.assembly_bonus))).toEqual([.2,.04]);
    off(); expect(toy.place(1,'rag')).toBe(false);
  });
  it('revalidates batch and automatic slots between render and input', () => {
    const { toy, a, item } = fixture(3);
    a.elapsed = 100; a.spec.onProgress?.(0, a.fraction);
    expect(toy.place(0, 'rag')).toBe(false); // stale card belongs to previous batch
    expect(item.vars.assembly_bonus).toBeUndefined();
    expect(toy.batchIndex).toBe(1);
    a.elapsed = 150; a.spec.onProgress?.(0, a.fraction);
    expect(toy.place(0, 'rag')).toBe(false); // auto-filled since last render
    expect(toy.place(4, 'rag')).toBe(true);
    expect(JSON.parse(String(item.vars.assembly_bonus))).toEqual([null, .04]);
    expect(toy.place(5, 'rag')).toBe(true);
    expect(JSON.parse(String(item.vars.assembly_bonus))).toEqual([0, .08]);
  });
  it('shows only alternatives actually committed to the unfinished craft', () => {
    const { toy, item } = fixture();
    item.vars.craft_comps = JSON.stringify([{ id: 'bandages', count: 6 }]);
    toy.update();
    expect(toy.slots[0].alternatives).toEqual(['bandages']);
    expect(toy.place(0, 'rag')).toBe(false);
    expect(toy.place(0, 'bandages')).toBe(true);
  });
  it('allows normal progress callback to cancel or replace activity on a crafting mishap', () => {
    const { toy, a, host } = fixture();
    a.spec.onProgress = () => { host.activities.current = null; };
    expect(toy.place(0,'rag')).toBe(true);
    expect(toy.activity).toBeNull();
  });
});
