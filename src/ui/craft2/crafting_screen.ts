// The ui2 crafting screen (`&`): a searchable recipe browser after BN's crafting_gui, mouse
// first. Category icon tabs; a filter (craftable now / have some components / all known /
// favourites); the recipe list with result icons (craftable ones bright, new ones marked);
// the recipe on the right with every tool, quality and component as an icon chip showing
// have/need (click one: what it is, and where to get it); batch size, favourite, queue, craft.
// Below: crafts in progress (continue / take apart) and the queue.
//
// Keys: type to search (c: component, t: tool, s: skill, d: description), ↑/↓ PgUp/PgDn pick,
// Enter crafts, Ctrl+Enter queues, Tab / Shift+Tab switch category, Ctrl+↑/↓ batch, Esc closes.

import type { RecipeDef } from '../../data/types';
import {
  abandonCraft, booksForRecipe, cantContinue, continueCraft, craftingInventory, craftQueue, craftTime, formatDuration, inProgressCrafts, knowsRecipe,
  lightSpeedMultiplier, recipeName, startCraft, successChance, type CraftHost,
} from '../../game/crafting';
import type { AltEval } from '../../game/requirements';
import { itemDisplayName, qualityName } from '../../game/requirements';
import { cddaText } from '../../game/units';
import { newRecipes } from '../../progression/discovery';
import { attachTooltip, button, h, iconEl, itemTooltip, openPanel, type Panel } from '../../ui2';
import { defView, itemIconRef, rememberedWindow, requirementSections, searchField, storedList } from './common';
import { CATEGORIES, FILTERS, RecipeBook, sourcesOf, type CraftFilter, type RecipeRow } from './craft_model';
import './craft2.css';

const favStore = storedList('cdda3d.craft.favourites');
const recentStore = storedList('cdda3d.craft.recent');
const PANEL_ID = 'craft.recipes';

export interface CraftingScreen {
  panel: Panel;
  setQuery(q: string): void;
  setFilter(f: CraftFilter): void;
  setCategory(c: string): void;
  select(recipeIdOrResult: string): boolean;
  rows(): string[];
  selected(): string | null;
  craft(): boolean;
  refresh(): void;
}

let current: CraftingScreen | null = null;
export function craftingScreen(): CraftingScreen | null {
  return current && !current.panel.closed ? current : null;
}

export function openCraftingScreen(game: CraftHost): CraftingScreen {
  const existing = craftingScreen();
  if (existing) {
    existing.panel.close();
    return existing;
  }
  const data = game.data;
  const player = game.player;
  let filter: CraftFilter = 'craftable';
  let category = 'ALL';
  let sub = '';
  let query = '';
  let batch = 1;
  let selId: string | null = null;
  let info: AltEval | null = null;
  const favourites = new Set(favStore.get());
  let book = new RecipeBook(game, craftingInventory(game));
  let rows: RecipeRow[] = [];
  // Recipes the discovery nudges announced: marked NEW until this screen closes.
  const fresh = new Set(newRecipes);

  // --- layout
  const search = searchField('Search recipes…  (c: component, t: tool, s: skill)', (v) => {
    query = v;
    rebuild();
  });
  const filterBar = h('div', { class: 'c2-filters' });
  const catBar = h('div', { class: 'c2-cats', attrs: { role: 'tablist' } });
  const subBar = h('div', { class: 'c2-subs' });
  const list = h('div', { class: 'c2-list', attrs: { role: 'listbox', tabindex: '-1' } });
  const count = h('div', { class: 'c2-count ui2-dim ui2-small' });
  const detail = h('div', { class: 'c2-detail' });
  const bottom = h('div', { class: 'c2-bottom' });
  const panel = openPanel({
    id: PANEL_ID,
    title: 'Crafting',
    icon: itemIconRef(data, 'toolbox'),
    width: 'min(calc(var(--fs) * 62), 96vw)',
    height: 'min(calc(var(--fs) * 36), 92vh)',
    group: 'craft',
    pauses: true,
    footer: 'Type to search · ↑↓ pick · Enter craft · Ctrl+Enter queue · Tab category · Ctrl+↑↓ batch · Esc close',
    onClose: () => {
      newRecipes.clear();
      current = null;
      unsub();
    },
  });
  panel.body.classList.add('c2-craft');
  panel.body.append(
    h('div', { class: 'c2-top' }, search, filterBar),
    catBar,
    subBar,
    h('div', { class: 'c2-main' }, h('div', { class: 'c2-left' }, list, count), detail),
    bottom,
  );
  const x = Math.max(8, (window.innerWidth - panel.el.getBoundingClientRect().width) / 2);
  const y = Math.max(8, (window.innerHeight - panel.el.getBoundingClientRect().height) / 2);
  if (!rememberedWindow(PANEL_ID)) panel.moveTo(x, y);

  const queue = craftQueue(game);
  const onQueue = () => renderBottom();
  queue.listeners.add(onQueue);
  const unsub = () => queue.listeners.delete(onQueue);

  // --- filters & categories
  const renderFilters = () => {
    filterBar.replaceChildren(
      ...FILTERS.map((f) => {
        const b = h('button', { class: `c2-filter${f.id === filter ? ' on' : ''}`, text: f.label, title: f.hint, data: { filter: f.id } });
        b.addEventListener('click', () => api.setFilter(f.id));
        return b;
      }),
    );
  };
  const renderCats = () => {
    const newByCat = new Map<string, number>();
    for (const k of book.known) if (fresh.has(k.recipe.id)) newByCat.set(k.recipe.category, (newByCat.get(k.recipe.category) ?? 0) + 1);
    const totalNew = [...newByCat.values()].reduce((a, b) => a + b, 0);
    catBar.replaceChildren(
      ...CATEGORIES.map((c) => {
        const n = c.id === 'ALL' ? totalNew : newByCat.get(c.id) ?? 0;
        const b = h(
          'button',
          { class: `c2-cat${c.id === category ? ' on' : ''}`, title: c.label, data: { cat: c.id }, attrs: { role: 'tab' } },
          iconEl(itemIconRef(data, c.icon), 'row'),
          h('span', { text: c.label }),
          n ? h('span', { class: 'c2-new-dot', text: String(n) }) : null,
        );
        b.addEventListener('click', () => api.setCategory(c.id));
        return b;
      }),
    );
    const subs = (data.misc.recipe_category?.[category]?.recipe_subcategories ?? []) as string[];
    const shown = subs.filter((s) => s !== 'CSC_ALL' && !s.endsWith('_NESTED') && book.known.some((k) => k.recipe.subcategory === s));
    subBar.style.display = shown.length ? '' : 'none';
    subBar.replaceChildren(
      ...['', ...shown].map((s) => {
        const label = s ? s.replace(/^CSC_[A-Z]+_/, '').replace(/_/g, ' ').toLowerCase() : 'all';
        const b = h('button', { class: `c2-sub${s === sub ? ' on' : ''}`, text: label });
        b.addEventListener('click', () => {
          sub = s;
          rebuild();
        });
        return b;
      }),
    );
  };

  // --- the list
  const rowEl = (r: RecipeRow): HTMLElement => {
    const el = h(
      'div',
      { class: `c2-row${r.check.ok ? ' ok' : ''}${r.recipe.id === selId ? ' selected' : ''}`, data: { id: r.recipe.id }, attrs: { role: 'option' } },
      iconEl(itemIconRef(data, r.recipe.result), 'row'),
      h('span', { class: 'c2-row-name', text: r.name }),
      r.isNew ? h('span', { class: 'c2-new', text: 'NEW' }) : null,
      favourites.has(r.recipe.id) ? h('span', { class: 'c2-fav', text: '★' }) : null,
      r.source !== 'memory' ? h('span', { class: 'c2-book', title: `From ${cddaText(data.items[r.source]?.name)}`, text: '📖' }) : null,
    );
    el.addEventListener('click', () => select(r.recipe.id));
    el.addEventListener('dblclick', () => doCraft());
    attachTooltip(el, () => itemTooltip(defView(data, r.recipe.result, resultCount(r.recipe, 1)), { hints: ['Double-click: craft'] }));
    return el;
  };
  const renderList = () => {
    list.replaceChildren(...rows.map(rowEl));
    if (!rows.length) {
      const hint =
        filter === 'craftable' ? 'Nothing you can make with what is at hand. Try "Have some" or "All known".'
        : filter === 'favs' ? 'No favourites yet: star a recipe with ☆.'
        : query ? 'No recipe matches.' : 'No recipes here yet: skills and books teach more.';
      list.append(h('div', { class: 'ui2-empty', text: hint }));
    }
    const ok = rows.filter((r) => r.check.ok).length;
    count.textContent = `${rows.length} recipe${rows.length === 1 ? '' : 's'}${filter !== 'craftable' ? ` · ${ok} craftable now` : ''}`;
  };
  const select = (id: string | null, scroll = true) => {
    selId = id;
    info = null;
    batch = 1;
    list.querySelectorAll('.c2-row').forEach((r) => r.classList.toggle('selected', (r as HTMLElement).dataset.id === id));
    if (scroll) (list.querySelector('.c2-row.selected') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    renderDetail();
  };
  const move = (d: number) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.recipe.id === selId);
    select(rows[Math.max(0, Math.min(rows.length - 1, (i < 0 ? 0 : i) + d))].recipe.id);
  };
  const rebuild = () => {
    rows = book.rows({ filter, category, sub, query, favourites, recent: recentStore.get(), isNew: (id) => fresh.has(id) });
    renderFilters();
    renderCats();
    renderList();
    if (!rows.some((r) => r.recipe.id === selId)) select(rows[0]?.recipe.id ?? null, false);
    else renderDetail();
  };

  // --- the recipe
  const resultCount = (r: RecipeDef, b: number) => {
    const d = data.items[r.result];
    if (!d) return 1;
    return (d.count_by_charges ? (r.charges ?? 1) : 1) * (r.result_mult ?? 1) * b;
  };
  const renderDetail = () => {
    const row = rows.find((r) => r.recipe.id === selId);
    if (!row) {
      detail.replaceChildren(h('div', { class: 'ui2-empty', text: 'Pick a recipe.' }));
      return;
    }
    const r = row.recipe;
    const ch = book.check(r, batch);
    const def = data.items[r.result];
    const head = h(
      'div',
      { class: 'c2-head' },
      iconEl(itemIconRef(data, r.result), 'grid'),
      h(
        'div',
        { class: 'c2-head-text' },
        h('div', { class: 'c2-title', text: `${recipeName(data, r)}${resultCount(r, batch) > 1 ? ` ×${resultCount(r, batch)}` : ''}` }),
        h('div', { class: 'ui2-dim ui2-small', text: row.source === 'memory' ? (knowsRecipe(player, r) ? 'Known by heart' : '') : `Following ${cddaText(data.items[row.source]?.name)} (in reach)` }),
      ),
    );
    attachTooltip(head, () => itemTooltip(defView(data, r.result, resultCount(r, batch)), { hints: [] }));
    const facts = h('div', { class: 'c2-facts' });
    const fact = (label: string, value: string, tone = '') => facts.append(h('div', { class: 'c2-fact' }, h('span', { class: 'ui2-dim', text: label }), h('span', { class: tone, text: value })));
    if (r.skill_used) {
      const have = player.getSkill(r.skill_used);
      fact('Skill', `${player.skillName(r.skill_used)} ${r.difficulty} (you ${have})`, have >= r.difficulty ? 'tone-good' : 'tone-warn');
    }
    for (const [s, l] of r.skills_required ?? []) fact('Also', `${player.skillName(s)} ${l} (you ${player.getSkill(s)})`, player.getSkill(s) >= l ? 'tone-good' : 'tone-warn');
    const light = lightSpeedMultiplier(game, r);
    const secs = craftTime(player, r, batch, ch.speed || 1);
    fact('Time', formatDuration(secs), '');
    fact('Success', `${Math.round(successChance(player, r) * 100)}%`, successChance(player, r) >= 0.8 ? 'tone-good' : successChance(player, r) >= 0.4 ? 'tone-warn' : 'tone-bad');
    if (light < 1) fact('Light', light > 0 ? `too dark: ${Math.round(light * 100)}% speed` : "too dark: can't", light > 0 ? 'tone-warn' : 'tone-bad');
    const desc = def ? cddaText(def.description) : '';
    const sections = requirementSections(data, ch.req, { onClick: (a) => showInfo(a), selected: (a) => !!info && info.id === a.id && info.kind === a.kind });
    const infoBox = info ? infoPanel(info) : null;
    const byp = (r.byproducts ?? []).length
      ? h('div', { class: 'c2-byp ui2-small ui2-dim', text: `Also makes: ${r.byproducts!.map(([id, n]) => `${n * batch} ${itemDisplayName(data, id, n * batch)}`).join(', ')}` })
      : null;
    const learn = !knowsRecipe(player, r) && row.source === 'memory' ? null : !knowsRecipe(player, r) ? h('div', { class: 'ui2-small ui2-dim', text: 'Crafting it from the book may commit it to memory.' }) : null;
    const books = booksForRecipe(data, r);
    const bookLine = !knowsRecipe(player, r) && books.length ? h('div', { class: 'ui2-small ui2-dim', text: `In: ${books.slice(0, 4).map((b) => cddaText(data.items[b.book]?.name)).join(', ')}` }) : null;

    // actions
    const fav = favourites.has(r.id);
    const favBtn = button(fav ? '★' : '☆', () => {
      if (favourites.has(r.id)) favourites.delete(r.id);
      else favourites.add(r.id);
      favStore.set([...favourites]);
      rebuild();
    }, { small: true, title: fav ? 'Remove from favourites' : 'Add to favourites', tone: fav ? 'accent' : undefined });
    const batchEl = h('span', { class: 'c2-batch-n', text: `×${batch}` });
    const setBatch = (n: number) => {
      batch = Math.max(1, Math.min(50, n));
      renderDetail();
    };
    const minus = button('−', () => setBatch(batch - 1), { small: true, title: 'Smaller batch (Ctrl+↓)', disabled: batch <= 1 });
    const plus = button('+', () => setBatch(batch + 1), { small: true, title: 'Bigger batch (Ctrl+↑)' });
    const batchBox = h('div', { class: 'c2-batch', title: 'Batch size: several at once (some recipes save time in batches)' }, h('span', { class: 'ui2-dim ui2-small', text: 'Batch' }), minus, batchEl, plus);
    batchBox.addEventListener('wheel', (e) => {
      e.preventDefault();
      setBatch(batch + (e.deltaY < 0 ? 1 : -1));
    });
    const why = ch.ok ? undefined : ch.missing.join('\n');
    const queueBtn = button('Queue', () => addToQueue(), { small: true, title: 'Add to the craft queue (Ctrl+Enter)' });
    const craftBtn = button(`Craft${batch > 1 ? ` ×${batch}` : ''}`, () => doCraft(), { tone: 'accent', disabled: why ?? false, key: 'Enter', title: why ? `Can't craft: ${why}` : `Takes ${formatDuration(secs)}` });
    const actions = h('div', { class: 'c2-actions' }, favBtn, batchBox, h('span', { class: 'c2-spacer' }), queueBtn, craftBtn);

    detail.replaceChildren(
      head,
      h('div', { class: 'c2-scroll' }, facts, desc ? h('div', { class: 'c2-desc', text: desc }) : null, ...sections, infoBox, byp, learn, bookLine),
      actions,
    );
  };

  // --- "where do I get this?"
  const showInfo = (a: AltEval) => {
    info = info && info.id === a.id && info.kind === a.kind ? null : a;
    renderDetail();
    detail.querySelector('.c2-info')?.scrollIntoView({ block: 'nearest' });
  };
  const infoPanel = (a: AltEval): HTMLElement => {
    const box = h('div', { class: 'c2-info' });
    if (a.kind === 'quality') {
      const q = data.misc.tool_quality?.[a.id];
      box.append(h('div', { class: 'c2-info-title', text: `${qualityName(data, a.id)} ${a.need}` }));
      if (q?.description) box.append(h('div', { class: 'ui2-small', text: cddaText(q.description) }));
      const tools = Object.values(data.items)
        .filter((d) => !d.flags?.includes('PSEUDO') && (d.qualities ?? []).some(([id, l]) => id === a.id && l >= a.need))
        .sort((x, y) => x.weight - y.weight)
        .slice(0, 8);
      box.append(h('div', { class: 'ui2-small ui2-dim', text: 'Tools with it:' }), h('div', { class: 'c2-info-row' }, ...tools.map((d) => chipFor(d.id))));
      return box;
    }
    const d = data.items[a.id];
    box.append(h('div', { class: 'c2-info-title' }, iconEl(itemIconRef(data, a.id), 'row'), h('span', { text: itemDisplayName(data, a.id) })));
    if (d?.description) box.append(h('div', { class: 'ui2-small', text: cddaText(d.description) }));
    box.append(h('div', { class: 'ui2-small', text: a.avail > 0 ? `At hand: ${a.avail === Infinity ? 'yes' : a.avail}` : 'You have none within reach (carried, or on the ground within 2 steps).' }));
    const knownIds = new Set(book.known.map((k) => k.recipe.id));
    const src = sourcesOf(game, a.id, knownIds);
    if (src.craft.length) {
      box.append(h('div', { class: 'ui2-small ui2-dim', text: 'Make it:' }));
      const row = h('div', { class: 'c2-info-row' });
      for (const rec of src.craft) {
        const known = knownIds.has(rec.id);
        const b = button(`${recipeName(data, rec)}${known ? '' : ' (unknown)'}`, () => {
          if (!known) return;
          query = '';
          search.value = '';
          filter = 'known';
          category = 'ALL';
          sub = '';
          rebuild();
          select(rec.id);
        }, { small: true, icon: itemIconRef(data, rec.result), disabled: known ? false : 'You don\'t know this recipe yet (skills or a book teach it).' });
        row.append(b);
      }
      box.append(row);
    }
    if (src.salvage.length) box.append(h('div', { class: 'ui2-small ui2-dim', text: 'Take apart:' }), h('div', { class: 'c2-info-row' }, ...src.salvage.map((id) => chipFor(id))));
    if (!src.craft.length && !src.salvage.length) box.append(h('div', { class: 'ui2-small ui2-dim', text: 'Found while scavenging.' }));
    return box;
  };
  const chipFor = (id: string) => {
    const el = h('span', { class: 'c2-mini' }, iconEl(itemIconRef(data, id), 'row'), h('span', { text: itemDisplayName(data, id) }));
    attachTooltip(el, () => itemTooltip(defView(data, id), { hints: [] }));
    return el;
  };

  // --- crafting, queue, in progress
  const remember = (r: RecipeDef) => recentStore.set([r.id, ...recentStore.get().filter((x) => x !== r.id)].slice(0, 30));
  const doCraft = (): boolean => {
    const row = rows.find((r) => r.recipe.id === selId);
    if (!row) return false;
    const ch = book.check(row.recipe, batch);
    if (!ch.ok) {
      game.message(`You can't craft that: missing ${ch.missing.join('; ')}.`, 'c_light_red');
      return false;
    }
    remember(row.recipe);
    panel.close();
    return startCraft(game, row.recipe, { batch }).ok;
  };
  const addToQueue = () => {
    const row = rows.find((r) => r.recipe.id === selId);
    if (!row) return;
    remember(row.recipe);
    queue.add(row.recipe, batch);
  };
  const renderBottom = () => {
    if (panel.closed) return;
    const crafts = inProgressCrafts(game);
    const parts: (HTMLElement | null)[] = [];
    if (crafts.length) {
      parts.push(h('div', { class: 'ui2-section', text: 'In progress' }));
      const row = h('div', { class: 'c2-strip' });
      for (const c of crafts) {
        const why = cantContinue(game, c.item);
        const card = h(
          'div',
          { class: 'c2-wip' },
          iconEl(itemIconRef(data, c.state.recipe.result), 'row'),
          h('span', { text: `${recipeName(data, c.state.recipe)} ${Math.floor(c.state.progress * 100)}%${c.nearby ? ' (nearby)' : ''}` }),
          button('Continue', () => {
            panel.close();
            continueCraft(game, c.item);
          }, { small: true, tone: 'accent', disabled: why ?? false }),
          button('Take apart', () => {
            abandonCraft(game, c.item);
            refresh();
          }, { small: true, title: 'Get the components back (progress is lost)' }),
        );
        row.append(card);
      }
      parts.push(row);
    }
    if (queue.entries.length || queue.current) {
      parts.push(h('div', { class: 'ui2-section', text: `Queue${queue.running ? ' (running)' : ''}` }));
      const row = h('div', { class: 'c2-strip' });
      if (queue.current) row.append(h('div', { class: 'c2-q now' }, iconEl(itemIconRef(data, queue.current.recipe.result), 'row'), h('span', { text: `${recipeName(data, queue.current.recipe)} ×${queue.current.batch} (now)` })));
      queue.entries.forEach((e, i) => {
        const x = h('button', { class: 'ui2-iconbtn', title: 'Remove', text: '×' });
        x.addEventListener('click', () => queue.remove(e.id));
        row.append(h('div', { class: 'c2-q' }, h('span', { class: 'ui2-dim', text: `${i + 1}.` }), iconEl(itemIconRef(data, e.recipe.result), 'row'), h('span', { text: `${recipeName(data, e.recipe)} ×${e.batch}` }), x));
      });
      if (queue.entries.length && !queue.running)
        row.append(button('Start queue', () => {
          panel.close();
          queue.resume();
        }, { small: true, tone: 'accent' }));
      if (queue.entries.length) row.append(button('Clear', () => queue.clear(), { small: true }));
      parts.push(row);
    }
    bottom.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
    bottom.style.display = parts.length ? '' : 'none';
  };

  const refresh = () => {
    book = new RecipeBook(game, craftingInventory(game));
    rebuild();
    renderBottom();
  };

  // --- keys (the search field has focus; the game's Input ignores keys aimed at inputs)
  const cycleCat = (d: number) => {
    const i = CATEGORIES.findIndex((c) => c.id === category);
    api.setCategory(CATEGORIES[(i + d + CATEGORIES.length) % CATEGORIES.length].id);
  };
  const onKey = (e: KeyboardEvent): boolean => {
    const k = e.key;
    if (k === 'Escape') panel.close();
    else if (k === 'ArrowUp' && e.ctrlKey) (batch++, renderDetail());
    else if (k === 'ArrowDown' && e.ctrlKey) ((batch = Math.max(1, batch - 1)), renderDetail());
    else if (k === 'ArrowDown') move(1);
    else if (k === 'ArrowUp') move(-1);
    else if (k === 'PageDown') move(10);
    else if (k === 'PageUp') move(-10);
    else if (k === 'Enter' && e.ctrlKey) addToQueue();
    else if (k === 'Enter') doCraft();
    else if (k === 'Tab') cycleCat(e.shiftKey ? -1 : 1);
    else return false;
    return true;
  };
  search.addEventListener('keydown', (e) => {
    if (onKey(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
  // Typing anywhere in the window goes to the search.
  panel.el.addEventListener('keydown', (e) => {
    if (e.target === search) return;
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey) search.focus();
    else if (onKey(e)) e.preventDefault();
  });

  const api: CraftingScreen = {
    panel,
    setQuery(q) {
      query = q;
      search.value = q;
      rebuild();
    },
    setFilter(f) {
      filter = f;
      rebuild();
    },
    setCategory(c) {
      if (!CATEGORIES.some((x) => x.id === c)) throw new Error(`crafting: no category ${c}`);
      category = c;
      sub = '';
      rebuild();
    },
    select(id) {
      const row = rows.find((r) => r.recipe.id === id) ?? rows.find((r) => r.recipe.result === id);
      if (!row) return false;
      select(row.recipe.id);
      return true;
    },
    rows: () => rows.map((r) => r.recipe.id),
    selected: () => selId,
    craft: doCraft,
    refresh,
  };
  current = api;
  // Nothing craftable: start on everything known instead of an empty list.
  rows = book.rows({ filter, category, sub, query, favourites, recent: [], isNew: (id) => fresh.has(id) });
  if (!rows.length) filter = 'known';
  if ([...fresh].some((id) => book.known.some((k) => k.recipe.id === id))) {
    filter = 'known';
  }
  rebuild();
  renderBottom();
  // After the opening key's keypress: focusing now would type the '&' into the field.
  requestAnimationFrame(() => search.focus());
  return api;
}
