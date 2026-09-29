import type { RecipeDef } from '../data/types';
import {
  availableRecipes, canCraft, craftingInventory, craftTime, formatDuration, hasCraftingLight, nestedCategories, recipeName,
  recipeProficiencies, startCraft, successChance, type CraftCheck, type CraftHost, type KnownRecipe, type NestedCategory,
} from '../game/crafting';
import type { CraftingInventory } from '../game/crafting_inv';
import { requirementLines } from '../game/requirements';
import { cddaText } from '../game/units';
import { c, colorize, openWindow, prompt, type UiWindow } from './framework';
import './crafting.css';

// The `&` crafting screen, after CDDA's crafting_gui: a row of category tabs (WEAPONS, AMMO,
// FOOD …), a row of subcategory tabs, the recipe list on the left (craftable recipes in
// white, the rest dark gray; nested groups like "spears" open with Enter) and the full
// recipe on the right with have/missing requirements colored green/red.
//   Tab/Shift+Tab: category   ←/→: subcategory   /: search by name   b: batch size
//   Enter: craft (or open a group)   Esc: back / close

const SKIP_CATEGORIES = new Set(['CC_*', 'CC_BUILDING', 'CC_CAMP', 'CC_PRACTICE']);
const TAB_NAMES: Record<string, string> = {
  CC_WEAPON: 'WEAPONS', CC_AMMO: 'AMMO', CC_FOOD: 'FOOD', CC_CHEM: 'CHEMS', CC_ELECTRONIC: 'ELECTRONICS',
  CC_ARMOR: 'ARMOR', CC_APPLIANCE: 'APPLIANCES', CC_OTHER: 'OTHER', CC_ANIMALS: 'ANIMALS', CC_MUSIC: 'MUSIC',
};

type Entry = { kind: 'recipe'; r: RecipeDef; ok: boolean; source: string } | { kind: 'nested'; n: NestedCategory; ok: boolean };

export interface CraftingMenu {
  win: UiWindow;
  setFilter(f: string): void;
  setCategory(cat: string, sub?: string): void;
  select(recipeIdOrResult: string): boolean;
  entries(): string[];
}

let current: CraftingMenu | null = null;

export function openCraftingMenu(game: CraftHost): CraftingMenu {
  if (current && !current.win.closed) current.win.close();
  const data = game.data;
  const player = game.player;
  const cats = Object.values((data.misc.recipe_category ?? {}) as Record<string, { id: string; recipe_subcategories?: string[] }>).filter((k) => !SKIP_CATEGORIES.has(k.id));
  let tab = 0, sub = 0, sel = 0, batch = 1;
  let filter = '';
  const nestedStack: NestedCategory[] = [];

  let inv: CraftingInventory, light: boolean, known: Map<string, KnownRecipe>;
  const checks = new Map<string, CraftCheck>();
  const refreshData = () => {
    inv = craftingInventory(game);
    light = hasCraftingLight(game);
    known = new Map(availableRecipes(player, inv).map((k) => [k.recipe.id, k]));
    checks.clear();
  };
  const check = (r: RecipeDef) => {
    let ch = checks.get(r.id);
    if (!ch) checks.set(r.id, (ch = canCraft(game, r, batch, inv, light)));
    return ch;
  };
  refreshData();

  const nestedById = new Map(nestedCategories(data).map((n) => [n.id, n]));
  const nestedAvailable = (n: NestedCategory, seen = new Set<string>()): { any: boolean; ok: boolean } => {
    let any = false, ok = false;
    if (seen.has(n.id)) return { any, ok };
    seen.add(n.id);
    for (const m of n.members) {
      const nn = nestedById.get(m);
      if (nn) {
        const r = nestedAvailable(nn, seen);
        any ||= r.any;
        ok ||= r.ok;
      } else if (known.has(m)) {
        any = true;
        ok ||= check(known.get(m)!.recipe).ok;
      }
    }
    return { any, ok };
  };
  const recipeEntry = (k: KnownRecipe): Entry => ({ kind: 'recipe', r: k.recipe, ok: check(k.recipe).ok, source: k.source });
  const sortEntries = (l: Entry[]) =>
    l.sort((a, b) => Number(b.ok) - Number(a.ok) || entryName(a).localeCompare(entryName(b)));
  const entryName = (e: Entry) => (e.kind === 'recipe' ? recipeName(data, e.r) : e.n.name);

  let entries: Entry[] = [];
  const buildEntries = () => {
    const out: Entry[] = [];
    if (filter) {
      const f = filter.toLowerCase();
      for (const k of known.values()) if (recipeName(data, k.recipe).toLowerCase().includes(f)) out.push(recipeEntry(k));
    } else if (nestedStack.length) {
      for (const m of nestedStack[nestedStack.length - 1].members) {
        const nn = nestedById.get(m);
        if (nn) {
          const a = nestedAvailable(nn);
          if (a.any) out.push({ kind: 'nested', n: nn, ok: a.ok });
        } else if (known.has(m)) out.push(recipeEntry(known.get(m)!));
      }
    } else {
      const cat = cats[tab];
      const subId = cat.recipe_subcategories?.[sub] ?? 'CSC_ALL';
      const inSub = (s?: string) => subId === 'CSC_ALL' || s === subId;
      for (const k of known.values()) if (k.recipe.category === cat.id && inSub(k.recipe.subcategory)) out.push(recipeEntry(k));
      for (const n of nestedById.values()) {
        if (n.category !== cat.id || !inSub(n.subcategory)) continue;
        const a = nestedAvailable(n);
        if (a.any) out.push({ kind: 'nested', n, ok: a.ok });
      }
    }
    entries = sortEntries(out);
    sel = Math.max(0, Math.min(sel, entries.length - 1));
  };

  const win = openWindow({
    title: 'Crafting',
    width: 'min(118ch, 96vw)',
    height: '86vh',
    footer:
      `${c('c_light_green', 'Tab')}/${c('c_light_green', 'S-Tab')} category  ${c('c_light_green', '←→')} subcategory  ` +
      `${c('c_light_green', '/')} search  ${c('c_light_green', 'b')} batch  ${c('c_light_green', 'Enter')} craft`,
    closeLabel: 'back',
    onKey: (e) => {
      const k = e.key;
      if (k === 'ArrowDown' || k === 'j') move(1);
      else if (k === 'ArrowUp' || k === 'k') move(-1);
      else if (k === 'PageDown') move(15);
      else if (k === 'PageUp') move(-15);
      else if (k === 'Tab') setTab(tab + (e.shiftKey ? -1 : 1));
      else if (k === 'ArrowRight' || k === 'l') setSub(sub + 1);
      else if (k === 'ArrowLeft' || k === 'h') setSub(sub - 1);
      else if (k === '/') askFilter();
      else if (k === 'b') askBatch();
      else if (k === 'Enter') choose();
      else if (k === 'Escape' || k === 'Backspace') {
        if (nestedStack.length) nestedStack.pop();
        else if (filter) filter = '';
        else return false;
        sel = 0;
        render();
      } else return false; // unhandled: the framework closes on & / Esc / Bksp
      return true;
    },
    onClose: () => {
      if (current?.win === win) current = null;
    },
  });
  win.body.innerHTML = `<div class="craft-body"><div class="craft-tabs main"></div><div class="craft-tabs sub"></div><div class="craft-status"></div><div class="craft-cols"><div class="craft-list"></div><div class="craft-detail"></div></div></div>`;
  const tabsEl = win.body.querySelector('.craft-tabs.main') as HTMLElement;
  const subEl = win.body.querySelector('.craft-tabs.sub') as HTMLElement;
  const statusEl = win.body.querySelector('.craft-status') as HTMLElement;
  const listEl = win.body.querySelector('.craft-list') as HTMLElement;
  const detailEl = win.body.querySelector('.craft-detail') as HTMLElement;

  function move(d: number) {
    sel = Math.max(0, Math.min(entries.length - 1, sel + d));
    render(false);
  }
  function setTab(t: number) {
    tab = (t + cats.length) % cats.length;
    sub = 0;
    sel = 0;
    nestedStack.length = 0;
    filter = '';
    render();
  }
  function setSub(s: number) {
    const n = cats[tab].recipe_subcategories?.length ?? 1;
    sub = (s + n) % n;
    sel = 0;
    nestedStack.length = 0;
    render();
  }
  async function askFilter() {
    const f = await prompt('Search:', filter);
    if (f === null) return;
    filter = f.trim();
    sel = 0;
    render();
  }
  async function askBatch() {
    const f = await prompt('Batch size:', String(batch));
    const n = Number(f);
    if (!f || !Number.isFinite(n) || n < 1) return;
    batch = Math.min(100, Math.floor(n));
    checks.clear();
    render();
  }
  function choose() {
    const e = entries[sel];
    if (!e) return;
    if (e.kind === 'nested') {
      nestedStack.push(e.n);
      sel = 0;
      render();
      return;
    }
    const res = startCraft(game, e.r, { batch });
    if (res.ok) win.close();
    else {
      refreshData();
      render();
    }
  }

  function render(rebuild = true) {
    if (rebuild) buildEntries();
    tabsEl.innerHTML = cats
      .map((ct, i) => `<span class="tab${i === tab && !filter ? ' sel' : ''}" data-t="${i}">&lt;${TAB_NAMES[ct.id] ?? ct.id.replace(/^CC_/, '')}&gt;</span>`)
      .join('');
    const subs = cats[tab].recipe_subcategories ?? ['CSC_ALL'];
    subEl.innerHTML = subs.map((s, i) => `<span class="tab${i === sub && !filter ? ' sel' : ''}" data-s="${i}">${subName(s, cats[tab].id)}</span>`).join('');
    tabsEl.querySelectorAll<HTMLElement>('.tab').forEach((el) => (el.onclick = () => setTab(Number(el.dataset.t))));
    subEl.querySelectorAll<HTMLElement>('.tab').forEach((el) => (el.onclick = () => setSub(Number(el.dataset.s))));
    const crumbs = filter
      ? `Searching: ${c('c_yellow', filter)}  (${entries.length} results)`
      : nestedStack.length
        ? `${c('c_light_blue', nestedStack.map((n) => n.name).join(' > '))}`
        : '';
    statusEl.innerHTML = `${crumbs}${batch > 1 ? `   ${c('c_light_cyan', `Batch: ${batch}`)}` : ''}${light ? '' : `   ${c('c_red', "It's too dark to craft!")}`}` || ' ';
    listEl.innerHTML = entries.length
      ? entries
          .map((e, i) => {
            const name = e.kind === 'nested' ? `+ ${e.n.name} >` : recipeName(data, e.r);
            return `<div class="row${i === sel ? ' sel' : ''}" data-i="${i}">${c(e.ok ? 'c_white' : 'c_dark_gray', name)}</div>`;
          })
          .join('')
      : `<div class="row">${c('c_dark_gray', filter ? 'Nothing found.' : 'You know no recipes in this category.')}</div>`;
    listEl.querySelectorAll<HTMLElement>('.row[data-i]').forEach((row) => {
      const i = Number(row.dataset.i);
      row.onclick = () => {
        if (sel === i) choose();
        else (sel = i), render(false);
      };
    });
    (listEl.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    const e = entries[sel];
    detailEl.innerHTML = e ? colorize(e.kind === 'recipe' ? recipeDetail(e.r, e.source).join('\n') : nestedDetail(e.n).join('\n')) : '';
  }

  function nestedDetail(n: NestedCategory): string[] {
    const recipes = n.members.filter((m) => known.has(m)).length;
    const groups = n.members.filter((m) => nestedById.has(m) && nestedAvailable(nestedById.get(m)!).any).length;
    const parts = [recipes ? `${recipes} recipe${recipes === 1 ? '' : 's'}` : '', groups ? `${groups} group${groups === 1 ? '' : 's'}` : ''].filter(Boolean);
    return [`<color_white>${n.name}</color>`, '', n.description ?? '', '', `Contains ${parts.join(' and ')} you know.  Press <color_light_green>Enter</color> to open.`];
  }

  function recipeDetail(r: RecipeDef, source: string): string[] {
    const ch = check(r);
    const out: string[] = [];
    const sk = (id: string, lvl: number) => {
      const have = player.getSkill(id);
      return `<color_${have >= lvl ? 'green' : 'red'}>${player.skillName(id)} (${lvl})</color>`;
    };
    if (r.skill_used) out.push(`Primary skill used: ${sk(r.skill_used, r.difficulty)}`);
    if (r.skills_required?.length) out.push(`Other skills used: ${r.skills_required.map(([s, l]) => sk(s, l)).join(', ')}`);
    const profs = recipeProficiencies(r);
    if (profs.length) {
      out.push(
        `Proficiencies used: ${profs
          .map((p) => {
            const name = cddaText(data.misc.proficiency?.[p.proficiency]?.name) || p.proficiency;
            const has = player.proficiencies.has(p.proficiency);
            return `<color_${has ? 'green' : p.required ? 'red' : 'yellow'}>${name}${p.required && !has ? ' (required)' : ''}</color>`;
          })
          .join(', ')}`,
      );
    }
    out.push(`Difficulty: <color_cyan>${r.difficulty}</color>`);
    if (r.skill_used) out.push(`Your skill level: <color_cyan>${player.getSkill(r.skill_used)}</color>`);
    out.push(`Time to complete: <color_cyan>${formatDuration(craftTime(player, r, batch))}</color>`);
    out.push(`Success chance: <color_cyan>${Math.round(successChance(player, r) * 100)}%</color>`);
    const dark = r.flags?.includes('BLIND_EASY') || r.flags?.includes('BLIND_HARD');
    out.push(`Dark craftable? <color_cyan>${dark ? 'Yes' : 'No'}</color>`);
    const mult = (r.result_mult ?? 1) * batch;
    if (mult > 1) out.push(`Recipe makes: <color_cyan>${mult}</color>`);
    if (source !== 'memory') out.push(`Recipe from: <color_light_blue>${cddaText(data.items[source]?.name) || source}</color>`);
    if (!ch.light) out.push('<color_red>Lighting conditions are too poor to craft this.</color>');
    if (ch.missingProficiencies.length) out.push(`<color_red>Missing required proficiencies: ${ch.missingProficiencies.join(', ')}</color>`);
    out.push('');
    out.push(...requirementLines(ch.req));
    if (r.byproducts?.length) {
      out.push('<color_white>Byproducts:</color>');
      for (const [id, n] of r.byproducts) out.push(`> ${n * batch} ${cddaText(data.items[id]?.name) || id}`);
    }
    const def = data.items[r.result];
    if (def) {
      out.push('', `<color_white>${cddaText(def.name)}</color>`);
      if (def.description) out.push(cddaText(def.description));
      out.push(`Volume: <color_cyan>${(def.volume / 1000).toFixed(2)}</color> L  Weight: <color_cyan>${(def.weight / 1000).toFixed(2)}</color> kg`);
    }
    return out;
  }

  const api: CraftingMenu = {
    win,
    setFilter(f) {
      filter = f;
      sel = 0;
      render();
    },
    setCategory(cat, subId) {
      const i = cats.findIndex((ct) => ct.id === cat);
      if (i < 0) throw new Error(`unknown recipe category ${cat}`);
      tab = i;
      sub = Math.max(0, subId ? (cats[i].recipe_subcategories ?? []).indexOf(subId) : 0);
      filter = '';
      nestedStack.length = 0;
      sel = 0;
      render();
    },
    select(id) {
      const i = entries.findIndex((e) => e.kind === 'recipe' && (e.r.id === id || e.r.result === id));
      if (i < 0) return false;
      sel = i;
      render(false);
      return true;
    },
    entries: () => entries.map(entryName),
  };
  current = api;
  render();
  return api;
}

function subName(s: string, cat: string): string {
  if (s === 'CSC_ALL') return 'ALL';
  const prefix = `CSC_${cat.replace(/^CC_/, '')}_`;
  return (s.startsWith(prefix) ? s.slice(prefix.length) : s.replace(/^CSC_/, '')).replace(/_/g, ' ');
}
