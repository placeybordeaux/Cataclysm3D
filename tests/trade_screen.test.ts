// The trade screen's deal is one moves-API transaction (TradeSession.commit). Property test:
// thousands of seeded random offers — any counts on either side, followers and strangers,
// shopkeeper stock, containers with contents, worn and wielded goods, items that move away
// between building the offer and making the deal (a stale screen) — and after every attempt
// the census of everything involved is unchanged, nothing is reachable twice, and a refused or
// failed deal changes nothing at all. Long soak: TRADE_SEEDS=400 TRADE_STEPS=40.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData } from '../src/data/types';
import { Game } from '../src/game/game';
import type { Input } from '../src/core/input';
import type { Chunk, ChunkGenerator, GameMap } from '../src/world/map';
import { NpcSystem } from '../src/game/npcai';
import type { Npc, NpcData } from '../src/game/npc';
import { Rng } from '../src/core/rng';
import { Dialogue } from '../src/game/talk';
import { createItem, inNewContainer } from '../src/game/item';
import { census, consumeItem, L, moveItem, spawnItem, type Loc } from '../src/game/moves';
import { TradeSession } from '../src/game/trade';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;
let nd: NpcData;
beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'), itemGroups: load('item_groups.json'),
    monsters: load('monsters.json'), monsterGroups: load('monster_groups.json'), recipes: [], misc: load('misc.json'),
  };
  nd = load('npcs.json');
});

class FlatGen implements ChunkGenerator {
  generate(map: GameMap, c: Chunk): void {
    c.ter.fill(c.z === 0 ? map.terrain.index('t_dirt') : c.z > 0 ? map.terrain.index('t_open_air') : map.terrain.index('t_rock'));
    c.empty = false;
  }
}

const GOODS = ['knife_hunting', 'FMCNote', '9mm', 'water_clean', 'bandages', 'can_beans', 'hammer', 'flashlight', 'rock', 'jeans', 'aspirin'];

function setup(seed: number) {
  const input = { held: new Set<string>(), captured: false, mouseButtons: 0, onPress() {}, consumeMouse: () => [0, 0], consumeClicks: () => [] } as unknown as Input;
  const game = new Game(data, seed, input);
  game.map.generator = new FlatGen();
  game.player.x = 12.5;
  game.player.y = 12.5;
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) game.map.chunk(x, y, 0);
  const npcs = new NpcSystem(game, nd, null);
  const rng = new Rng(seed);
  const p = game.player;
  p.inv.wear(createItem(data, 'backpack'), null);
  const n: Npc = rng.oneIn(2) ? npcs.spawn({ template: 'evac_merchant' }, 14, 12, 0)! : npcs.spawn({ cls: 'NC_SCAVENGER' }, 14, 12, 0)!;
  if (rng.oneIn(3)) new Dialogue(npcs, n).effect('follow');
  n.op.trust = rng.int(-5, 10);
  const give = (id: string): ReturnType<typeof createItem> | null => {
    const def = data.items[id];
    if (!def) return null;
    return createItem(data, id, def.stack_size ? { count: rng.int(1, 30) } : undefined);
  };
  for (let i = 0; i < 6; i++) {
    const it = give(rng.pick(GOODS));
    if (it) p.inv.giveNew(it);
    const st = give(rng.pick(GOODS));
    if (st) spawnItem(st, L.stock(n), { force: true, quiet: true });
    const ni = give(rng.pick(GOODS));
    if (ni) n.inv.giveNew(ni);
  }
  // A bag of rounds: sold whole, never its contents separately.
  const bag = inNewContainer(data, createItem(data, '9mm', { count: 25 }), 'bag_canvas').container;
  if (rng.oneIn(2)) p.inv.wield(bag, null);
  else spawnItem(bag, L.stock(n), { force: true, quiet: true });
  const ground = L.ground(game.map, p.tileX, p.tileY, p.z);
  const side = L.ground(game.map, p.tileX + 1, p.tileY, p.z);
  const scope: Loc[] = [L.hands(p), L.worn(p), L.inv(p), L.hands(n), L.worn(n), L.inv(n), L.stock(n), ground, side];
  return { game, npcs, n, rng, scope, p, side };
}

describe('trade screen deal (moves-API transaction)', () => {
  const SEEDS = Number(process.env.TRADE_SEEDS ?? 60);
  const STEPS = Number(process.env.TRADE_STEPS ?? 25);
  it(`conserves every item over ${SEEDS}×${STEPS} random offers`, () => {
    let deals = 0, refused = 0, stale = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { game, n, rng, scope, p, side } = setup(seed);
      for (let step = 0; step < STEPS; step++) {
        const s = new TradeSession(game.data, nd, p, n, rng.oneIn(6) ? rng.int(1, 500) : 0);
        // Offer and ask: random counts, as drags with the wheel would set them.
        for (const e of [...s.yours, ...s.theirs]) if (rng.oneIn(3)) s.setCount(e, rng.int(0, e.max));
        // Sometimes the world moves under the open screen: something offered is used up or dropped.
        if (rng.oneIn(5)) {
          const e = rng.pick([...s.yours, ...s.theirs].filter((x) => x.count > 0) as typeof s.yours);
          if (e) {
            const it = e.items[0];
            if (rng.oneIn(2)) consumeItem(it, e.loc, it.countByCharges ? 1 : undefined);
            else {
              // a system move, like a follower putting it down
              moveItem(it, e.loc, side, { force: true, quiet: true });
            }
            stale++;
          }
        }
        const before = census(scope).counts;
        const snapshot = JSON.stringify([p.inv.toJSON(), n.inv.toJSON(), n.stock.map((x) => x.toJSON()), n.op]);
        const accept = s.canAccept().ok;
        const ok = s.commit();
        const after = census(scope);
        expect(after.aliased, `seed ${seed} step ${step}: aliased`).toEqual([]);
        expect(after.counts, `seed ${seed} step ${step}: census`).toEqual(before);
        if (!ok) {
          refused++;
          expect(JSON.stringify([p.inv.toJSON(), n.inv.toJSON(), n.stock.map((x) => x.toJSON()), n.op]), `seed ${seed} step ${step}: a failed deal changed something`).toBe(snapshot);
        } else {
          expect(accept).toBe(true);
          deals++;
        }
      }
    }
    // The run must exercise both outcomes, or it proves nothing.
    expect(deals).toBeGreaterThan(SEEDS);
    expect(refused).toBeGreaterThan(0);
    expect(stale).toBeGreaterThan(0);
  }, 10 * 60_000);
});
