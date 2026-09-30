// Curtained windows (src/game/curtains.ts, BN iexamine::curtains): curtains and window are
// separate, correctly named actions; transitions follow BN's terrain chain; drawn curtains block
// sight and daylight; outside you can only pry or smash; peek and tear-down; the renderer's
// modelled curtains agree with the data for every curtained terrain.
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GameData, TerrainDef } from '../src/data/types';
import { Game } from '../src/game/game';
import { TestGenerator } from '../src/world/testgen';
import { createItem } from '../src/game/item';
import { interact, interactionsAt, patchInteractUi } from '../src/game/interact';
import { curtainMoves, curtainsClosed, hasCurtains, PEEK_SECONDS } from '../src/game/curtains';
import { lineOfSight, naturalLightAt } from '../src/game/vision';
import { windowState } from '../src/render/furniture/openings';
import { hasFlag } from '../src/world/registry';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
let data: GameData;

beforeAll(() => {
  data = {
    terrain: load('terrain.json'), furniture: load('furniture.json'), items: load('items.json'),
    itemGroups: load('item_groups.json'), monsters: {}, monsterGroups: {}, recipes: [], misc: load('misc.json'),
  };
});

function makeGame(): { game: Game; log: string[] } {
  const input = { held: new Set<string>(), captured: false, onPress() {}, capture: () => () => {}, consumeMouse: () => [0, 0], consumeClicks: () => [] };
  const game = new Game(data, 7, input as never);
  game.map.generator = new TestGenerator();
  const log: string[] = [];
  game.events.on('message', (m) => log.push(m.text));
  return { game, log };
}
const place = (game: Game, x: number, y: number) => {
  game.player.x = x + 0.5;
  game.player.y = y + 0.5;
  game.player.z = 0;
};
const ids = (game: Game, x: number, y: number) => interactionsAt(game, x, y, 0).map((i) => i.id);
const run = (game: Game, x: number, y: number, id: string) => {
  const i = interactionsAt(game, x, y, 0).find((e) => e.id === id);
  if (!i) throw new Error(`no ${id} at ${x},${y}: ${ids(game, x, y)}`);
  i.run();
};
const finish = (game: Game) => {
  for (let i = 0; i < 30 * 60 && game.activities.current; i++) game.tick(1 / 30);
};

// The one-room test house: t_window_domestic (curtains open, window shut) in the west wall.
const WX = 4, WY = 9;

describe('curtains: data', () => {
  it('every curtained terrain: curtain steps change TRANSPARENT, window steps keep it', () => {
    const all = Object.values(data.terrain as Record<string, TerrainDef>).filter(hasCurtains);
    expect(all.length).toBeGreaterThan(30);
    const { game } = makeGame();
    const bad: string[] = [];
    for (const t of all) {
      for (const m of curtainMoves(game, t)) {
        const to = data.terrain[m.to] as TerrainDef;
        if ((hasFlag(t, 'TRANSPARENT') !== hasFlag(to, 'TRANSPARENT')) !== (m.kind === 'curtains')) bad.push(`${t.id} -> ${m.to}`);
      }
      // Drawn curtains can always be opened again from inside (BN: `open` on every closed one).
      if (curtainsClosed(t) && !curtainMoves(game, t).some((m) => m.kind === 'curtains' && m.action === 'open')) bad.push(`${t.id}: no way to open`);
    }
    expect(bad).toEqual([]);
  });

  it('the house window chain is BN\'s: curtains <-> window shut <-> window open', () => {
    const { game } = makeGame();
    const d = data.terrain as Record<string, TerrainDef>;
    expect(curtainMoves(game, d.t_curtains)).toEqual([{ kind: 'curtains', action: 'open', to: 't_window_domestic' }]);
    expect(curtainMoves(game, d.t_window_domestic)).toEqual([
      { kind: 'curtains', action: 'close', to: 't_curtains' },
      { kind: 'window', action: 'open', to: 't_window_open' },
    ]);
    expect(curtainMoves(game, d.t_window_open)).toEqual([{ kind: 'window', action: 'close', to: 't_window_domestic' }]);
  });

  it('the modelled window draws its curtains closed exactly when the data blocks sight', () => {
    const bad: string[] = [];
    for (const t of Object.values(data.terrain as Record<string, TerrainDef>).filter(hasCurtains)) {
      const st = windowState(t.id);
      if (t.id.includes('taped')) continue; // taped panes: tape over the glass, curtains beside it
      if (st.curtains !== (curtainsClosed(t) ? 'closed' : 'open')) bad.push(`${t.id}: ${st.curtains}`);
    }
    expect(bad).toEqual([]);
  });
});

describe('curtains: from inside', () => {
  it('offers the curtains and the window separately, named for what they do', () => {
    const { game } = makeGame();
    place(game, WX + 1, WY);
    const list = interactionsAt(game, WX, WY, 0);
    expect(list.map((i) => i.label)).toEqual(['Close the curtains', 'Open the window', 'Tear down the curtains']);
  });

  it('draw the curtains: sight and daylight blocked; open them again: restored', () => {
    const { game } = makeGame();
    game.clock.seconds = Math.floor(game.clock.seconds / 86400) * 86400 + 12 * 3600;
    place(game, WX + 1, WY);
    const lit = naturalLightAt(game, WX + 1, WY, 0);
    expect(lineOfSight(game.map, WX - 2, WY, WX + 2, WY, 0)).toBe(true);
    run(game, WX, WY, 'curtains_close');
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_curtains');
    expect(game.map.opaque(WX, WY, 0)).toBe(true);
    expect(lineOfSight(game.map, WX - 2, WY, WX + 2, WY, 0)).toBe(false);
    // no 30 s stale daylight cache: the room is darker at once
    expect(naturalLightAt(game, WX + 1, WY, 0)).toBeLessThan(lit);
    expect(ids(game, WX, WY)).toEqual(['curtains_open', 'peek', 'tear_curtains']);
    run(game, WX, WY, 'curtains_open');
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_window_domestic');
    expect(game.map.opaque(WX, WY, 0)).toBe(false);
    expect(naturalLightAt(game, WX + 1, WY, 0)).toBe(lit);
  });

  it('opens and shuts the window itself (curtains stay open)', () => {
    const { game } = makeGame();
    place(game, WX + 1, WY);
    run(game, WX, WY, 'window_open');
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_window_open');
    expect(ids(game, WX, WY)).toEqual(['window_close', 'tear_curtains']);
    run(game, WX, WY, 'window_close');
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_window_domestic');
  });

  it('`e` on a curtained window asks what to do instead of opening the window', () => {
    const { game } = makeGame();
    place(game, WX + 1, WY);
    let menu: string[] | null = null;
    patchInteractUi({ menu: (_title, entries) => void (menu = entries.map((e) => e.label)) });
    interact(game, { x: WX, y: WY, z: 0, dist: 1 });
    patchInteractUi({ menu: undefined });
    expect(menu).toEqual(['Close the curtains', 'Open the window', 'Tear down the curtains']);
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_window_domestic');
  });

  it('peek parts drawn curtains for a moment, then they fall back', () => {
    const { game, log } = makeGame();
    place(game, WX + 1, WY);
    run(game, WX, WY, 'curtains_close');
    run(game, WX, WY, 'peek');
    expect(log.at(-1)).toMatch(/peek through the curtains/);
    expect(game.map.opaque(WX, WY, 0)).toBe(false);
    expect(game.activities.current?.spec.duration).toBe(PEEK_SECONDS);
    finish(game);
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_curtains');
  });

  it('tearing them down leaves a bare window and BN\'s materials', () => {
    const { game } = makeGame();
    place(game, WX + 1, WY);
    run(game, WX, WY, 'tear_curtains');
    finish(game);
    expect(game.map.terAt(WX, WY, 0).id).toBe('t_window_no_curtains');
    const here = game.map.itemsAt(WX + 1, WY, 0).map((i) => (i as { typeId: string }).typeId).sort();
    expect(here).toEqual(['nail', 'sheet', 'sheet', 'stick', 'string_36']);
  });
});

describe('curtains: from outside', () => {
  it('no curtains or latch from outside: examine, or pry with a crowbar', () => {
    const { game, log } = makeGame();
    place(game, WX - 1, WY);
    expect(ids(game, WX, WY)).toEqual(['examine']);
    run(game, WX, WY, 'examine');
    expect(log.at(-1)).toMatch(/latches on the inside/);
    // drawn curtains: you can't see in
    game.map.setTer(WX, WY, 0, 't_curtains');
    run(game, WX, WY, 'examine');
    expect(log.at(-1)).toMatch(/curtains are drawn/);
    game.player.inv.wield(createItem(game.data, 'crowbar'), null);
    expect(ids(game, WX, WY)).toEqual(['pry']);
  });

  it('prying (BN iuse::crowbar) opens the window or breaks the glass, never leaves it as it was forever', () => {
    let opened = 0, broke = 0;
    for (let seed = 0; seed < 12; seed++) {
      const { game } = makeGame();
      game.player.rng = new (game.player.rng.constructor as new (s: number) => typeof game.player.rng)(seed + 1);
      place(game, WX - 1, WY);
      game.player.inv.wield(createItem(game.data, 'crowbar'), null);
      for (let i = 0; i < 10 && game.map.terAt(WX, WY, 0).id === 't_window_domestic'; i++) {
        run(game, WX, WY, 'pry');
        finish(game);
      }
      const id = game.map.terAt(WX, WY, 0).id;
      if (id === 't_window_open') opened++;
      else if (id === 't_window_frame_domestic') broke++;
    }
    expect(opened + broke).toBe(12);
    expect(opened).toBeGreaterThan(0);
  });
});
