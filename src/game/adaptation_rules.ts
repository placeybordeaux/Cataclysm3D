// Rule changes made for newcomers (docs/ADAPTATION.md, "Adaptations built"). Each is a switch
// (Options, via src/ui/adaptation.ts) that defaults to the adapted rule; turning it off gives
// back Bright Nights' rule exactly. Kept in one place so game code asks one question
// ("what does this construction need right now?") and tests can flip the switches.

/** The switches. src/ui/adaptation.ts loads them from localStorage and registers Options. */
export const adaptationRules = {
  /** Crude beds (straw, makeshift) buildable at Fabrication 0, taking longer. */
  easyBeds: true,
  /** Warn (and ask for a second try) before lighting a fire outside a fire container. */
  fireWarning: true,
};

/**
 * Constructions whose skill gate is relaxed under `easyBeds`: the first bed a survivor would
 * build. BN asks Fabrication 1–2 for them; a new survivor has 0 and no obvious way to train it
 * before the first night (playtest). Proper beds (frame, bunk, from scratch) keep their gate.
 */
export const EASY_BEDS = new Set(['constr_straw_bed', 'constr_makeshift_bed']);
/** Working without the skill is slower: this factor on the construction time. */
export const EASY_BED_TIME = 1.5;

interface ConLike {
  id: string;
  time: number;
  required_skills?: [string, number][];
}

/** The skill gates that apply to `con` now. */
export function effectiveSkills(con: ConLike): [string, number][] {
  const req = con.required_skills ?? [];
  if (adaptationRules.easyBeds && EASY_BEDS.has(con.id)) return req.map(([s]) => [s, 0]);
  return req;
}

/** Game seconds `con` takes now (before speed modifiers). */
export function effectiveTime(con: ConLike): number {
  return adaptationRules.easyBeds && EASY_BEDS.has(con.id) ? con.time * EASY_BED_TIME : con.time;
}
