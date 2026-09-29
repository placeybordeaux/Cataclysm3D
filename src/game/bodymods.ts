import type { Character } from './character';
import { BionicState } from './bionics';
import { isMutagenVitamin, MutationState, mutagenVitamins, toolsNeeded } from './mutations';

// Attaches mutations + bionics to a Character through its hook points (no Game needed, so
// unit tests use this directly): enchantment sources/conditions, wear restrictions,
// encumbrance, natural armor, pseudo tool qualities, and mutagen consumption.

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
  const inv = c.inv;
  inv.wearChecks.push((it) => mut.wearBlocker(it));
  inv.extraEncumbrance.push((bp) => mut.encumbrance(bp) + bio.encumbrance(bp));
  inv.naturalArmor.push((bp, dt) => mut.armor(bp, dt) + bio.armor(bp, dt));
  inv.qualityProviders.push(() => bio.pseudoItems());

  // Injected mutagens need a syringe (consume_drug tools_needed).
  inv.consumeChecks.push((food) => {
    for (const tool of toolsNeeded(food)) {
      if (!inv.allItems().some((it) => it.typeId === tool)) return `You need a ${c.data.items[tool]?.name ?? tool} to use that.`;
    }
    return null;
  });
  // Mutagen vitamins: consume_drug "vitamins" and the mutagenic ones in a food's own vitamins.
  inv.onConsume.push((portion) => {
    const fromDrug = mutagenVitamins(portion);
    if (fromDrug) mut.addVitaminsFrom(fromDrug);
    const own = (portion.def.vitamins as [string, number][] | undefined) ?? [];
    const mutagenic = own.filter(([id]) => isMutagenVitamin(id));
    if (mutagenic.length) mut.addVitaminsFrom(mutagenic);
  });

  // Bionic ↔ mutation conflicts: canceled_mutations block a mutation outright; a mutation in
  // mutation_conflicts strains against the CBM (handle_bio_mut_conflict, simplified to pain).
  mut.bionicBlockers.push((id) => {
    for (const b of bio.bionics) {
      const d = bio.def(b.id);
      if (d?.canceled_mutations?.includes(id)) {
        c.msg(`Your churning flesh strains painfully against your ${bio.name(b.id)} for a moment, then the feeling fades.`, 'c_light_red');
        return false;
      }
      if (d?.mutation_conflicts?.includes(id)) {
        c.msg(`Your body strains against your ${bio.name(b.id)} and it hurts!`, 'c_red');
        c.modPain(c.rng.int(5, 15));
        return false;
      }
    }
    return null;
  });
  bio.cancelMutation = (id) => mut.removeMutation(id);
  return mods;
}
