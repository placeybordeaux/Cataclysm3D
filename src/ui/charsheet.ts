import { ALL_PARTS, BODY_PARTS, MAIN_PARTS } from '../game/bodyparts';
import { cddaText } from '../game/units';
import { c, colorize, openWindow, type UiWindow } from './framework';
import { hpBar, moraleFace } from './format';
import type { UiContext } from './context';

// The '@' character sheet, laid out like CDDA's player_display.cpp: a header line, then
// boxes for STATS / ENCUMBRANCE / SPEED on top, TRAITS / EFFECTS / BODY below, then SKILLS.

const box = (title: string, body: string) => `<div class="cdda-box"><div class="box-title">${title}</div><div class="pre" style="padding:0 .5em">${body}</div></div>`;

export function openCharacterSheet(ctx: UiContext): UiWindow {
  const { game } = ctx;
  const p = game.player;
  const misc = game.data.misc ?? {};

  const statLine = (name: string, cur: number, base: number) =>
    `${name.padEnd(14)}${c(cur < base ? 'c_red' : cur > base ? 'c_green' : 'c_light_gray', String(cur).padStart(2))}${cur !== base ? c('c_dark_gray', ` (${base})`) : ''}`;
  const stats = [
    statLine('Strength:', p.str, p.str_base),
    statLine('Dexterity:', p.dex, p.dex_base),
    statLine('Intelligence:', p.int, p.int_base),
    statLine('Perception:', p.per, p.per_base),
    '',
    `Height: ${c('c_light_gray', `${p.heightCm()} cm`)}`,
    `Age: ${c('c_light_gray', String(p.age()))}`,
    `Weight: ${c('c_light_gray', `${p.bodyweightKg().toFixed(1)} kg`)}`,
    `Carrying: ${c('c_light_gray', `${(p.inv.weightCarried() / 1000).toFixed(1)}/${(p.inv.weightCapacity() / 1000).toFixed(1)} kg`)}`,
  ].join('\n');

  const enc = ALL_PARTS.map((bp) => {
    const e = p.inv.encumbrance(bp);
    const thr = BODY_PARTS[bp].encumbrance_threshold;
    const col = e === 0 ? 'c_light_gray' : e <= thr + 10 ? 'c_yellow' : e <= thr + 20 ? 'c_light_red' : 'c_red';
    const warm = p.inv.warmth(bp);
    return `${BODY_PARTS[bp].name.padEnd(11)}${c(col, String(e).padStart(3))}  ${c('c_dark_gray', 'warmth')} ${c('c_light_gray', String(warm).padStart(3))}`;
  }).join('\n');

  const pp = p.painPenalty();
  const speedLines = [
    `${'Base Move Cost:'.padEnd(20)}${c('c_white', String(100).padStart(4))}`,
    `${'Current Speed:'.padEnd(20)}${c(p.speed < 100 ? 'c_red' : p.speed > 100 ? 'c_green' : 'c_white', String(p.speed).padStart(4))}`,
    ...p.speedModifiers.map(([n, v]) => `${n.padEnd(20)}${c(v < 0 ? 'c_red' : 'c_green', ((v > 0 ? '+' : '') + v).padStart(4))}`),
  ];
  if (!p.speedModifiers.length && pp.speed) speedLines.push(`${'Pain'.padEnd(20)}${c('c_red', String(-pp.speed).padStart(4))}`);
  speedLines.push('', `Mood: ${colorize(moraleFace(p.morale.level(), ctx.data.moodFaces))}  ${c('c_light_gray', `(${p.morale.level()})`)}`, `Focus: ${c('c_light_gray', String(Math.round(p.focus)))}`);

  const traitDefs = (misc.mutation ?? {}) as Record<string, any>;
  const traits = [...p.traits].map((id) => {
    const pts = traitDefs[id]?.points ?? 0;
    return c(pts > 0 ? 'c_light_green' : pts < 0 ? 'c_light_red' : 'c_yellow', p.traitName(id));
  });

  const effects = p.effects.all().filter((e) => e.name()).map((e) => {
    const r = e.type.def.rating;
    return `${c(r === 'good' ? 'c_green' : r === 'bad' ? 'c_red' : 'c_light_gray', e.name())}${e.bp ? c('c_dark_gray', ` (${BODY_PARTS[e.bp].name})`) : ''}`;
  });

  const skillDefs = Object.values(misc.skill ?? {}) as { id: string; name: unknown; display_category?: string; sort_rank?: number }[];
  const cats: Record<string, string> = { display_melee: 'MELEE', display_ranged: 'RANGED', display_crafting: 'CRAFTING', display_interaction: 'INTERACTION' };
  let skills = '';
  for (const [cat, label] of Object.entries(cats)) {
    const list = skillDefs.filter((s) => s.display_category === cat).sort((a, b) => (a.sort_rank ?? 0) - (b.sort_rank ?? 0));
    if (!list.length) continue;
    skills += c('c_light_blue', label) + '\n';
    for (const s of list) {
      const sk = p.skills[s.id];
      const lvl = sk?.level ?? 0;
      const pct = sk ? Math.floor((100 * sk.exercise) / (10000 * (lvl + 1) ** 2)) : 0;
      skills += `${c(lvl > 0 ? 'c_white' : 'c_dark_gray', (cddaText(s.name) || s.id).padEnd(16))}${c(lvl > 0 ? 'c_white' : 'c_dark_gray', String(lvl).padStart(2))}${c('c_dark_gray', ` (${String(pct).padStart(2)}%)`)}\n`;
    }
  }

  const body = MAIN_PARTS.map((bp) => {
    const hp = p.hp[bp];
    const b = hpBar(hp.cur, hp.max);
    const status = p.isLimbBroken(bp) ? c('c_red', ' BROKEN') : '';
    return `${BODY_PARTS[bp].name.padEnd(10)}${c(b.color, b.text.padEnd(6))}${c('c_light_gray', `${hp.cur}/${hp.max}`.padStart(8))}${status}`;
  }).join('\n') + `\n\nPain: ${c(p.perceivedPain() > 0 ? 'c_yellow' : 'c_light_gray', p.painDescription())}\nStamina: ${c('c_light_gray', `${Math.round(p.stamina)}/${p.staminaMax()}`)}`;

  const prof = ctx.build ? ` | Profession: ${c('c_light_gray', ctx.build.profession)} | Scenario: ${c('c_light_gray', ctx.build.scenario)}` : '';
  const header = `Name: ${c('c_white', p.name)} | Gender: ${c('c_light_gray', p.male ? 'Male' : 'Female')}${prof}`;

  const w = openWindow({ title: 'Character', width: 'min(132ch, 97vw)', height: '92vh', footer: `${c('c_light_green', 'Esc')} close` });
  w.body.style.whiteSpace = 'normal';
  w.body.innerHTML = `<div class="pre" style="margin-bottom:4px">${header}</div>
    <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
      ${box('STATS', stats)}${box('ENCUMBRANCE', enc)}${box('SPEED', speedLines.join('\n'))}
      ${box('TRAITS', traits.join('\n') || c('c_dark_gray', 'None'))}${box('EFFECTS', effects.join('\n') || c('c_dark_gray', 'None'))}${box('BODY', body)}
    </div>
    <div style="margin-top:6px">${box('SKILLS', skills)}</div>`;
  const grid = w.body.lastElementChild!.querySelector('.pre') as HTMLElement;
  grid.style.columnCount = '3';
  return w;
}
