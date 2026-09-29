import type { Character } from '../game/character';
import { ALL_PARTS, BODY_PARTS, type BodyPartId } from '../game/bodyparts';
import { armorPortion, covers, materialIds } from '../game/inventory';
import { asArray, type Item } from '../game/item';
import { cddaText } from '../game/units';
import { c, colorize } from './framework';
import { durationText, kg, liters } from './format';

// Item description in the layout of CDDA's item info panel (item.cpp item::info): category
// and price, material, volume/weight, then melee, armor, food, gun and ammo sections, then
// the description. Output is HTML built from CDDA color tags.

const SEP = `<span style="color:var(--c-dark_gray)">--</span>`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const num = (v: number) => c('c_yellow', Number.isInteger(v) ? String(v) : v.toFixed(2));

export function categoryName(it: Item): string {
  const cat = it.data.misc?.item_category?.[it.def.category];
  return cddaText(cat?.name_header) || it.def.category || 'other';
}

function materialName(it: Item, id: string): string {
  return cddaText(it.data.misc?.material?.[id]?.name) || id;
}

/** "The torso, arms and legs" style coverage list, merging left/right pairs like CDDA. */
function coverageText(it: Item): string {
  const parts = ALL_PARTS.filter((bp) => covers(it, bp));
  const names: string[] = [];
  const done = new Set<BodyPartId>();
  for (const bp of parts) {
    if (done.has(bp)) continue;
    const opp = BODY_PARTS[bp].opposite;
    if (opp && parts.includes(opp)) {
      done.add(opp);
      names.push(BODY_PARTS[bp].name.replace(/^(left|right) /, '') + 's');
    } else names.push(BODY_PARTS[bp].name);
    done.add(bp);
  }
  if (names.length === 0) return 'Nothing';
  if (names.length === 1) return `The ${names[0]}`;
  return `The ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export function itemInfo(it: Item, who: Character): string {
  const d = it.def;
  const L: string[] = [];
  const price = (d.price_postapoc ?? d.price ?? 0) / 100;
  L.push(`Category: ${c('c_magenta', categoryName(it).toUpperCase())}   Price: ${c('c_yellow', '$' + price.toFixed(2))}`);
  const mats = materialIds(d);
  if (mats.length) L.push(`Material: ${c('c_yellow', mats.map((m) => materialName(it, m)).join(', '))}`);
  L.push(`Volume: ${num(+liters(it.volume()))} L  Weight: ${num(+kg(it.weight()))} kg`);
  if (d.longest_side) L.push(`Length: ${num(d.longest_side)} cm`);
  if (it.damage !== 0) L.push(`Condition: ${c(it.damage > 0 ? 'c_light_red' : 'c_green', it.damageAdjective() || 'undamaged')}`);

  // --- melee
  const bash = it.meleeDamage('bash'), cut = it.meleeDamage('cut'), stab = it.meleeDamage('stab');
  if (bash || cut || stab || it.toHit() !== 0 || !it.countByCharges) {
    L.push(SEP);
    L.push(`<b>Melee damage</b>: Bash: ${num(Math.round(bash))}  Cut: ${num(Math.round(cut))}  Pierce: ${num(Math.round(stab))}`);
    const th = Math.round(it.toHit());
    L.push(`To-hit bonus: ${c('c_yellow', (th >= 0 ? '+' : '') + th)}`);
    L.push(`Base moves per attack: ${num(it.attackTime())}`);
    // CDDA "Techniques when wielded" (combat depth: src/game/techniques.ts).
    const tecs = ((d.techniques as string[] | undefined) ?? [])
      .map((id) => (it.data.misc?.technique as Record<string, { name: string; description?: string }> | undefined)?.[id])
      .filter((t): t is { name: string; description?: string } => !!t);
    if (tecs.length) L.push(`<b>Techniques when wielded</b>: ${tecs.map((t) => `${c('c_light_blue', t.name)}${t.description ? `: ${c('c_light_gray', t.description)}` : ''}`).join(', ')}`);
  }
  if (it.gunmods.length) L.push(`<b>Mods</b>: ${c('c_light_green', it.gunmods.map((m) => m.baseName()).join(', '))}`);

  // --- armor
  if (it.isArmor()) {
    L.push(SEP);
    L.push(`<b>Covers</b>: ${c('c_cyan', coverageText(it))}`);
    const covered = ALL_PARTS.filter((bp) => covers(it, bp));
    const first = covered[0];
    if (first) {
      const portion = armorPortion(it, first);
      const enc = asArray(portion?.encumbrance);
      L.push(`Coverage: ${num(portion?.coverage ?? 0)}%   Warmth: ${num(d.warmth ?? 0)}`);
      L.push(`Encumbrance: ${num(enc[0] ?? 0)}${enc[1] !== undefined && enc[1] !== enc[0] ? ` (${num(enc[1])} when full)` : ''}`);
      const r = (t: string) => who.inv.armorResist(it, first, t);
      L.push(`<b>Protection</b>: Bash: ${num(+r('bash').toFixed(2))}  Cut: ${num(+r('cut').toFixed(2))}  Ballistic: ${num(+r('bullet').toFixed(2))}`);
      L.push(`  Acid: ${num(+r('acid').toFixed(2))}  Fire: ${num(+r('heat').toFixed(2))}  Environmental: ${num(d.environmental_protection ?? 0)}`);
    }
  }
  if (it.isContainer()) {
    const cap = it.containerVolumeCapacity();
    if (Number.isFinite(cap) && cap > 0) L.push(`Storage: ${num(+liters(it.containerVolumeUsed()))}/${num(+liters(cap))} L`);
  }

  // --- food
  if (it.isComestible()) {
    L.push(SEP);
    L.push(`Calories (kcal): ${num(d.calories ?? 0)}  Quench: ${num(d.quench ?? 0)}`);
    if (d.fun) L.push(`Enjoyability: ${c(d.fun > 0 ? 'c_green' : 'c_red', String(d.fun))}`);
    if (it.goesBad()) {
      const left = it.spoilTime() - it.rot;
      L.push(it.rotten() ? c('c_red', 'This food has started to rot.') : `Spoils in: ${c('c_yellow', durationText(Math.max(0, left)))}`);
    }
    if (it.countByCharges && it.charges > 1) L.push(`Portions: ${num(it.charges)}`);
  }

  // --- guns / ammo / magazines
  if (it.isGun()) {
    L.push(SEP);
    const dmg = it.gunDamage();
    if (dmg.length) L.push(`<b>Ranged damage</b>: ${dmg.map((u) => `${num(Math.round(u.amount))} ${u.type}${u.armor_penetration ? ` (AP ${u.armor_penetration})` : ''}`).join(', ')}`);
    if (d.range) L.push(`Range: ${num(d.range)}`);
    if (d.dispersion) L.push(`Dispersion: ${num(d.dispersion)}`);
    const types = it.ammoTypes();
    if (types.length) L.push(`Ammunition: ${c('c_yellow', types.join(', '))}   Loaded: ${num(it.ammoRemaining())}/${num(it.ammoCapacity())}`);
    if (d.skill) L.push(`Skill used: ${c('c_cyan', who.skillName(d.skill))}`);
  } else if (it.isMagazine()) {
    L.push(SEP);
    L.push(`Capacity: ${num(it.ammoCapacity())} rounds of ${c('c_yellow', it.ammoTypes().join(', '))}   Loaded: ${num(it.ammoRemaining())}`);
  } else if (it.isAmmo()) {
    L.push(SEP);
    const dm = asArray(d.damage);
    if (dm.length) L.push(`Damage: ${dm.map((u) => `${num(u.amount ?? 0)} ${u.damage_type ?? ''}`).join(', ')}`);
    if (d.range) L.push(`Range: ${num(d.range)}`);
  }
  if (it.isBook()) {
    L.push(SEP);
    if (d.skill) L.push(`Can bring your ${c('c_cyan', who.skillName(d.skill))} skill to ${num(d.max_level ?? 0)}`);
    if (d.intelligence) L.push(`Requires intelligence of ${num(d.intelligence)} to easily read.`);
    if (d.time) L.push(`A chapter of this book takes ${c('c_yellow', durationText(d.time))} to read.`);
  }
  if (d.qualities?.length) {
    L.push(SEP);
    for (const [q, lvl] of d.qualities) {
      const qn = cddaText(it.data.misc?.tool_quality?.[q]?.name) || q;
      L.push(`Has level ${c('c_cyan', String(lvl))} ${c('c_cyan', qn)} quality.`);
    }
  }
  // E-file storage (phones, laptops, USB drives): what's on it; books are read with R.
  const efiles = it.efiles();
  if (it.pockets.some((p) => p.type === 'E_FILE_STORAGE')) {
    L.push(SEP);
    L.push(`<b>Files</b>: ${efiles.length ? efiles.map((f) => c(f.isBook() ? 'c_light_blue' : 'c_light_gray', f.baseName())).join(', ') : c('c_dark_gray', 'none')}`);
  }
  if (d.description) {
    L.push(SEP);
    L.push(colorize(cddaText(d.description)));
  }
  return L.join('\n');
}

export { esc as escapeHtml };
