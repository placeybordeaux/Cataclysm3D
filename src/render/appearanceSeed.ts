// Gallery fixtures can choose cosmetic variants without resetting gameplay identity.
// Weak keys disappear with the creature and never enter save data or combat targeting.
const overrides = new WeakMap<object, number>();
export function appearanceSeed(creature: { uid: number }): number {
  return overrides.get(creature) ?? creature.uid;
}
export function setAppearanceSeed(creature: object, seed: number): void {
  overrides.set(creature, seed >>> 0);
}
