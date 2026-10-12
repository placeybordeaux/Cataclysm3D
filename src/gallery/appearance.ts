import { hashSeed, hashString } from '../core/rng';
import type { DebugApi } from '../debug';
import { setAppearanceSeed } from '../render/appearanceSeed';

/** Stable variants per world, scene and spawn order; leave gameplay UIDs untouched. */
export async function withSceneAppearance<T>(api: DebugApi, scene: string, run: () => Promise<T>): Promise<T> {
  const oldMonster = api.spawnMonster;
  const oldNpc = api.spawnNpc;
  let monsterIndex = 0, npcIndex = 0;
  api.spawnMonster = (...args: unknown[]) => {
    const uid = oldMonster(...args);
    const m = api.monsterSystem?.all.find((c: { uid: number }) => c.uid === uid);
    if (m) setAppearanceSeed(m, hashSeed(api.game.seed, hashString(scene), 0x6d6f6e, monsterIndex++));
    return uid;
  };
  api.spawnNpc = (...args: unknown[]) => {
    const uid = oldNpc(...args);
    const n = api.npcSystem?.npcs.find((c: { uid: number }) => c.uid === uid);
    if (n) setAppearanceSeed(n, hashSeed(api.game.seed, hashString(scene), 0x6e7063, npcIndex++));
    return uid;
  };
  try { return await run(); }
  finally { api.spawnMonster = oldMonster; api.spawnNpc = oldNpc; }
}
