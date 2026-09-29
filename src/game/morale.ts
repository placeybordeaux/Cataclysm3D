// Morale (CDDA morale.cpp player_morale, simplified: no temper multipliers or mutation
// hooks). Each morale type is one point with bonus, cap, duration and decay start; the
// level combines points as sqrt(sum of positive squares) - sqrt(sum of negative squares).

export interface MoralePoint {
  type: string;
  /** Distinguishes e.g. food_good per food item type, like CDDA's item_type key. */
  itemType?: string;
  bonus: number;
  /** seconds; 0 = permanent */
  duration: number;
  decayStart: number;
  age: number;
}

/** cata_utility.cpp logarithmic_range: 1 at min, logistic falloff to 0 at max. */
export function logarithmicRange(min: number, max: number, pos: number): number {
  const CUT = 4;
  const logi = (t: number) => 1 / (1 + Math.exp(-t));
  const LMIN = logi(-CUT), LMAX = logi(CUT);
  if (min >= max) return 0;
  if (pos <= min) return 1;
  if (pos >= max) return 0;
  const unit = (pos - min) / (max - min);
  return (logi(CUT - 2 * CUT * unit) - LMIN) / (LMAX - LMIN);
}

export class Morale {
  points: MoralePoint[] = [];

  static netBonus(p: MoralePoint): number {
    const perm = p.duration === 0;
    return Math.trunc(p.bonus * (!perm && p.age > p.decayStart ? logarithmicRange(p.decayStart, p.duration, p.age) : 1));
  }

  /** player_morale::add — repeated sources stack as sqrt of sum of squares, capped at maxBonus. */
  add(type: string, bonus: number, maxBonus: number, duration: number, decayStart: number, capped = false, itemType?: string): void {
    const p = this.points.find((m) => m.type === type && m.itemType === itemType);
    if (!p) {
      const b = Math.abs(bonus) > Math.abs(maxBonus) && (maxBonus !== 0 || capped) ? maxBonus : bonus;
      if (b !== 0) this.points.push({ type, itemType, bonus: b, duration, decayStart, age: 0 });
      return;
    }
    const sameSign = p.bonus > 0 === maxBonus > 0;
    const pick = (cur: number, nw: number) => {
      const remaining = cur - p.age;
      return remaining <= nw && sameSign ? nw : remaining;
    };
    const net = Morale.netBonus(p);
    if (capped || duration === 0) {
      p.duration = duration;
      p.decayStart = decayStart;
    } else {
      p.duration = pick(p.duration, duration);
      p.decayStart = pick(p.decayStart, decayStart);
    }
    let combined: number;
    if (duration === 0) combined = bonus;
    else if (capped || !sameSign) combined = net + bonus;
    else combined = Math.sign(p.bonus) * Math.sqrt(net * net + bonus * bonus);
    p.bonus = Math.trunc(Math.abs(combined) > Math.abs(maxBonus) && (maxBonus !== 0 || capped) ? maxBonus : combined);
    p.age = 0;
    this.removeExpired();
  }

  remove(type: string): void {
    this.points = this.points.filter((p) => p.type !== type);
  }

  has(type: string): boolean {
    return this.points.some((p) => p.type === type);
  }

  decay(seconds: number): void {
    for (const p of this.points) p.age += seconds;
    this.removeExpired();
  }

  private removeExpired(): void {
    this.points = this.points.filter((p) => !((p.duration !== 0 && p.age >= p.duration) || p.bonus === 0));
  }

  level(): number {
    let pos = 0, neg = 0;
    for (const p of this.points) {
      const b = Morale.netBonus(p);
      if (b > 0) pos += b * b;
      else neg += b * b;
    }
    return Math.trunc(Math.sqrt(pos) - Math.sqrt(neg));
  }
}

/** Character::calc_focus_equilibrium (without reading penalties). */
export function focusEquilibrium(moraleLevel: number, perceivedPain: number): number {
  const eff = moraleLevel - perceivedPain;
  let eq = 100;
  if (eff < -99) eq = 1;
  else if (eff <= 50) eq += eff;
  else {
    let mult = 1, left = eff;
    while (eq < 400) {
      if (left > 50 * mult) {
        left -= 50 * mult;
        eq += 50;
        mult *= 2;
      } else {
        eq += Math.trunc(left / mult);
        break;
      }
    }
  }
  return Math.max(1, Math.min(400, eq));
}
