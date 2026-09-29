// BN Creature::deal_projectile_attack severity and hit location (src/game/projectile.ts).
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import { projectileHit } from '../src/game/projectile';

const mon = { dodgeRoll: 0, isCharacter: false };

describe('BN projectile severity', () => {
  it('bands: graze 4(1-g), 1.6-g, 1.766-4g/3, crit 1.5', () => {
    const rng = new Rng(1);
    const at = (g: number) => projectileHit(mon, { missedBy: g }, rng);
    expect(at(0.9).severity).toBeCloseTo(0.4, 5);
    expect(at(0.9).graze).toBe(true);
    expect(at(0.9).tag).toBe('Grazing hit.');
    expect(at(0.6).severity).toBeCloseTo(1.0, 5);
    expect(at(0.35).severity).toBeLessThanOrEqual(1.766 - (0.35 * 4) / 3 + 1e-9);
    const crit = at(0.1);
    expect(crit.tag).toBe('Critical!');
    expect(crit.headshot).toBe(true);
    expect(crit.severity).toBeLessThanOrEqual(1.5);
    expect(at(1.2).hit).toBe(false);
  });

  it('skilled shooters add severity on criticals, capped by where the round lands', () => {
    const shooter = { dex: 12, per: 12, skill: 8, steadiness: 1, isPlayer: true };
    let best = 0;
    const rng = new Rng(7);
    for (let i = 0; i < 400; i++) {
      const r = projectileHit(mon, { missedBy: 0, shooter }, rng);
      best = Math.max(best, r.severity);
      if (r.location === 'torso') expect(r.severity).toBeLessThanOrEqual(1.5);
      else if (r.location !== 'head') expect(r.severity).toBeLessThanOrEqual(1.25);
    }
    // Head shots on monsters reach ×2.
    expect(best).toBeCloseTo(2, 5);
  });

  it('characters cap head severity at 1.5; NO_CRIT caps everything at 1.1', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 200; i++) {
      const r = projectileHit({ dodgeRoll: 0, isCharacter: true }, { missedBy: 0.05 }, rng);
      expect(r.severity).toBeLessThanOrEqual(1.5);
      expect(projectileHit(mon, { missedBy: 0.05, noCrit: true }, rng).severity).toBeLessThanOrEqual(1.1);
    }
  });

  it('PROJECTILE_RESISTANT and NOHEAD monsters', () => {
    const rng = new Rng(4);
    for (let i = 0; i < 200; i++) {
      const r = projectileHit({ dodgeRoll: 0, isCharacter: false, flags: ['PROJECTILE_RESISTANT_2', 'NOHEAD'] }, { missedBy: 0 }, rng);
      expect(r.location).not.toBe('head');
      expect(r.severity).toBeLessThanOrEqual(0.8);
    }
  });
});
