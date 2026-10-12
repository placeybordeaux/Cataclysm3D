import type { GameData, QualityRequirement, RecipeComponent, RequirementData } from '../data/types';
import { countByCharges } from './item';
import type { CraftingInventory } from './crafting_inv';
import { cddaText } from './units';

// requirement_data (requirements.cpp): components, tools and qualities as AND-of-OR groups,
// checked against a CraftingInventory and rendered in CDDA's colored list format:
//   Tools required:
//   > 1 tool with cutting of 2 or more.
//   > fire
//   Components required:
//   > 1 long stick OR 1 long pointy stick
// Colors follow get_color(): green = available, dark gray = unavailable but another
// alternative in the same group is, red = nothing in the group is available.

export interface AltEval {
  text: string;
  have: boolean;
  color: string;
  /** What it is, for icon rows: an item id (tool/component) or a quality id. */
  kind: 'quality' | 'tool' | 'component';
  id: string;
  /** Needed: components (charges for count-by-charges), tool charges (0 = just the tool), quality level. */
  need: number;
  /** Available: component count, tool charges (Infinity for pseudo tools), best quality level. */
  avail: number;
}

export interface GroupEval {
  ok: boolean;
  alts: AltEval[];
}

export interface RequirementEval {
  ok: boolean;
  qualities: GroupEval[];
  tools: GroupEval[];
  components: GroupEval[];
  /** Plain-text descriptions of every unsatisfied group, for messages and debug. */
  missing: string[];
}

export function itemDisplayName(data: GameData, id: string, n = 1): string {
  const d = data.items[id];
  if (!d) return id;
  return n === 1 ? cddaText(d.name) : cddaText(d.name_plural || d.name, true);
}

export function qualityName(data: GameData, id: string): string {
  return cddaText(data.misc.tool_quality?.[id]?.name) || id.toLowerCase();
}

export function qualityText(data: GameData, q: QualityRequirement): string {
  const n = q.amount ?? 1;
  return `${n} tool${n === 1 ? '' : 's'} with ${qualityName(data, q.id)} of ${q.level} or more.`;
}

export function toolText(data: GameData, t: RecipeComponent, batch = 1): string {
  if (t.count > 0) {
    const n = t.count * batch;
    return `${itemDisplayName(data, t.id)} (${n} charge${n === 1 ? '' : 's'})`;
  }
  return itemDisplayName(data, t.id);
}

export function componentText(data: GameData, c: RecipeComponent, batch = 1, avail = 0): string {
  const n = Math.abs(c.count) * batch;
  const def = data.items[c.id];
  const byCharges = def ? countByCharges(def) : false;
  const name = byCharges ? itemDisplayName(data, c.id, n === 1 ? 1 : 2) : itemDisplayName(data, c.id, n);
  return avail > 0 ? `${n} ${name} (have ${avail})` : `${n} ${name}`;
}

function finishGroup(alts: AltEval[]): GroupEval {
  const ok = alts.some((a) => a.have);
  for (const a of alts) a.color = a.have ? 'c_green' : ok ? 'c_dark_gray' : 'c_red';
  // CDDA lists available alternatives first.
  alts.sort((a, b) => Number(b.have) - Number(a.have));
  return { ok, alts };
}

/** Check a requirement set for `batch` crafts against what's at hand. */
export function evaluateRequirements(data: GameData, req: Partial<RequirementData>, inv: CraftingInventory, batch = 1): RequirementEval {
  const qualities = (req.qualities ?? []).map((grp) =>
    finishGroup(grp.map((q) => ({ text: qualityText(data, q), have: inv.hasQuality(q.id, q.level, q.amount ?? 1), color: '', kind: 'quality' as const, id: q.id, need: q.level, avail: inv.maxQuality(q.id) }))),
  );
  // Installed tools share battery energy. Check groups in consumption order so
  // a welding rig and kitchen cannot each promise the same remaining charges.
  const budget = inv.sources.some(s => s.resource) ? new Map<object, number>() : undefined;
  const tools = (req.tools ?? []).map((grp) => {
    const result = finishGroup(
      grp.map((t) => {
        const charges = t.count > 0 ? inv.toolChargesOf(t.id, budget) : inv.hasTool(t.id) ? 1 : 0;
        const have = t.count > 0 ? charges >= t.count * batch : charges > 0;
        return { text: toolText(data, t, batch), have, color: '', kind: 'tool' as const, id: t.id, need: t.count > 0 ? t.count * batch : 0, avail: charges };
      }),
    );
    if (budget && result.ok) {
      const selected = grp.find(t => t.count > 0 ? inv.toolChargesOf(t.id, budget) >= t.count * batch : inv.hasTool(t.id));
      if (selected && selected.count > 0) inv.consumeToolCharges(selected.id, selected.count * batch, budget);
    }
    return result;
  });
  const components = (req.components ?? []).map((grp) =>
    finishGroup(
      grp.map((c) => {
        const avail = inv.countOf(c.id);
        const need = Math.abs(c.count) * batch;
        return { text: componentText(data, c, batch, avail), have: avail >= need, color: '', kind: 'component' as const, id: c.id, need, avail };
      }),
    ),
  );
  const missing: string[] = [];
  for (const g of [...qualities, ...tools, ...components]) if (!g.ok) missing.push(g.alts.map((a) => a.text.replace(/\.$/, '')).join(' OR '));
  return { ok: missing.length === 0, qualities, tools, components, missing };
}

/** CDDA-markup lines ("Tools required:" / "Components required:" sections). */
export function requirementLines(ev: RequirementEval, header = 'c_white'): string[] {
  const out: string[] = [];
  const group = (g: GroupEval) => '> ' + g.alts.map((a) => `<color_${a.color.replace(/^c_/, '')}>${a.text}</color>`).join(' <color_white>OR</color> ');
  out.push(`<color_${header.replace(/^c_/, '')}>Tools required:</color>`);
  if (!ev.qualities.length && !ev.tools.length) out.push('> <color_green>NONE</color>');
  for (const g of ev.qualities) out.push(group(g));
  for (const g of ev.tools) out.push(group(g));
  if (ev.components.length) {
    out.push(`<color_${header.replace(/^c_/, '')}>Components required:</color>`);
    for (const g of ev.components) out.push(group(g));
  }
  return out;
}

/**
 * Use the first satisfiable alternative of every component group (consumed, or moved `into`
 * an in-progress craft / unfinished construction) and charges of every charged tool group.
 * Returns the component items taken. Throws if something is missing: callers check
 * evaluateRequirements first. Components of alternatives the player picked (`choice`: group
 * index → item id) are used when available.
 */
export function consumeRequirements(req: Partial<RequirementData>, inv: CraftingInventory, batch = 1, into?: import('./moves').Loc, choice?: Record<number, string>): { items: import('./item').Item[]; used: { id: string; count: number }[] } {
  const items: import('./item').Item[] = [];
  const used: { id: string; count: number }[] = [];
  (req.components ?? []).forEach((grp, gi) => {
    const enough = (c: RecipeComponent) => inv.countOf(c.id) >= Math.abs(c.count) * batch;
    const picked = choice?.[gi] !== undefined ? grp.find((c) => c.id === choice[gi] && enough(c)) : undefined;
    const alt = picked ?? grp.find(enough);
    if (!alt) throw new Error(`consumeRequirements: no component for ${grp.map((c) => c.id).join('|')}`);
    const n = Math.abs(alt.count) * batch;
    items.push(...inv.consumeComponent(alt.id, n, into));
    used.push({ id: alt.id, count: n });
  });
  for (const grp of req.tools ?? []) {
    const alt = grp.find((t) => (t.count > 0 ? inv.toolChargesOf(t.id) >= t.count * batch : inv.hasTool(t.id)));
    if (!alt) throw new Error(`consumeRequirements: no tool for ${grp.map((c) => c.id).join('|')}`);
    if (alt.count > 0) inv.consumeToolCharges(alt.id, alt.count * batch);
  }
  return { items, used };
}
