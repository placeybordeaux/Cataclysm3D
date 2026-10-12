import type { Character } from './character';
import { BionicState } from './bionics';
import { setArmorInterface } from './powerArmor';
import { mutagenAction, MutationState, PURIFIER_ACTIONS, useActionTypes } from './mutations';

// Attaches mutations + bionics to a Character through its hook points (no Game needed, so
// unit tests use this directly): enchantment sources/conditions, wear restrictions,
// encumbrance, natural armor, pseudo tool qualities, and mutagen / purifier consumption.

export interface BodyMods {
  mut: MutationState;
  bio: BionicState;
}

const attached = new WeakMap<Character, BodyMods>();

export function bodyMods(c: Character): BodyMods | undefined {
  return attached.get(c);
}

export function attachBodyMods(c: Character, opts: { isDay?: () => boolean } = {}): BodyMods {
  const have = attached.get(c);
  if (have) return have;
  const mut = new MutationState(c);
  const bio = new BionicState(c);
  const mods: BodyMods = { mut, bio };
  attached.set(c, mods);
  const isDay = opts.isDay ?? (() => true);

  c.enchantCondition = (cond, traitId) => mut.conditionHolds(cond, traitId, isDay);
  c.enchantProviders.push((v) => bio.enchant(v));
  // Power armor draws bionic power through a powered BIONIC_ARMOR_INTERFACE CBM (src/game/powerArmor.ts).
  setArmorInterface(c, {
    efficiency: () => {
      let best = 0;
      for (const b of bio.bionics) {
        const d = bio.def(b.id);
        // BN uses max(1, fuel_efficiency) of the powered interfaces (Character::has_charges(itype_bio_armor)).
        if (b.powered && d?.flags?.includes('BIONIC_ARMOR_INTERFACE')) best = Math.max(best, 1, d.fuel_efficiency ?? 1);
      }
      return best;
    },
    power: () => bio.power,
    drain: (kj) => bio.modPower(-kj),
  });
  const inv = c.inv;
  inv.wearChecks.push((it) => mut.wearBlocker(it));
  inv.extraEncumbrance.push((bp) => mut.encumbrance(bp) + bio.encumbrance(bp));
  inv.naturalArmor.push((bp, dt) => mut.armor(bp, dt) + bio.armor(bp, dt));
  inv.qualityProviders.push(() => bio.pseudoItems());

  inv.consumeChecks.push((food) => {
    // Character::can_eat: a comestible's `tool` (syringe for serums, lighter for cigarettes)
    // must be at hand. Bionic syringe (bio_syringe) stands in for a syringe (consume_med).
    const tool = food.def.tool as string | undefined;
    if (tool && !(tool === 'syringe' && bio.has('bio_syringe')) && !inv.allItems().some((it) => it.typeId === tool)) {
      return `You need a ${c.data.items[tool]?.name ?? tool} to consume that!`;
    }
    // try_reject_mutagen: refusals keep the dose.
    const types = useActionTypes(food);
    if (mutagenAction(food) || types.some((t) => (PURIFIER_ACTIONS as readonly string[]).includes(t))) {
      const rej = mut.rejection(food, false);
      if (rej && !rej.destroyed) return rej.msg;
    }
    return null;
  });
  // BN invokes a comestible's use_action as it is eaten (Character::eat / consume_med).
  inv.onConsume.push((portion) => {
    const ua = mutagenAction(portion);
    if (ua) {
      if (ua.type === 'mutagen') mut.useMutagen(portion, ua);
      else mut.useMutagenIv(portion, ua);
      return;
    }
    for (const t of useActionTypes(portion)) {
      if ((PURIFIER_ACTIONS as readonly string[]).includes(t)) {
        const rej = mut.rejection(portion, false);
        if (rej) c.msg(rej.msg, 'c_light_red');
        else mut.purify(t as (typeof PURIFIER_ACTIONS)[number]);
        return;
      }
    }
  });

  // Bionic canceled_mutations keep those mutations from ever developing (mutation_ok).
  mut.bionicBlockers.push((id) => bio.bionics.some((b) => bio.def(b.id)?.canceled_mutations?.includes(id)));
  bio.cancelMutation = (id) => mut.removeMutation(id);
  return mods;
}
