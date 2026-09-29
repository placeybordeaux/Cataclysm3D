import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { autoScale, uiMetrics } from '../src/ui2/logic/scale';
import { arrangeRow, cascade, clampRect, gridColumns, paperDollLayout, placePopup } from '../src/ui2/logic/layout';
import { contrast, uiPalette } from '../src/ui2/logic/palette';
import { checkDrop, defaultSplit, wheelCount } from '../src/ui2/logic/dnd';
import { canMerge, fmtDuration, fmtVolume, fmtWeight, splitCounts, type ItemView } from '../src/ui2/logic/items';
import { ToastQueue } from '../src/ui2/logic/toasts';
import { MockStore, insideOf } from '../src/ui2/mock/store';
import { buildMockKit, DOLL_SLOTS, type RawItems } from '../src/ui2/mock/data';

const item = (o: Partial<ItemView> & { id: string }): ItemView => ({
  typeId: o.id.replace(/\d+$/, ''), name: o.id, count: 1, stackable: false, weight: 100, volume: 100, ...o,
});

describe('ui2 scale', () => {
  it('picks integer scales by resolution, width only pulls down', () => {
    expect(autoScale(960, 540)).toBe(1);
    expect(autoScale(1280, 720)).toBe(1);
    expect(autoScale(1920, 1080)).toBe(2);
    expect(autoScale(3440, 1304)).toBe(2);
    expect(autoScale(2560, 1440)).toBe(2);
    expect(autoScale(3840, 2160)).toBe(3);
    expect(autoScale(1000, 1600)).toBe(1);
  });
  it('icons are integer multiples of the 32px sprites', () => {
    for (const s of [1, 2, 3] as const) {
      const m = uiMetrics(s);
      expect(m.icon % 32).toBe(0);
      expect(m.rowIcon % 32).toBe(0);
      expect(m.u).toBe(s);
    }
  });
});

describe('ui2 layout', () => {
  const view = { w: 960, h: 540 };
  it('clamps windows so the title bar stays reachable', () => {
    expect(clampRect({ x: 900, y: 500, w: 200, h: 100 }, view)).toMatchObject({ x: 760, y: 440 });
    expect(clampRect({ x: -50, y: -20, w: 200, h: 100 }, view, 4)).toMatchObject({ x: 4, y: 4 });
    // Bigger than the screen: pinned top-left, size kept (the body scrolls).
    expect(clampRect({ x: 300, y: 300, w: 2000, h: 900 }, view)).toEqual({ x: 0, y: 0, w: 2000, h: 900 });
  });
  it('places popups below/right and flips at the edges', () => {
    expect(placePopup({ x: 100, y: 100, w: 0, h: 0 }, { w: 200, h: 150 }, view)).toEqual({ x: 100, y: 100 });
    expect(placePopup({ x: 900, y: 500, w: 0, h: 0 }, { w: 200, h: 150 }, view)).toEqual({ x: 700, y: 350 });
    // Submenu: right of its row, flipped left near the right edge, bottom-aligned near the bottom.
    expect(placePopup({ x: 500, y: 100, w: 200, h: 20 }, { w: 180, h: 100 }, view, 'right')).toEqual({ x: 700, y: 100 });
    expect(placePopup({ x: 700, y: 100, w: 200, h: 20 }, { w: 180, h: 100 }, view, 'right')).toEqual({ x: 520, y: 100 });
    expect(placePopup({ x: 100, y: 500, w: 200, h: 20 }, { w: 180, h: 100 }, view, 'right')).toEqual({ x: 300, y: 420 });
    // Never off-screen even when it can't fit either side.
    const p = placePopup({ x: 10, y: 10, w: 0, h: 0 }, { w: 2000, h: 50 }, view);
    expect(p.x).toBe(0);
  });
  it('arranges a screen of windows in rows, centred', () => {
    const pos = arrangeRow([{ w: 300, h: 200 }, { w: 300, h: 250 }], { w: 1000, h: 600 }, 10, 8);
    expect(pos).toEqual([{ x: 195, y: 175 }, { x: 505, y: 175 }]);
    const wrap = arrangeRow([{ w: 500, h: 100 }, { w: 500, h: 100 }], { w: 800, h: 600 }, 10, 8);
    expect(wrap[0].y).toBeLessThan(wrap[1].y);
    expect(wrap[1].x).toBe(150);
  });
  it('cascade steps and wraps', () => {
    const v = { w: 400, h: 300 };
    const a = cascade(0, 20, { x: 10, y: 10 }, v, { w: 300, h: 200 });
    const b = cascade(1, 20, { x: 10, y: 10 }, v, { w: 300, h: 200 });
    expect(b.x - a.x).toBe(20);
    expect(cascade(4, 20, { x: 10, y: 10 }, v, { w: 300, h: 200 })).toEqual(a);
  });
  it('grid columns and paper doll', () => {
    expect(gridColumns(300, 64, 4)).toBe(4);
    expect(gridColumns(10, 64, 4)).toBe(1);
    const d = paperDollLayout(DOLL_SLOTS, 32, 4);
    expect(d.pos.head).toEqual({ x: 36, y: 0 });
    expect(d.size.w).toBe(3 * 32 + 2 * 4);
    expect(() => paperDollLayout([{ id: 'a', col: 0, row: 0 }, { id: 'a', col: 1, row: 0 }], 32, 4)).toThrow(/duplicate/);
  });
});

describe('ui2 palette', () => {
  it('comes from the grading palette and reads well', () => {
    const p = uiPalette();
    for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrast(p.text, p.bg)).toBeGreaterThan(7);
    expect(contrast(p.textDim, p.bg)).toBeGreaterThan(4.5);
    expect(contrast(p.accent, p.bg)).toBeGreaterThan(4.5);
    expect(contrast(p.bad, p.bg)).toBeGreaterThan(3);
  });
});

describe('ui2 items', () => {
  it('splits stacks strictly', () => {
    expect(splitCounts(10, 3)).toEqual({ take: 3, rest: 7 });
    expect(splitCounts(10, 10)).toEqual({ take: 10, rest: 0 });
    expect(() => splitCounts(10, 0)).toThrow();
    expect(() => splitCounts(10, 11)).toThrow();
    expect(() => splitCounts(10, 1.5)).toThrow();
    expect(defaultSplit(1)).toBe(1);
    expect(defaultSplit(9)).toBe(4);
    expect(wheelCount(5, 40, 1, false)).toBe(9);
    expect(wheelCount(5, 40, -1, true)).toBe(4);
    expect(wheelCount(1, 40, -3, false)).toBe(1);
    expect(wheelCount(39, 40, 3, true)).toBe(40);
  });
  it('merges only like with like', () => {
    const a = item({ id: 'nail1', stackable: true });
    expect(canMerge(a, item({ id: 'nail2', stackable: true }))).toBe(true);
    expect(canMerge(a, a)).toBe(false);
    expect(canMerge(a, item({ id: 'rock1', stackable: true }))).toBe(false);
    expect(canMerge(a, item({ id: 'nail3', stackable: true, condition: 0.5 }))).toBe(false);
  });
  it('formats', () => {
    expect(fmtWeight(350)).toBe('350 g');
    expect(fmtWeight(2400)).toBe('2.4 kg');
    expect(fmtVolume(1250)).toBe('1.25 L');
    expect(fmtDuration(0.5)).toBe('0.5 s');
    expect(fmtDuration(45)).toBe('45 s');
    expect(fmtDuration(600)).toBe('10 min');
    expect(fmtDuration(4800)).toBe('1 h 20 min');
  });
});

describe('ui2 drop validation', () => {
  const nails = item({ id: 'nail1', stackable: true, count: 40, volume: 3, weight: 20 });
  it('accepts, partially accepts, rejects with reasons', () => {
    expect(checkDrop({}, [], nails, 40)).toEqual({ kind: 'ok', count: 40 });
    const v = checkDrop({ maxVolume: 60 }, [], nails, 40);
    expect(v).toMatchObject({ kind: 'partial', count: 20 });
    const big = item({ id: 'plank1', volume: 4000 });
    const r = checkDrop({ maxVolume: 1000 }, [], big, 1);
    expect(r.kind).toBe('reject');
    expect((r as { reason: string }).reason).toMatch(/Too big: needs 4 L, 1 L free/);
    const heavy = checkDrop({ maxWeight: 500 }, [item({ id: 'x1', weight: 450 })], item({ id: 'y1', weight: 100 }), 1);
    expect((heavy as { reason: string }).reason).toMatch(/Too heavy: 50 g over/);
    expect(checkDrop({ accepts: () => 'Nope' }, [], nails, 1)).toEqual({ kind: 'reject', reason: 'Nope' });
  });
  it('noop when already there; single slots swap or refuse', () => {
    expect(checkDrop({}, [nails], nails, 1)).toEqual({ kind: 'noop' });
    const bat = item({ id: 'bat1' });
    const machete = item({ id: 'machete1' });
    expect(checkDrop({ maxStacks: 1 }, [bat], machete, 1)).toEqual({ kind: 'reject', reason: 'Slot is taken' });
    expect(checkDrop({ maxStacks: 1, swap: true }, [bat], machete, 1)).toEqual({ kind: 'swap', count: 1, displaced: bat });
    expect(checkDrop({ maxStacks: 1, swap: true }, [bat], machete, 1, () => "won't fit")).toMatchObject({ kind: 'reject' });
    // Same stack type merges into an occupied single slot instead of swapping.
    expect(checkDrop({ maxStacks: 1 }, [item({ id: 'nail9', stackable: true })], nails, 5)).toEqual({ kind: 'ok', count: 5 });
  });
  it('throws on impossible counts', () => {
    expect(() => checkDrop({}, [], nails, 41)).toThrow();
    expect(() => checkDrop({}, [], nails, 0)).toThrow();
  });
});

describe('ui2 toasts', () => {
  it('limits visible toasts and queues the rest', () => {
    const q = new ToastQueue();
    expect(q.push({ category: 'info', title: 'a' }, 0)).toBe('shown');
    expect(q.push({ category: 'warning', title: 'b' }, 0)).toBe('shown');
    expect(q.push({ category: 'achievement', title: 'c' }, 0)).toBe('shown');
    expect(q.push({ category: 'warning', title: 'd' }, 0)).toBe('queued');
    expect(q.visible.map((t) => t.title)).toEqual(['a', 'b', 'c']);
    q.tick(4000); // info expired (3.5 s): d takes its place
    expect(q.visible.map((t) => t.title)).toEqual(['b', 'c', 'd']);
  });
  it('folds repeats and spaces discoveries out', () => {
    const q = new ToastQueue();
    q.push({ category: 'discovery', title: 'New recipe: splint' }, 0);
    expect(q.push({ category: 'discovery', title: 'New recipe: splint' }, 100)).toBe('merged');
    expect(q.visible[0].count).toBe(2);
    expect(q.push({ category: 'discovery', title: 'New recipe: torch' }, 200)).toBe('queued');
    q.tick(3000);
    expect(q.visible.length).toBe(1);
    q.tick(4100);
    expect(q.visible.map((t) => t.title)).toEqual(['New recipe: splint', 'New recipe: torch']);
  });
  it('drops the least important when the queue overflows', () => {
    const q = new ToastQueue({ maxVisible: 1, maxQueue: 2, rules: new ToastQueue().opts.rules });
    q.push({ category: 'warning', title: 'w0' }, 0);
    q.push({ category: 'info', title: 'i1' }, 0);
    q.push({ category: 'warning', title: 'w1' }, 0);
    expect(q.push({ category: 'info', title: 'i2' }, 0)).toBe('dropped');
    expect(q.push({ category: 'achievement', title: 'a1' }, 0)).toBe('queued');
    expect(q.queue.map((t) => t.title)).toEqual(['w1', 'a1']);
  });
});

// A tiny hand-made items.json slice, so the store tests don't depend on the data port.
const RAW: RawItems = {
  backpack: { id: 'backpack', name: 'backpack', weight: 633, volume: 2000, flags: ['BELTED'], armor: [{ covers: ['torso'] }], pocket_data: [{ max_contains_volume: 3000, max_contains_weight: 5000 }] },
  duffelbag: { id: 'duffelbag', name: 'duffel bag', weight: 933, volume: 6000, flags: ['BELTED'], armor: [{ covers: ['torso'] }], pocket_data: [{ max_contains_volume: 6000, max_contains_weight: 8000 }] },
  jeans: { id: 'jeans', name: 'jeans', weight: 600, volume: 2000, armor: [{ covers: ['leg_l', 'leg_r'] }], pocket_data: [{ max_contains_volume: 500, max_contains_weight: 2000 }] },
  hoodie: { id: 'hoodie', name: 'hoodie', weight: 420, volume: 3000, flags: ['OUTER'], armor: [{ covers: ['torso', 'arm_l'] }] },
  tshirt: { id: 'tshirt', name: 't-shirt', weight: 110, volume: 500, armor: [{ covers: ['torso'] }] },
  bat: { id: 'bat', name: 'baseball bat', weight: 940, volume: 1750 },
  machete: { id: 'machete', name: 'machete', weight: 839, volume: 788 },
  nail: { id: 'nail', name: 'nail', weight: 20, volume: 3, count: 1, subtypes: ['AMMO'] },
  granola: { id: 'granola', name: 'granola', weight: 32, volume: 62, subtypes: ['COMESTIBLE'] },
  water_clean: { id: 'water_clean', name: 'clean water', weight: 250, volume: 250, subtypes: ['COMESTIBLE'] },
  '2x4': { id: '2x4', name: 'plank', weight: 2440, volume: 4130 },
};

describe('ui2 mock store', () => {
  const kit = () => buildMockKit(RAW, () => {});
  it('builds the kit, skipping unknown ids', () => {
    const warnings: string[] = [];
    const k = buildMockKit(RAW, (m) => warnings.push(m));
    expect(warnings.length).toBeGreaterThan(5);
    expect(k.store.contents('worn:back')[0].typeId).toBe('backpack');
  });
  it('moves, merges, splits and swaps', () => {
    const { store } = kit();
    const ground = store.contents('ground');
    const nails = ground.find((i) => i.typeId === 'nail')!;
    const bag = store.contents('worn:back')[0];
    const r = store.move(nails.id, insideOf(bag.id), 10);
    expect(r.ok).toBe(true);
    expect(nails.count).toBe(30);
    // A second batch merges into the first.
    store.move(nails.id, insideOf(bag.id), 5);
    expect(store.contents(insideOf(bag.id)).filter((i) => i.typeId === 'nail').map((i) => i.count)).toEqual([15]);
    // Swap: machete into the hands, the bat goes back to the ground.
    const machete = ground.find((i) => i.typeId === 'machete')!;
    const sw = store.move(machete.id, 'worn:wield', 1);
    expect(sw.ok && sw.verdict.kind).toBe('swap');
    expect(store.contents('worn:wield')[0].typeId).toBe('machete');
    expect(store.contents('ground').some((i) => i.typeId === 'bat')).toBe(true);
    // Wrong slot, too big, into itself.
    expect(store.move(machete.id, 'worn:legs', 1)).toMatchObject({ ok: false });
    const plank = store.contents('ground').find((i) => i.typeId === '2x4')!;
    expect(store.move(plank.id, insideOf(bag.id), 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/Too big/) });
    expect(store.move(bag.id, insideOf(bag.id), 1)).toMatchObject({ ok: false });
  });
  it('never lets a bag go inside its own contents', () => {
    const { store } = kit();
    const duffel = store.contents('ground').find((i) => i.typeId === 'duffelbag')!;
    const bag = store.contents('worn:back')[0];
    expect(store.move(bag.id, insideOf(duffel.id), 1).ok).toBe(true);
    expect(store.move(duffel.id, insideOf(bag.id), 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/inside itself/) });
  });
  it('conserves items over thousands of random moves', () => {
    const { store } = kit();
    const before = store.totals();
    let seed = 12345;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    let okMoves = 0;
    for (let step = 0; step < 4000; step++) {
      const all: { id: string; count: number }[] = [];
      store.walk((it) => all.push({ id: it.id, count: it.count }));
      const locs = [...store.rootIds()];
      store.walk((it) => it.capacity && locs.push(insideOf(it.id)));
      const pick = all[Math.floor(rnd() * all.length)];
      if (rnd() < 0.15 && pick.count > 1) {
        store.split(pick.id, 1 + Math.floor(rnd() * (pick.count - 1)));
      } else {
        const to = locs[Math.floor(rnd() * locs.length)];
        const n = 1 + Math.floor(rnd() * pick.count);
        if (store.move(pick.id, to, n).ok) okMoves++;
      }
      expect(store.totals()).toEqual(before);
    }
    expect(okMoves).toBeGreaterThan(500);
    // Ids stay unique.
    const ids: string[] = [];
    store.walk((it) => ids.push(it.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('the kit resolves against the real items.json', () => {
    const raw = JSON.parse(readFileSync('public/data/items.json', 'utf8')) as RawItems;
    const warnings: string[] = [];
    const k = buildMockKit(raw, (m) => warnings.push(m));
    // Lenient: the BN data port may rename a few ids; the showcase just shows fewer items.
    expect(k.typeIds.length).toBeGreaterThan(20);
    // BN items carry `storage`, not pocket_data: the backpack must still be a container
    // with its kit inside (the showcase's backpack window and drag target depend on it).
    const bag = k.store.contents('worn:back')[0];
    expect(bag?.typeId).toBe('backpack');
    expect(bag.capacity?.volume).toBeGreaterThan(0);
    expect(k.store.contents(insideOf(bag.id)).length).toBeGreaterThan(3);
    expect(warnings.filter((w) => /container .* missing/.test(w))).toEqual([]);
  });
});
