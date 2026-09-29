import type { Game } from './game';
import type { MonsterSystem } from './monai';
import { addField } from './fields';
import { bash } from './bash';
import { emitSound } from './sound';
import { selectBodyPart } from './combat';
import { warnOnce } from '../data/warn';

// Explosions from ammo effects (EXPLOSIVE, EXPLOSIVE_SMALL, NAPALM…): an approximation of
// explosion_handler::explosion. CDDA simulates a blast wave over the map; here the blast is a
// disc of radius ≈ cbrt(power) tiles (1..8) whose bash damage falls off with distance by the
// ammo's distance_factor (power/10 at the centre), with smoke (or fire for "fire" blasts) and a
// terrain bash at the centre. Loud: sound volume = power (capped 180, a grenade is heard far).

export interface ExplosionResult {
  radius: number;
  hitMonsters: number;
  playerDamage: number;
}

export function explode(game: Game, sys: MonsterSystem | null, x: number, y: number, z: number, power: number, factor = 0.75, fire = false): ExplosionResult {
  const radius = Math.max(1, Math.min(8, Math.round(Math.cbrt(power))));
  const base = power / 10;
  const dmgAt = (d: number) => base * Math.pow(factor, d);
  const tx = Math.floor(x), ty = Math.floor(y);
  emitSound(game, { x: tx, y: ty, z }, Math.min(180, power), 'a huge explosion!', { category: 'combat' });
  game.message('Kaboom!', 'c_red');
  let hitMonsters = 0;
  for (const m of sys?.monstersNear(x, y, z, radius) ?? []) {
    const d = Math.hypot(m.x - x, m.y - y);
    const dmg = Math.round(dmgAt(d));
    if (dmg <= 0) continue;
    sys!.hurt(m, dmg, 'player');
    if (!m.dead) m.addEffect('stunned', 0.5);
    hitMonsters++;
  }
  const p = game.player;
  let playerDamage = 0;
  const pd = Math.hypot(p.x - x, p.y - y);
  if (p.z === z && pd <= radius && !p.dead) {
    const dmg = Math.round(dmgAt(pd));
    if (dmg > 0) {
      const bp = selectBodyPart(p.rng);
      const absorbed = p.inv.absorbHit(bp, [{ type: 'bash', amount: dmg }], p.rng);
      playerDamage = p.takeHit(bp, absorbed).damage;
      game.message(`You're caught in the explosion!`, 'c_red');
      game.events.emit('playerHurt', { amount: playerDamage, bp });
    }
  }
  const field = fire ? 'fd_fire' : 'fd_smoke';
  for (let dy = -radius; dy <= radius; dy++)
    for (let dx = -radius; dx <= radius; dx++) {
      const d = Math.hypot(dx, dy);
      if (d > radius) continue;
      if (d <= radius / 2 || p.rng.oneIn(2)) {
        try {
          addField(game, tx + dx, ty + dy, z, field, d < 1.5 ? 3 : d < radius / 2 ? 2 : 1);
        } catch {
          warnOnce('field', field);
        }
      }
    }
  bash(game, tx, ty, z, Math.round(power / 4), { source: 'explosion', silent: true });
  return { radius, hitMonsters, playerDamage };
}
