// Requirement lists (components / tools / qualities) as used by recipes, constructions,
// uncraft and `requirement` objects. Mirrors requirements.cpp:
//  - load_obj_list: an array entry is a list of alternatives; a bare entry is a
//    one-alternative group (qualities are usually written that way)
//  - "using": [[req_id, multiplier]] appends the requirement's groups scaled by the multiplier
//  - [req_id, n, "LIST"] inside a group is inlined as the alternatives of the requirement's
//    first group, scaled by n (requirement_data::finalize / inline_requirements)

import type { QualityRequirement, RecipeComponent, RequirementData } from '../../src/data/types';

type Json = Record<string, any>;

export interface RawRequirement {
  components: RecipeComponent[][];
  tools: RecipeComponent[][];
  qualities: QualityRequirement[][];
}

function parseComp(v: unknown, isTool: boolean, ctx: string): RecipeComponent {
  if (typeof v === 'string') {
    // constructions write presence-only tools as bare ids (tool_comp::load)
    if (!isTool) throw new Error(`${ctx}: component must be [id, count]: ${JSON.stringify(v)}`);
    return { id: v, count: -1 };
  }
  if (!Array.isArray(v) || typeof v[0] !== 'string' || typeof v[1] !== 'number') {
    throw new Error(`${ctx}: bad requirement entry ${JSON.stringify(v)}`);
  }
  const c: RecipeComponent = { id: v[0], count: v[1] };
  for (const flag of v.slice(2)) {
    if (flag === 'LIST') c.list = true;
    else if (flag === 'NO_RECOVER' && !isTool) c.no_recover = true;
    else throw new Error(`${ctx}: unknown requirement flag ${JSON.stringify(flag)}`);
  }
  return c;
}

function parseQuality(v: unknown, ctx: string): QualityRequirement {
  if (!v || typeof v !== 'object' || Array.isArray(v) || typeof (v as Json).id !== 'string') {
    throw new Error(`${ctx}: bad quality requirement ${JSON.stringify(v)}`);
  }
  const q = v as Json;
  const r: QualityRequirement = { id: q.id, level: q.level ?? 1 };
  if (q.amount !== undefined && q.amount !== 1) r.amount = q.amount;
  return r;
}

function parseGroups<T>(arr: unknown, parse: (v: unknown) => T, ctx: string): T[][] {
  if (arr === undefined) return [];
  if (!Array.isArray(arr)) throw new Error(`${ctx}: requirement list must be an array: ${JSON.stringify(arr)}`);
  const out: T[][] = [];
  for (const entry of arr) {
    // an array of *alternatives* vs. a single bare [id, count] tool entry: tool/component
    // alternatives are arrays whose elements are themselves arrays or strings
    if (Array.isArray(entry) && !(typeof entry[0] === 'string' && typeof entry[1] === 'number')) {
      const alts = entry.map(parse);
      if (alts.length) out.push(alts);
    } else {
      out.push([parse(entry)]);
    }
  }
  return out;
}

export function parseRequirementLists(obj: Json, ctx: string): RawRequirement {
  return {
    components: parseGroups(obj.components, (v) => parseComp(v, false, ctx), ctx),
    tools: parseGroups(obj.tools, (v) => parseComp(v, true, ctx), ctx),
    qualities: parseGroups(obj.qualities, (v) => parseQuality(v, ctx), ctx),
  };
}

/** "using": "req" | [["req", n], ...] | ["req", n] -> pairs */
export function parseUsing(v: unknown, ctx: string): [string, number][] {
  if (v === undefined) return [];
  if (typeof v === 'string') return [[v, 1]];
  if (Array.isArray(v)) {
    if (typeof v[0] === 'string' && (v.length === 1 || typeof v[1] === 'number')) return [[v[0], v[1] ?? 1]];
    return v.map((x) => {
      if (typeof x === 'string') return [x, 1] as [string, number];
      if (Array.isArray(x) && typeof x[0] === 'string') return [x[0], x[1] ?? 1] as [string, number];
      throw new Error(`${ctx}: bad "using" entry ${JSON.stringify(x)}`);
    });
  }
  throw new Error(`${ctx}: bad "using" ${JSON.stringify(v)}`);
}

// requirement_data::operator*: counts scale, clamped at -1 so presence tools stay presence tools
function scaleComps(groups: RecipeComponent[][], n: number): RecipeComponent[][] {
  return groups.map((g) => g.map((c) => ({ ...c, count: Math.max(c.count * n, -1) })));
}

/**
 * Drop groups identical to an earlier one. Only for tools/qualities: needing a hammer twice
 * is needing a hammer (requirement_data::consolidate); duplicate component groups really
 * do consume twice.
 */
export function dedupeGroups<T>(groups: T[][]): T[][] {
  const seen = new Set<string>();
  return groups.filter((g) => {
    const k = JSON.stringify(g);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export class RequirementResolver {
  constructor(private readonly defs: Map<string, RawRequirement>, private readonly warn: (msg: string) => void) {}

  get(id: string): RawRequirement | undefined {
    return this.defs.get(id);
  }

  private inline(groups: RecipeComponent[][], kind: 'tools' | 'components', ctx: string): RecipeComponent[][] {
    return groups.map((group) => {
      const acc: RecipeComponent[] = [];
      const add = (c: RecipeComponent) => {
        const existing = acc.find((a) => a.id === c.id);
        // alternatives: the same item twice means the cheaper option wins
        if (existing) existing.count = Math.min(existing.count, c.count);
        else acc.push({ ...c });
      };
      const rec = (c: RecipeComponent, stack: string[]) => {
        if (!c.list) return add(c);
        if (stack.includes(c.id)) {
          this.warn(`${ctx}: requirement cycle ${[...stack, c.id].join(' -> ')}`);
          return;
        }
        const req = this.defs.get(c.id);
        if (!req) {
          this.warn(`${ctx}: unknown requirement list "${c.id}"`);
          return;
        }
        const first = scaleComps(req[kind], c.count)[0];
        if (first) for (const n of first) rec(n, [...stack, c.id]);
      };
      for (const c of group) rec(c, []);
      return acc;
    }).filter((g) => g.length > 0);
  }

  /** Inline lists + `using` into flat requirement data. */
  expand(own: RawRequirement, using: [string, number][], ctx: string): RequirementData {
    let components = [...own.components];
    let tools = [...own.tools];
    let qualities = [...own.qualities];
    for (const [id, mult] of using) {
      const req = this.defs.get(id);
      if (!req) {
        this.warn(`${ctx}: unknown requirement "${id}" in using`);
        continue;
      }
      components = components.concat(scaleComps(req.components, mult));
      tools = tools.concat(scaleComps(req.tools, mult));
      qualities = qualities.concat(req.qualities);
    }
    return {
      components: this.inline(components, 'components', ctx),
      tools: dedupeGroups(this.inline(tools, 'tools', ctx)),
      qualities: dedupeGroups(qualities),
    };
  }
}
