// The wave-3 "TV adaptation" pass (docs/ADAPTATION.md): adapted tips, merged needs, activity
// ring wording.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptedTips, PORT_TIPS, unknownTips } from '../src/ui/tips_adapted';
import { EFFECTS_SHOWN_AS_NEEDS, needStates, type NeedSource } from '../src/ui/hud_logic';
import { ringText } from '../src/ui/activity_ring';

const bnTips: string[] = JSON.parse(readFileSync(new URL('../public/data/ui.json', import.meta.url), 'utf8')).tips;
const label = (id: string) => ({ tactical_pause: '`', interact: 'E' })[id] ?? `?${id}`;

describe('adapted tips', () => {
  it('every BN tip has been reviewed (kept, rewritten or dropped)', () => {
    expect(unknownTips(bnTips)).toEqual([]);
  });

  it('says nothing about features this port lacks, and names real keys', () => {
    const tips = adaptedTips(bnTips, label, 'adapted');
    expect(tips.length).toBeGreaterThan(40);
    const banned = /safe mode|helicopter|prone|firewood source|worlds can be made|keybindings menu|vending|peeking|mutagen|APC|shopping cart/i;
    expect(tips.filter((t) => banned.test(t))).toEqual([]);
    expect(tips.some((t) => /Tap ` to pause/.test(t))).toBe(true);
    expect(tips.filter((t) => /\{key:|\?[a-z_]+/.test(t))).toEqual([]);
    for (const t of PORT_TIPS) expect(t.length).toBeLessThan(140);
  });

  it('the originals stay one option away', () => {
    expect(adaptedTips(bnTips, label, 'original')).toEqual(bnTips);
  });
});

const survivor = (hunger: string, bloated: boolean): NeedSource => ({
  hungerState: () => hunger,
  thirstDescription: () => '',
  sleepinessDescription: () => '',
  bodyTempDescription: () => 'Comfortable',
  perceivedPain: () => 0,
  painDescription: () => 'No pain',
  morale: { level: () => 0 },
  inv: { weightCarried: () => 0, weightCapacity: () => 40000 },
  effects: { has: (id: string) => bloated && id === 'bloated' },
});
const keys = (id: string) => ({ eat: 'E' })[id] ?? '?';

describe('hunger + bloated read as one state', () => {
  it('Famished with a full stomach is one explained label, not two contradicting chips', () => {
    const h = needStates(survivor('Famished', true), keys).find((n) => n.id === 'hunger')!;
    expect(h.label).toBe('Full, still famished');
    expect(h.level).toBe(1);
    expect(h.tip).toMatch(/stomach is full/);
    expect(h.tip).toMatch(/reserves are low/);
    expect(h.advice).toMatch(/\[E\]/);
    expect(EFFECTS_SHOWN_AS_NEEDS.has('bloated')).toBe(true);
  });

  it('a full stomach on a fed survivor says "Full" and not to eat more', () => {
    const h = needStates(survivor('Sated', true), keys).find((n) => n.id === 'hunger')!;
    expect(h).toMatchObject({ level: 0, label: 'Full', good: false });
    expect(h.advice).toMatch(/Stop eating/);
  });

  it('nothing changes without the effect', () => {
    const h = needStates(survivor('Famished', false), keys).find((n) => n.id === 'hunger')!;
    expect(h).toMatchObject({ level: 3, label: 'Famished' });
  });
});

describe('activity ring text', () => {
  it('work says stand still; waiting and sleeping just say how to stop', () => {
    expect(ringText({ spec: { name: 'lighting the fire' } })).toEqual({ title: 'Lighting the fire', hint: 'stand still · moving stops it' });
    expect(ringText({ spec: { name: 'waiting' } }).hint).toBe('move to stop');
    expect(ringText({ spec: { name: 'sleeping', kind: 'sleep' } }).hint).toBe('move to stop');
  });
});
