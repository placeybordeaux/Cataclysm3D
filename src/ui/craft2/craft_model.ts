// Data for the ui2 crafting and construction screens, DOM-free (tests/craft2.test.ts): which
// recipes a list shows for a filter/category/search, and "where can I get this component"
// facts for the missing-component popover.

import type { GameData, RecipeDef } from '../../data/types';
import { availableRecipes, canCraft, recipeName, type CraftCheck, type CraftHost, type KnownRecipe } from '../../game/crafting';
import type { CraftingInventory } from '../../game/crafting_inv';
import { uncraftIndex } from '../../game/disassembly';
import { itemDisplayName, qualityName } from '../../game/requirements';
import { cddaText } from '../../game/units';

export type CraftFilter = 'craftable' | 'some' | 'known' | 'favs';

export const FILTERS: { id: CraftFilter; label: string; hint: string }[] = [
  { id: 'craftable', label: 'Craftable', hint: 'Everything you could make right now' },
  { id: 'some', label: 'Have some', hint: 'Recipes you have at least one component for' },
  { id: 'known', label: 'All known', hint: 'Every recipe you know or can read from a book in reach' },
  { id: 'favs', label: '★ Favourites', hint: 'Recipes you starred' },
];

/** Category tabs (BN recipe_category order); ALL and RECENT first. */
export const CATEGORIES: { id: string; label: string; icon: string }[] = [
  { id: 'ALL', label: 'All', icon: 'toolbox' },
  { id: 'RECENT', label: 'Recent', icon: 'wristwatch' },
  { id: 'CC_WEAPON', label: 'Weapons', icon: 'spear_wood' },
  { id: 'CC_AMMO', label: 'Ammo', icon: 'arrow_wood' },
  { id: 'CC_FOOD', label: 'Food', icon: 'can_beans' },
  { id: 'CC_CHEM', label: 'Chems', icon: 'chem_black_powder' },
  { id: 'CC_ELECTRONIC', label: 'Electronics', icon: 'flashlight' },
  { id: 'CC_ARMOR', label: 'Armor', icon: 'backpack' },
  { id: 'CC_OTHER', label: 'Other', icon: 'hammer' },
  { id: 'CC_ANIMALS', label: 'Animals', icon: 'rope_6' },
];

export interface RecipeRow {
  recipe: RecipeDef;
  /** 'memory' or the book it's read from. */
  source: string;
  name: string;
  check: CraftCheck;
  /** At least one component alternative is at hand. */
  some: boolean;
  isNew: boolean;
}

export interface RowQuery {
  filter: CraftFilter;
  category: string;
  /** BN subcategory id (CSC_…) or '' for all. */
  sub?: string;
  /** Search text: plain = recipe name; c: component, t: tool/quality, s: skill, d: description. */
  query: string;
  favourites: ReadonlySet<string>;
  recent: readonly string[];
  isNew: (id: string) => boolean;
}

/** Everything the screen needs per recipe, computed once per open / inventory change. */
export class RecipeBook {
  readonly known: KnownRecipe[];
  private checks = new Map<string, CraftCheck>();
  constructor(readonly host: CraftHost, readonly inv: CraftingInventory, readonly batch = 1) {
    this.known = availableRecipes(host.player, inv);
  }
  check(r: RecipeDef, batch = this.batch): CraftCheck {
    const key = `${r.id}#${batch}`;
    let c = this.checks.get(key);
    if (!c) this.checks.set(key, (c = canCraft(this.host, r, batch, this.inv)));
    return c;
  }
  rows(q: RowQuery): RecipeRow[] {
    const data = this.host.data;
    const match = searchMatcher(data, q.query);
    const out: RecipeRow[] = [];
    const recentIdx = new Map(q.recent.map((id, i) => [id, i]));
    for (const k of this.known) {
      const r = k.recipe;
      if (q.category === 'RECENT' ? !recentIdx.has(r.id) : q.category !== 'ALL' && r.category !== q.category) continue;
      if (q.sub && q.category !== 'ALL' && q.category !== 'RECENT' && r.subcategory !== q.sub) continue;
      if (q.filter === 'favs' && !q.favourites.has(r.id)) continue;
      if (!match(r)) continue;
      const check = this.check(r);
      const some = check.req.components.some((g) => g.alts.some((a) => a.avail > 0)) || !check.req.components.length;
      if (q.filter === 'craftable' && !check.ok) continue;
      if (q.filter === 'some' && !some) continue;
      out.push({ recipe: r, source: k.source, name: recipeName(data, r), check, some, isNew: q.isNew(r.id) });
    }
    if (q.category === 'RECENT') out.sort((a, b) => recentIdx.get(a.recipe.id)! - recentIdx.get(b.recipe.id)!);
    else out.sort((a, b) => Number(b.isNew) - Number(a.isNew) || Number(b.check.ok) - Number(a.check.ok) || a.name.localeCompare(b.name));
    return out;
  }
}

/** BN recipe filter prefixes: c: component, t: tool or quality, s: skill, d: description, else name. */
export function searchMatcher(data: GameData, query: string): (r: RecipeDef) => boolean {
  const q = query.trim().toLowerCase();
  if (!q) return () => true;
  const m = /^([ctsdq]):\s*(.*)$/.exec(q);
  const kind = m ? m[1] : 'n';
  const text = m ? m[2] : q;
  if (!text) return () => true;
  const has = (s: string | undefined) => !!s && s.toLowerCase().includes(text);
  const item = (id: string) => has(itemDisplayName(data, id)) || has(id);
  return (r) => {
    switch (kind) {
      case 'c':
        return (r.components ?? []).some((g) => g.some((c) => item(c.id)));
      case 't':
      case 'q':
        return (r.tools ?? []).some((g) => g.some((t) => item(t.id))) || (r.qualities ?? []).some((g) => g.some((x) => has(qualityName(data, x.id)) || has(x.id)));
      case 's':
        return has(r.skill_used) || (r.skills_required ?? []).some(([s]) => has(s) || has(cddaText(data.misc.skill?.[s]?.name)));
      case 'd':
        return has(cddaText(data.items[r.result]?.description));
      default:
        return has(recipeName(data, r)) || has(r.result);
    }
  };
}

const reverseCache = new WeakMap<GameData, { makes: Map<string, RecipeDef[]>; salvage: Map<string, string[]> }>();
function reverse(data: GameData) {
  let r = reverseCache.get(data);
  if (r) return r;
  const makes = new Map<string, RecipeDef[]>(), salvage = new Map<string, string[]>();
  for (const rec of data.recipes) {
    const l = makes.get(rec.result) ?? [];
    l.push(rec);
    makes.set(rec.result, l);
  }
  for (const [itemId, rec] of uncraftIndex(data)) {
    for (const g of rec.components ?? []) {
      const c = g[0];
      if (!c) continue;
      const l = salvage.get(c.id) ?? [];
      if (l.length < 12) l.push(itemId);
      salvage.set(c.id, l);
    }
  }
  reverseCache.set(data, (r = { makes, salvage }));
  return r;
}

/** Where a component comes from: recipes that make it (known ones first) and things that come apart into it. */
export function sourcesOf(host: CraftHost, id: string, known: ReadonlySet<string>): { craft: RecipeDef[]; salvage: string[] } {
  const r = reverse(host.data);
  const craft = [...(r.makes.get(id) ?? [])].sort((a, b) => Number(known.has(b.id)) - Number(known.has(a.id)));
  return { craft: craft.slice(0, 6), salvage: (r.salvage.get(id) ?? []).slice(0, 8) };
}

const PREFERRED_QUALITY_ICON: Record<string, string[]> = {
  CUT: ['knife_folding', 'knife_butcher', 'knife_combat'],
  HAMMER: ['hammer', 'hammer_sledge'],
  DIG: ['shovel', 'e_tool'],
  PRY: ['crowbar', 'halligan'],
  SAW_W: ['saw', 'hacksaw'],
  SAW_M: ['hacksaw'],
  SAW_M_FINE: ['hacksaw'],
  SCREW: ['screwdriver', 'screwdriver_set'],
  SCREW_FINE: ['screwdriver_set'],
  WRENCH: ['wrench'],
  CHISEL: ['chisel'],
  AXE: ['hatchet', 'ax'],
  BOIL: ['pot', 'pan'],
  COOK: ['pot', 'pan'],
  CONTAIN: ['pot', 'jar_glass'],
  SEW: ['sewing_kit'],
  GLARE: ['goggles_welding'],
  WELD: ['welder'],
  DRILL: ['hand_drill'],
  SANDING: ['sandpaper'],
  CUT_FINE: ['scalpel', 'knife_folding'],
  BUTCHER: ['knife_butcher'],
  PULL: ['pliers'],
  SMOOTH: ['file'],
};

const qualityIconCache =new WeakMap<GameData, Map<string, string>>();
/** A representative item for a tool quality icon: the lightest item with it at `level` or better. */
export function qualityIcon(data: GameData, id: string, level: number): string | undefined {
  let m = qualityIconCache.get(data);
  if (!m) qualityIconCache.set(data, (m = new Map()));
  const key = `${id}:${level}`;
  if (m.has(key)) return m.get(key);
  // Familiar tools first (the lightest item with a quality is often something odd without a sprite).
  const pref = PREFERRED_QUALITY_ICON[id]?.find((i) => (data.items[i]?.qualities ?? []).some(([q, l]) => q === id && l >= level));
  if (pref) {
    m.set(key, pref);
    return pref;
  }
  let best: { id: string; w: number } | null = null;
  for (const d of Object.values(data.items)) {
    if (d.flags?.includes('PSEUDO')) continue;
    if (!(d.qualities ?? []).some(([q, l]) => q === id && l >= level)) continue;
    if (!best || d.weight < best.w) best = { id: d.id, w: d.weight };
  }
  m.set(key, best?.id ?? '');
  return best?.id;
}
