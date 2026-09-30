// Adapted rules and helpers from docs/ADAPTATION.md round 6, on real BN data: first beds
// without Fabrication, fire safety, boil water at a fire, freshness on food cards.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GameClock } from '../src/core/time';
import type { GameData } from '../src/data/types';
import { ActivityManager } from '../src/game/activity';
import { adaptationRules, effectiveSkills, effectiveTime } from '../src/game/adaptation_rules';
import { boilableServings } from '../src/game/boil';
import { canBuild, getConstruction } from '../src/game/construction';
import { useFirestarter } from '../src/game/fire';
import { freshnessText } from '../src/game/freshness';
import { createItem, defaultAmmoId, fromSpawned, loadAmmo } from '../src/game/item';
import { PlayerAvatar } from '../src/game/player';
import { GameMap } from '../src/world/map';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const data: GameData = {
  terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
  monsters: {}, monsterGroups: {}, recipes: load('recipes.json'), misc: load('misc.json'),
};

function world(): any {
  const map = new GameMap(1);
  for (const t of Object.values(data.terrain)) map.terrain.add(t);
  for (const f of Object.values(data.furniture)) map.furniture.add(f);
  map.generator = { generate: (m, c) => c.ter.fill(m.terrain.index('t_dirt')) };
  const player = new PlayerAvatar(data, { seed: 7 });
  player.x = 5.5;
  player.y = 5.5;
  player.inv.wear(createItem(data, 'backpack'), null);
  const log: string[] = [];
  player.onMessage = (t) => log.push(t);
  const host: any = { data, map, player, clock: new GameClock(), log, input: { held: new Set(), captured: false }, message: (t: string) => log.push(t) };
  host.activities = new ActivityManager(host);
  host.finish = () => {
    for (let i = 0; i < 100000 && host.activities.current; i++) host.activities.update(host, 1 / 30, 30);
  };
  return host;
}

describe('first beds (easyBeds)', () => {
  it('no Fabrication needed while on, and 1.5x slower; BN gate when off; proper beds keep theirs', () => {
    const h = world();
    const con = getConstruction(data, 'constr_straw_bed')!;
    expect(effectiveSkills(con).every(([, l]) => l === 0)).toBe(true);
    expect(effectiveTime(con)).toBe(con.time * 1.5);
    expect(canBuild(h, con).missing.some((m) => /Fabrication/.test(m))).toBe(false);
    adaptationRules.easyBeds = false;
    try {
      expect(canBuild(h, con).missing.some((m) => /Fabrication/.test(m))).toBe(true);
      expect(effectiveTime(con)).toBe(con.time);
    } finally {
      adaptationRules.easyBeds = true;
    }
    expect(effectiveSkills(getConstruction(data, 'constr_bed')!).some(([, l]) => l > 0)).toBe(true);
  });
});

describe('fire safety (fireWarning)', () => {
  it('next to something that burns: the first try warns, the second lights; off = no warning', () => {
    const h = world();
    const lighter = createItem(data, 'lighter');
    loadAmmo(lighter, defaultAmmoId(data, 'lighter_fluid')!, 10);
    h.player.inv.giveNew(lighter);
    h.map.addItem(5, 4, 0, createItem(data, 'stick_long'));
    h.map.addItem(6, 4, 0, createItem(data, 'stick_long'));
    const ua = lighter.def.use_action as any;
    const first = useFirestarter(h, lighter, ua, 5, 4, 0);
    expect(first.ok).toBe(false);
    expect(first.msg).toMatch(/Fires spread/);
    expect(useFirestarter(h, lighter, ua, 5, 4, 0).ok).toBe(true);
    h.finish();
    expect(h.map.fieldsAt(5, 4, 0).some((f: { type: string }) => f.type === 'fd_fire')).toBe(true);
    adaptationRules.fireWarning = false;
    try {
      h.map.addItem(4, 6, 0, createItem(data, 'stick_long'));
      h.map.addItem(3, 6, 0, createItem(data, 'stick_long'));
      expect(useFirestarter(h, lighter, ua, 4, 6, 0).ok).toBe(true);
    } finally {
      adaptationRules.fireWarning = true;
    }
  });
});

describe('boil water at a fire', () => {
  it('as many servings as the dirty water, with a pot and a fire in reach', () => {
    const h = world();
    h.player.inv.giveNew(createItem(data, 'pot'));
    for (const it of fromSpawned(data, { id: 'water', count: 1, charges: 2 } as any)) h.player.inv.giveNew(it);
    expect(boilableServings(h)).toBe(0);
    h.map.addField(6, 6, 0, 'fd_fire', 1);
    expect(boilableServings(h)).toBe(2);
  });
});

describe('freshness on food cards', () => {
  it('how long it keeps; rotten says so; non-food says nothing', () => {
    const bread = createItem(data, 'bread');
    expect(freshnessText(bread)).toMatch(/^Fresh: about \d+ (days|hours) at room temperature, .* in a fridge/);
    bread.rot = bread.spoilTime() * 2;
    expect(freshnessText(bread)).toMatch(/Rotten/);
    expect(freshnessText(createItem(data, 'rock'))).toBeNull();
  });
});
