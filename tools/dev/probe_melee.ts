// Survivor melee output with a few early weapons against an unarmoured, undodging target:
// hit rate, damage per swing/hit, swing time and DPS (BN melee math in src/game/combat.ts).
//   tsx tools/dev/probe_melee.ts [weapon…]
import { loadNodeData } from '../lib/node_data';
import { Character } from '../../src/game/character';
import { meleeAttack, type MeleeTarget } from '../../src/game/combat';
import { createItem } from '../../src/game/item';
import { Rng } from '../../src/core/rng';

const { game: data } = loadNodeData();
const weapons = process.argv.length > 2 ? process.argv.slice(2) : ['fists', 'knife_chef', 'crowbar', 'bat', 'pipe', 'knife_meat_cleaver'];
for (const w of weapons) {
  const c = new Character(data, { seed: 3 });
  c.msg = () => {};
  if (w !== 'fists') c.inv.wielded = createItem(data, w);
  const rng = new Rng(5);
  let hits = 0, dmg = 0, secs = 0;
  const N = 2000;
  for (let i = 0; i < N; i++) {
    c.stamina = 10000;
    const r = meleeAttack(c, { dodge: 0, armor: { bash: 0, cut: 0, stab: 0 } } as unknown as MeleeTarget, rng, 'z');
    if (r.hit) hits++;
    dmg += r.total;
    secs += r.cooldownSeconds;
  }
  console.log(`${w.padEnd(20)} hit ${((100 * hits) / N).toFixed(0)}%  dmg/swing ${(dmg / N).toFixed(1)}  dmg/hit ${(dmg / Math.max(1, hits)).toFixed(1)}  swing ${(secs / N).toFixed(2)} s  DPS ${(dmg / secs).toFixed(1)}`);
}
