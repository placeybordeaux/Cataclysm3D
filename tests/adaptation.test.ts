// The wave-3 "TV adaptation" pass (docs/ADAPTATION.md): adapted tips, merged needs, activity
// ring wording.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adaptedTips, PORT_TIPS, sleepSpotText, unknownTips } from '../src/ui/tips_adapted';
import { summaryTitle } from '../src/ui2/loot/summary';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { createItem, fromSpawned } from '../src/game/item';
import { expandItemGroup } from '../src/data/itemgroups';
import { adaptEatRows, eatLabel } from '../src/ui2/bn/eat_rows';
import { tirednessText } from '../src/ui/rest_ui';
import { defLight, itemLight } from '../src/game/vision';
import { EFFECTS_SHOWN_AS_NEEDS, needStates, runDay, type NeedSource } from '../src/ui/hud_logic';
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
    expect(tips.some((t) => /Tap \[`\] to pause/.test(t))).toBe(true);
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

describe('wording', () => {
  it('the sleep menu says how the spot feels and whether you are tired', () => {
    expect(sleepSpotText(0, 'wooden floor', '')).toEqual({ spot: 'wooden floor, hard: a bed or sleeping bag would help', good: false, note: "You aren't tired yet: you may just lie awake." });
    expect(sleepSpotText(2, 'straw bed', 'Tired').spot).toBe('straw bed, a little hard: a mattress, a proper bed or a sleeping bag would be better');
    expect(sleepSpotText(5, 'bed', 'Tired')).toEqual({ spot: 'bed, comfortable', good: true, note: '' });
    expect(sleepSpotText(-999, 'deep water', 'Tired').spot).toBe("deep water, you can't sleep here");
  });

  it('take-all counts what it left behind in things, like what it took', () => {
    const r = { taken: [{ name: 'emergency jackets', count: 2 }], left: [{ name: 'emergency jackets', count: 8, reason: 'no room' }] };
    expect(summaryTitle(r as never)).toBe('Took 2 emergency jackets. 8 left behind:');
  });
});

// --- round 2: eat picker rows, rest window text, BN item light --------------------------------

const load = (f: string) => JSON.parse(readFileSync(new URL(`../public/data/${f}`, import.meta.url), 'utf8'));
const realData: GameData = { terrain: {}, furniture: {}, items: load('items.json'), itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json') } as never;

describe('eat picker: one row per thing, in words', () => {
  const [bottle] = expandItemGroup(realData, { subtype: 'collection', entries: [{ item: 'water_clean' }] } as never, new Rng(1)).flatMap((s) => fromSpawned(realData, s));
  const water = bottle.contents[0];

  it('a bottle of water is named after the water, with servings, not "(2/2)"', () => {
    expect(bottle.name()).toMatch(/\(\d+\/\d+\)$/);
    expect(eatLabel(bottle)).toBe(`clean water (plastic bottle) · ${water.charges} servings`);
    expect(eatLabel(bottle)).not.toMatch(/\/\d/);
  });

  it('the water inside a listed bottle is not listed again; loose food still is', () => {
    const jerky = createItem(realData, 'jerky', { charges: 3 });
    const rows = adaptEatRows([
      { row: 'bottle', item: bottle, host: null },
      { row: 'water', item: water, host: bottle },
      { row: 'jerky', item: jerky, host: null },
    ]);
    expect(rows.map((r) => r.row)).toEqual(['bottle', 'jerky']);
    expect(rows[1].label).toBe('meat jerky · 3 servings');
  });

  it('a second, stacked bottle of the same water folds into the first row with all the servings', () => {
    const [bottle2] = expandItemGroup(realData, { subtype: 'collection', entries: [{ item: 'water_clean' }] } as never, new Rng(2)).flatMap((s) => fromSpawned(realData, s));
    const water2 = bottle2.contents[0];
    // The stacked view lists bottle 1 only; bottle 2's water appears with bottle 2 as its host.
    const rows = adaptEatRows([
      { row: 'bottle', item: bottle, host: null },
      { row: 'water', item: water, host: bottle },
      { row: 'water2', item: water2, host: bottle2 },
    ]);
    expect(rows.map((r) => r.row)).toEqual(['bottle']);
    expect(rows[0].label).toBe(`clean water (plastic bottles) · ${water.charges + water2.charges} servings`);
  });
});

describe('credits', () => {
  it('carry the required attributions, taken from the licence files', async () => {
    const { CREDITS } = await import('../src/ui/credits');
    const text = CREDITS.map((c) => [c.title, ...c.lines, ...(c.links ?? []).flat()].join(' ')).join('\n');
    expect(text).toMatch(/fan-made/);
    expect(text).toMatch(/Bright Nights[\s\S]*CC BY-SA 3\.0/);
    expect(text).toMatch(/UltimateCataclysm[\s\S]*I-am-Erk/);
    expect(text).toMatch(/CO\.AG/);
    expect(text).toMatch(/SIL Open Font License/);
    expect(text).toMatch(/GNU Unifont[\s\S]*font embedding exception/);
    // Facts the credits state must still be what the shipped licence files say.
    const ofl = readFileSync(new URL('../public/fonts/LICENSE-OFL-Terminus-Font.txt', import.meta.url), 'utf8');
    expect(ofl).toMatch(/Copyright \(C\) 2020 Dimitar Toshkov Zhekov/);
    expect(ofl).toMatch(/2011-2023 Tilman Blumenbach/);
    const audio = readFileSync(new URL('../public/audio/CREDITS.md', import.meta.url), 'utf8');
    expect(audio).toMatch(/CC-BY-SA 4\.0/);
    expect(audio).toMatch(/fine to use my music as long as credit is given/);
  });
});

describe('weather messages', () => {
  it('only changes you would notice, none while time is sped up; all of them on request', async () => {
    const { weatherMessageFilter, weatherMessages } = await import('../src/game/weather');
    expect(weatherMessageFilter('drizzle', 'light_drizzle', false)).toBe(false);
    expect(weatherMessageFilter('cloudy', 'rain', false)).toBe(true);
    expect(weatherMessageFilter('cloudy', 'rain', true)).toBe(false);
    weatherMessages.all = true;
    expect(weatherMessageFilter('drizzle', 'light_drizzle', true)).toBe(true);
    weatherMessages.all = false;
  });
});

describe('day counter', () => {
  it('turns over at midnight, like the clock', () => {
    const start = 8 * 3600;
    expect(runDay(start, start)).toBe(1);
    expect(runDay(23.9 * 3600, start)).toBe(1);
    expect(runDay(86400 + 5.5 * 3600, start)).toBe(2);
  });
});

describe('rest window needs warning', () => {
  it('warns when very hungry or thirsty, not when merely peckish', async () => {
    const { restNeedsWarning } = await import('../src/ui/rest_ui');
    expect(restNeedsWarning('Hungry', 'Thirsty')).toBeNull();
    expect(restNeedsWarning('Very Hungry', 'Very Thirsty')).toMatch(/hungry and thirsty: drink/);
    expect(restNeedsWarning('Famished', '')).toMatch(/hungry: eat/);
  });
});

describe('rest window', () => {
  it('says what tiredness means for sleeping now', () => {
    expect(tirednessText('').tone).toBe('dim');
    expect(tirednessText('').text).toMatch(/lie awake/);
    expect(tirednessText('Tired').text).toMatch(/fall asleep soon/);
    expect(tirednessText('Dead Tired').tone).toBe('warn');
  });
});

describe('BN item light (light_emission)', () => {
  it('a flashlight turned on shines; turned off it does not', () => {
    expect(defLight(realData.items.flashlight_on)).toBeGreaterThan(0);
    expect(itemLight(createItem(realData, 'flashlight_on', { ammo: 'default' }))).toBeGreaterThan(0);
    expect(itemLight(createItem(realData, 'flashlight', { ammo: 'default' }))).toBe(0);
  });
  it('the smartphone flashlight app is a light too', () => {
    expect(defLight(realData.items.smart_phone_flashlight)).toBe(20);
  });
});
