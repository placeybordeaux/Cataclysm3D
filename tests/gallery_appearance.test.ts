import { expect, it } from 'vitest';
import type { DebugApi } from '../src/debug';
import { withSceneAppearance } from '../src/gallery/appearance';
import { appearanceSeed } from '../src/render/appearanceSeed';

it('replays cosmetic variants without replaying gameplay identity and restores spawn APIs after failure', async () => {
  let nextUid = 0;
  const monsters: { uid: number }[] = [], npcs: { uid: number }[] = [];
  const spawnMonster = () => { const m = { uid: ++nextUid }; monsters.push(m); return m.uid; };
  const spawnNpc = () => { const n = { uid: ++nextUid }; npcs.push(n); return n.uid; };
  const api = { game: { seed: 1 }, monsterSystem: { all: monsters }, npcSystem: { npcs }, spawnMonster, spawnNpc } as unknown as DebugApi;
  const fixture = () => withSceneAppearance(api, 'npcs', async () => {
    api.spawnMonster(); api.spawnMonster(); api.spawnNpc();
    return [appearanceSeed(monsters.at(-2)!), appearanceSeed(monsters.at(-1)!), appearanceSeed(npcs.at(-1)!)];
  });
  const first = await fixture();
  await withSceneAppearance(api, 'horde', async () => { api.spawnMonster(); api.spawnNpc(); });
  expect(await fixture()).toEqual(first);
  expect(new Set([...monsters, ...npcs].map(m => m.uid)).size).toBe(8);
  expect(first[0]).not.toBe(first[1]);
  expect(api.spawnMonster).toBe(spawnMonster);
  await expect(withSceneAppearance(api, 'fail', async () => { throw new Error('setup failed'); })).rejects.toThrow('setup failed');
  expect(api.spawnMonster).toBe(spawnMonster);
  expect(api.spawnNpc).toBe(spawnNpc);
  api.spawnMonster();
  expect(appearanceSeed(monsters.at(-1)!)).toBe(monsters.at(-1)!.uid);
});
