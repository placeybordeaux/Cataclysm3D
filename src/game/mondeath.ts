import { monsterName } from '../data/index';
import { warnOnce } from '../data/warn';
import { turnsToEffectSeconds, type Monster } from './monster';
import type { CorpseRecord, MonsterSystem } from './monai';
import { createItem } from './item';
import { spawnOnGround } from './moves';
import { detonate, legacyBlast } from './blast';

// Bright Nights death functions (mondeath.cpp). A MONSTER's `death_function` is a list of
// named mdeath functions run in order when it dies (default ["NORMAL"]); only NORMAL leaves
// a corpse, so a boomer (["BOOMER"]) bursts without one and a robot (["BROKEN"]) leaves its
// "broken_<id>" item. Returns the corpse placed, if any.

/** BN mdeath::normal pulverisation: 2.5 × overflow / max hp > 5 and overflow > max hp. */
export function overflowDamage(m: Monster): { overflow: number; corpseDamage: number; pulverized: boolean } {
  const maxHp = Math.max(1, m.hpMax);
  const overflow = Math.max(0, -m.hp);
  const corpseDamage = (2.5 * overflow) / maxHp;
  return { overflow, corpseDamage, pulverized: corpseDamage > 5 && overflow > maxHp };
}

/** Death functions handled without a warning (their effects are cosmetic or not modelled). */
const QUIET = new Set(['FUNGUS', 'FUNGALBURST', 'KILL_VINES', 'VINE_CUT', 'TRIFFID_HEART', 'AMIGARA', 'GAMEOVER', 'KILL_BREATHERS', 'DARKMAN', 'JABBERWOCKY', 'RATKING', 'FOCUSEDBEAM', 'CONFLAGRATION', 'FIREBALL', 'DETONATE', 'JACKSON', 'BRAINBLOB', 'PREG_ROACH']);

export function runDeathFunctions(sys: MonsterSystem, m: Monster): CorpseRecord | null {
  const def = m.type;
  const list = def.death_function?.length ? def.death_function : ['NORMAL'];
  const tx = m.tileX, ty = m.tileY;
  const seen = sys.playerSees(m);
  const name = m.name ?? monsterName(def);
  const say = (tmpl: string, color?: string) => {
    if (seen) sys.message(tmpl.replace('%s', name), color);
  };
  const dies = list.length;
  let corpse: CorpseRecord | null = null;
  const explodeSound = () => sys.emitSound(m.x, m.y, m.z, 80, `a ${name} explode!`, m, 'explosion');
  for (const fn of list) {
    switch (fn) {
      case 'NORMAL': {
        const o = overflowDamage(m);
        say(m.name ? '%s dies!' : 'The %s dies!', 'c_light_green');
        if (!o.pulverized) corpse = sys.dropCorpse(m, Math.floor(Math.min(4, o.corpseDamage) * 1000));
        if (!list.includes('SPLATTER')) splatter(sys, m, false);
        break;
      }
      case 'SPLATTER':
        splatter(sys, m, true);
        break;
      case 'BOOMER':
      case 'BOOMER_GLOW': {
        explodeSound();
        const p = sys.game.player;
        // rl_dist == 1: only a survivor right next to it gets the bile in the eyes.
        if (p.z === m.z && Math.max(Math.abs(p.tileX - tx), Math.abs(p.tileY - ty)) === 1) {
          p.addEffect('boomered', turnsToEffectSeconds(24));
          if (fn === 'BOOMER_GLOW') p.addEffect('glowing', 4 * 60);
          sys.message("You're covered in bile!", 'c_red');
        }
        // propagate_field(pos, fd_bile, 15, 1): fifteen intensity-1 bile tiles spreading out.
        propagate(sys, tx, ty, m.z, 'fd_bile', 15);
        break;
      }
      case 'ACID':
        say(dies === 1 ? "The %s's body dissolves into acid." : "The %s's body leaks acid.");
        sys.addField(tx, ty, m.z, 'fd_acid', 3);
        break;
      case 'MELT':
        say('The %s melts away.');
        break;
      case 'DISINTEGRATE':
        say('The %s disintegrates!');
        break;
      case 'DISAPPEAR':
        say('The %s disappears.');
        break;
      case 'BROKEN':
      case 'BROKEN_AMMO': {
        if (fn === 'BROKEN_AMMO') say("The %s's interior compartment sizzles with destructive energy.");
        const id = 'broken_' + def.id.replace(/^mon_/, '');
        if (!sys.game.data.items[id]) {
          warnOnce('item', id);
          break;
        }
        const it = createItem(sys.game.data, id);
        it.damage = Math.floor(Math.min(4, overflowDamage(m).corpseDamage) * 1000);
        spawnOnGround(sys.game.map, tx, ty, m.z, it);
        break;
      }
      case 'EXPLODE': {
        // mdeath::explode: explosion_handler::explosion(pos, &z, size) with the legacy power
        // for its size (tiny 75, small 150, medium 225, large 300, huge 375; distance factor
        // 0.8), by explosion.cpp's rules (blast.ts). The dead monster isn't hurt by its own blast.
        const power = ({ tiny: 75, small: 150, medium: 225, large: 300, huge: 375 } as Record<string, number>)[m.size] ?? 150;
        detonate(sys.game, sys, m.x, m.y, m.z, legacyBlast(power), m);
        break;
      }
      case 'SMOKEBURST':
        explodeSound();
        propagate(sys, tx, ty, m.z, 'fd_smoke', 12);
        break;
      case 'GAS':
        explodeSound();
        propagate(sys, tx, ty, m.z, 'fd_toxic_gas', 12);
        break;
      case 'WORM':
      case 'BLOBSPLIT': {
        const child = fn === 'WORM' ? 'mon_halfworm' : 'mon_blob_small';
        say(fn === 'WORM' ? (dies === 1 ? 'The %s splits in two!' : "Two worms crawl out of the %s's corpse.") : 'The %s splits in two!');
        for (let i = 0; i < 2; i++) sys.spawnById(child, m.x + (i ? 0.6 : -0.6), m.y, m.z);
        break;
      }
      default:
        if (!QUIET.has(fn)) warnOnce('death_function', fn);
    }
  }
  return corpse;
}

/** mdeath::splatter: gibs and blood around the body, more when pulverized. */
function splatter(sys: MonsterSystem, m: Monster, forced: boolean): void {
  if (m.has('NOGIB')) return;
  const o = overflowDamage(m);
  const pulverized = forced || o.pulverized;
  const blood = sys.bloodType(m.type);
  const gib = blood === 'fd_blood' || !blood ? 'fd_gibs_flesh' : blood;
  let n = Math.min(Math.floor(o.corpseDamage) - 1, 1 + Math.max(1, m.hpMax) / 5);
  if (pulverized && m.size !== 'tiny' && m.size !== 'small') n += m.rng.int(1, 6);
  for (let i = 0; i < n; i++) {
    const dx = m.rng.int(-1, 1), dy = m.rng.int(-1, 1);
    if (blood) sys.addField(m.tileX + dx, m.tileY + dy, m.z, gib, m.rng.int(1, Math.min(3, i + 1)));
  }
}

/** map::propagate_field: `amount` tiles of a field flooding outward from the source. */
function propagate(sys: MonsterSystem, x: number, y: number, z: number, field: string, amount: number): void {
  const seen = new Set<string>([`${x},${y}`]);
  const queue: [number, number][] = [[x, y]];
  let left = amount;
  while (queue.length && left > 0) {
    const [cx, cy] = queue.shift()!;
    if (!sys.grid.passable(cx, cy, z) && (cx !== x || cy !== y)) continue;
    sys.addField(cx, cy, z, field, 1);
    left--;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const k = `${cx + dx},${cy + dy}`;
      if (seen.has(k)) continue;
      seen.add(k);
      queue.push([cx + dx, cy + dy]);
    }
  }
}
