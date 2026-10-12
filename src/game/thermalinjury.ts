import type { Character } from './character';
import { ALL_PARTS, BODY_PARTS, type BodyPartId, type MainPartId } from './bodyparts';
import { armorPortion, materialIds } from './inventory';

export const FROSTBITE_PARTS = ['mouth', 'hand_l', 'hand_r', 'foot_l', 'foot_r'] as const;
export type FrostbitePart = typeof FROSTBITE_PARTS[number];
export type FrostbiteTimers = Partial<Record<FrostbitePart, number>>;

/** BN character.cpp apply_frostbite risk zones, in Fahrenheit and mph. */
export function frostbiteRate(temperatureF: number, windMph: number, cold: boolean): number {
  if (!cold) return -3;
  if ((temperatureF < 30 && temperatureF >= 10) || (temperatureF < 10 && temperatureF >= -5 && windMph < 20 && -4 * temperatureF + 3 * windMph - 20 >= 0)) return 3;
  if ((temperatureF < 10 && temperatureF >= -5 && windMph < 20 && -4 * temperatureF + 3 * windMph - 20 < 0) ||
      (temperatureF < 10 && temperatureF >= -5 && windMph >= 20) || (temperatureF < -5 && windMph < 10) ||
      (temperatureF < -5 && windMph >= 10 && -4 * temperatureF + 3 * windMph - 170 >= 0)) return 8;
  if ((temperatureF < -5 && windMph >= 10 && -4 * temperatureF + 3 * windMph - 170 < 0) || (temperatureF < -35 && windMph >= 10)) return 72;
  return -3;
}

/** BN wind_resistance_from_item_list: coverage after material wind-resistance penalty. */
export function thermalWindResistance(c: Character, bp: BodyPartId): number {
  let exposed = 100;
  for (const item of c.inv.wornCovering(bp)) {
    const materials = materialIds(item.def).map((id) => c.data.misc.material?.[id]);
    const values = materials.map((m) => m?.wind_resist).filter((v): v is number => typeof v === 'number');
    const resistance = values.length ? Math.max(...values) : 99;
    const coverage = Math.max(0, (armorPortion(item, bp)?.coverage ?? 0) - (100 - resistance));
    exposed = Math.trunc(exposed * (100 - coverage) / 100);
  }
  return 100 - exposed;
}

/** BN item::fire_resist: average material fire resistance scaled by environmental seal. */
export function thermalFireArmor(c: Character, bp: BodyPartId): number {
  let armor = 0;
  for (const item of c.inv.wornCovering(bp)) {
    const ids = materialIds(item.def);
    const resistance = ids.reduce((n, id) => n + Number(c.data.misc.material?.[id]?.fire_resist ?? 0), 0) / Math.max(1, ids.length);
    const seal = Number(item.def.environmental_protection ?? 0);
    armor += Math.round(resistance * Math.min(1, seal / 10));
  }
  for (const provider of c.inv.naturalArmor) armor += provider(bp, 'heat');
  return armor;
}

/** Body-temperature injury state lives on Character and is included in its save JSON. */
export function updateThermalInjuries(c: Character, seconds: number): void {
  for (const bp of FROSTBITE_PARTS) {
    const main = BODY_PARTS[bp].main;
    const warmth = c.inv.warmth(bp) - c.wetness[main] * 100;
    const airF = Math.trunc(c.env.temperature * 9 / 5 + 32 + 0.2 * warmth);
    const windMph = Math.trunc(c.env.wind / 1.609 * (1 - thermalWindResistance(c, bp) / 100));
    const rate = frostbiteRate(airF, windMph, c.bodyTemp[main] < 34);
    const before = (c.frostbiteTimers[bp] ?? 0) - Math.min(5, c.env.heatRadiationF ?? 0) * seconds;
    const timer = Math.min(rate === 3 ? Math.max(before, 2000) : 4200, Math.max(0, before + rate * seconds));
    c.frostbiteTimers[bp] = timer;
    const previous = c.effects.get('frostbite', bp)?.intensity ?? 0;
    const intensity = timer >= 3600 ? 2 : timer >= 1800 ? 1 : previous;
    if (timer === 0) {
      c.effects.remove('frostbite', bp);
      c.effects.remove('frostbite_recovery', bp);
    } else if (timer >= 1800) {
      if (intensity === 2) c.effects.remove('frostbite_recovery', bp);
      else if (previous === 2) c.effects.add('frostbite_recovery', 1, { bp, turn: c.turn, permanent: true });
      const effect = c.effects.get('frostbite', bp);
      if (effect) effect.setIntensity(intensity);
      else c.effects.add('frostbite', 1, { bp, intensity, turn: c.turn, permanent: true });
      if (intensity > previous) c.msg(`Your ${BODY_PARTS[bp].name} is ${intensity === 2 ? 'frostbitten' : 'frostnipped'}!`, 'c_red');
    }
  }
  const radiation = c.env.heatRadiationF ?? 0;
  const count = Math.trunc(Math.sqrt(Math.max(0, radiation - 111)));
  const blisters = Math.max(0, count + c.enchantBonus('BLISTER_COUNT', count, true));
  const affected = new Set<MainPartId>();
  for (const bp of ALL_PARTS) {
    if (blisters <= thermalFireArmor(c, bp)) continue;
    const main = BODY_PARTS[bp].main;
    if (affected.has(main)) continue;
    affected.add(main);
    const effect = c.effects.get('blisters', main);
    if (effect) effect.setDuration(2);
    else c.addEffect('blisters', 2, { bp: main });
    if (!effect) c.msg(`Your ${BODY_PARTS[main].name} is blistering from the intense heat!`, 'c_red');
  }
}
