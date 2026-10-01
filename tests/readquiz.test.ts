// The reading minigame ("field notes", docs/ADAPTATION.md): question generators over every BN
// book, and the reward / cooldown / skim / interrupt logic against the real extracted data.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Rng } from '../src/core/rng';
import type { GameData } from '../src/data/types';
import { bookHasQuiz, bookTemplates, domainName, keysNamed, nextQuestion, questionFrom, questionKey, setQuizVehicles, type Question, type TemplateId } from '../src/game/readquiz/questions';

const dir = path.join(__dirname, '../public/data');
const load = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
export const data: GameData = {
  terrain: load('terrain.json'),
  furniture: load('furniture.json'),
  items: load('items.json'),
  itemGroups: load('item_groups.json'),
  monsters: {},
  monsterGroups: {},
  recipes: load('recipes.json'),
  misc: load('misc.json'),
};
setQuizVehicles(data, load('vehicles.json'));

const books = Object.keys(data.items).filter((id) => data.items[id].type === 'BOOK' || (data.items[id].subtypes as string[] | undefined)?.includes('BOOK'));
const quizBooks = books.filter((id) => bookHasQuiz(data, id));

/** Independent re-check of a question's soundness (the generator promises all of this). */
function problems(q: Question): string[] {
  const out: string[] = [];
  const passing = q.keys.filter(q.rule);
  if (passing.length !== 1) out.push(`${passing.length} options pass the rule`);
  if (!q.rule(q.keys[q.answer])) out.push('the marked answer fails its own rule');
  const lower = q.options.map((o) => o.toLowerCase());
  if (new Set(lower).size !== lower.length) out.push(`duplicate option names: ${q.options.join(', ')}`);
  q.keys.forEach((k, i) => {
    if (domainName(data, q.domain, k).toLowerCase() !== lower[i]) out.push(`option ${i} name mismatch`);
    // A player only sees the name: everything with that name must agree with the rule.
    const same = keysNamed(data, q.domain, q.options[i]);
    const want = i === q.answer;
    const bad = same.filter((s) => q.rule(s) !== want);
    if (bad.length) out.push(`"${q.options[i]}" is ambiguous (${bad.join(', ')} ${want ? 'fail' : 'pass'})`);
  });
  if (q.options.length < 3 || q.options.length > 4) out.push(`${q.options.length} options`);
  if (!q.prompt.endsWith('?')) out.push('prompt is not a question');
  if (/[|]/.test(q.prompt + q.options.join(''))) out.push('ambiguous glyph');
  return out;
}

describe('field-notes question generators', () => {
  it('every skill book, recipe book and martial-arts manual has a quiz; fun-only books do not', () => {
    for (const id of books) {
      const d = data.items[id];
      const teaches = !!d.skill || !!d.martial_art || (data.recipes.some((r) => (r.book_learn ?? []).some(([b]) => b === id)));
      expect(bookHasQuiz(data, id), id).toBe(teaches);
    }
    expect(bookHasQuiz(data, 'novel_scifi')).toBe(false);
    expect(quizBooks.length).toBeGreaterThan(190);
  });

  it('each quiz book yields at least 8 distinct, sound questions', () => {
    const report: string[] = [];
    for (const id of quizBooks) {
      const rng = new Rng(1234);
      const seen = new Map<string, Question>();
      for (let i = 0; i < 60 && seen.size < 12; i++) {
        const q = nextQuestion(data, id, rng, new Set(seen.keys()));
        expect(q, id).not.toBeNull();
        const p = problems(q!);
        if (p.length) report.push(`${id} [${q!.template}] ${q!.prompt} → ${p.join('; ')}`);
        seen.set(questionKey(q!), q!);
      }
      if (seen.size < 8) report.push(`${id}: only ${seen.size} distinct questions`);
    }
    expect(report, report.slice(0, 20).join('\n')).toEqual([]);
  });

  it('every template, run many times over the books that use it, never makes an unsound question', () => {
    const bad: string[] = [];
    const made = new Map<TemplateId, number>();
    for (const id of quizBooks) {
      for (const [t] of bookTemplates(data, id)) {
        const rng = new Rng(id.length * 31 + t.length);
        for (let i = 0; i < 6; i++) {
          const q = questionFrom(data, id, t, rng);
          if (!q) continue;
          made.set(t, (made.get(t) ?? 0) + 1);
          const p = problems(q);
          if (p.length) bad.push(`${id} [${t}] ${q.prompt} ${q.options.join(' / ')} → ${p.join('; ')}`);
        }
      }
    }
    expect(bad, bad.slice(0, 20).join('\n')).toEqual([]);
    // Every template actually fires somewhere.
    for (const t of ['recipe_uses', 'recipe_quality', 'book_makes', 'recipe_hardest', 'quality_item', 'spoils_first', 'never_spoils', 'heal', 'gun_ammo', 'gun_magazine', 'gun_skill', 'battery_fits', 'needs_power', 'weapon_class', 'damage_most', 'ma_technique', 'price_most', 'encumbrance_most', 'swim_gear', 'throwing', 'engine_fuel', 'car_needs', 'made_of', 'material_of'] as TemplateId[])
      expect(made.get(t) ?? 0, t).toBeGreaterThan(3);
  });

  it('beginner books get 3 options, advanced ones 4', () => {
    const q1 = nextQuestion(data, 'mag_cooking', new Rng(5))!;
    expect(q1.options).toHaveLength(3);
    const q2 = nextQuestion(data, 'textbook_chemistry', new Rng(5))!;
    expect(q2.options).toHaveLength(4);
  });

  it('a cookbook asks about its own recipes: "What do you need to boil water?" in data form', () => {
    const rng = new Rng(9);
    const qs: Question[] = [];
    for (let i = 0; i < 40; i++) {
      const q = questionFrom(data, 'cookbook', 'recipe_quality', rng);
      if (q) qs.push(q);
    }
    expect(qs.length).toBeGreaterThan(10);
    for (const q of qs) expect(q.prompt).toMatch(/^Making .+ takes a tool for .+\. Which of these will do\?$/);
    // The flashlight question from the reload helper's data.
    const fl = Array.from({ length: 80 }, (_, i) => questionFrom(data, 'manual_electronics', 'battery_fits', new Rng(i))).find((q) => q?.prompt === 'Which battery fits a flashlight?');
    expect(fl, 'flashlight battery question').toBeTruthy();
    expect(['light battery', 'light disposable battery']).toContain(fl!.options[fl!.answer].toLowerCase());
  });
});
