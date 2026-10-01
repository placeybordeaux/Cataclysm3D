import type { Character } from './character';
import type { Item } from './item';
import { uncraftRecipe } from './disassembly';
import { isUnarmedWeapon } from './martialarts';
import { previewBook, previewDisassembly, type PracticePreview } from './practice';

// What an item trains, for its info card (src/ui/iteminfo.ts "Trains" block): fighting with it
// (BN melee_train: the weapon's bash/cut/stab share + Melee), shooting it (every shot: the gun's
// skill + Marksmanship), reading it, taking it apart. Same rules as the actions.

export interface PracticeInfoLine {
  text: string;
  trains: boolean;
}

export function itemPracticeLines(who: Character, it: Item): PracticeInfoLine[] {
  const out: PracticeInfoLine[] = [];
  const add = (pv: PracticePreview | null, prefix: string) => pv && out.push({ text: `${prefix}${pv.text}`, trains: pv.verdict === 'trains' });
  if (it.isGun()) {
    const skill = (it.def.skill as string | undefined) ?? 'gun';
    const names = [...new Set([skill, 'gun'])].map((s) => who.skillName(s));
    out.push({ text: `Shooting it trains ${names.join(' and ')} with every shot`, trains: true });
  } else if (!it.isAmmo() && !it.isComestible()) {
    if (isUnarmedWeapon(it)) out.push({ text: `Fighting with it trains Unarmed and Melee`, trains: true });
    else {
      const parts = (['bash', 'cut', 'stab'] as const).map((t) => [t, Math.trunc(it.meleeDamage(t))] as const).filter(([, v]) => v > 0);
      const total = parts.reduce((n, [, v]) => n + v, 0);
      const skill = { bash: 'bashing', cut: 'cutting', stab: 'stabbing' } as const;
      // Anything can be swung, but a toaster saying "trains Bashing" is noise: weapons-grade damage only.
      if (total >= 6) {
        const share = parts.map(([t, v]) => `${who.skillName(skill[t])}${parts.length > 1 ? ` ${Math.round((v / total) * 100)}%` : ''}`);
        out.push({ text: `Fighting with it trains ${share.join(', ')} and Melee`, trains: true });
      }
    }
  }
  if (it.isBook() && who.identifiedBooks.has(it.typeId)) {
    const d = it.def;
    if (d.skill) add(previewBook(who, { skill: d.skill as string, req: d.required_level ?? 0, level: d.max_level ?? 0, time: d.time ?? 60 }), 'Reading: ');
  }
  const r = uncraftRecipe(it.data, it.typeId);
  if (r) add(previewDisassembly(who, r), 'Disassembling: ');
  return out;
}
