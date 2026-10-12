// "What does this take, and where do I get it?" — the reload helper.
//
// Playtest: "I thought maybe I have the batteries I need, but then I try to reload them and it
// says 'no ammo'". BN's reload_ui answers a failed reload with "You need a compatible magazine to
// reload the flashlight!" or "You don't have any batteries to reload your …" — true, but it
// doesn't say *which* battery (BN has ultra-light, light, light high-capacity, medium, heavy,
// each disposable / rechargeable / plutonium, and a flashlight takes exactly two of them), nor
// that the one you carry is merely flat, nor that it's the wrong size. A veteran knows; a new
// player walks past the right battery in the next drawer.
//
// So every failed reload (and a tool that won't switch on for lack of power) says what the item
// takes in plain words, with 1–3 concrete examples, chosen by:
//   (a) where you *saw* one recently (SeenItems: piles and drawers you've looked at), with the
//       place — "you saw 2 light batteries in a dresser 40 m northwest";
//   (b) else the most common compatible items in BN's spawn data (item group weights);
//   (c) else any compatible item.
// and tells apart the other failure modes: compatible batteries that are all flat, a battery of
// the wrong size, loose rounds for a gun that needs a magazine, a revolver still holding the
// other calibre, items that don't reload at all (UPS-powered suits, rechargeable phones).
//
// What an item takes comes from BN's own fields, as item::ammo_types / magazine_compatible /
// is_reloadable read them: `ammo`, `magazines` (the magazine well), `NO_RELOAD`, `USE_UPS`,
// `RECHARGE`. UI-free: inventory.ts builds the failure messages, the tooltips show takesLine().

import type { GameData, ItemDef, ItemGroupEntry } from '../data/types';
import type { Character } from './character';
import { asArray, hasSubtype, type Item } from './item';
import { cddaText } from './units';
import type { SeenItems, Sighting } from './seenitems';

export type ReloadKind = 'magazine' | 'ammo' | 'ups' | 'recharge' | 'none';

export interface ReloadNeeds {
  /**
   * magazine: a magazine well (flashlight → light battery, Glock → Glock magazine);
   * ammo: loose rounds into the item itself (revolver, bow, crossbow, a magazine, a bandolier);
   * ups: powered from a UPS you carry, never reloaded (power armor, exo-suits: USE_UPS);
   * recharge: NO_RELOAD + RECHARGE (smartphone): charged, not reloaded;
   * none: doesn't take ammo.
   */
  kind: ReloadKind;
  /** What goes in: magazine ids (magazine), loose ammo ids (ammo), UPS ids (ups). */
  ids: string[];
  /** ammunition_type ids */
  ammoTypes: string[];
  /** magazine: the loose ammo that fills those magazines. ammo: speedloaders / clips that load it faster. */
  extra: string[];
}

/** Where the player is and what they remember seeing; only the player has one. */
export interface ReloadHints {
  seen: SeenItems;
  here: { x: number; y: number; z: number };
  /** Is the sighting still true? undefined when the tile can't be checked (not loaded). */
  stillThere?(s: Sighting): boolean | undefined;
}

const hintSources = new WeakMap<Character, () => ReloadHints | null>();
/** The game wires the player's memory in (src/ui2/loot/seen.ts); NPCs get the plain text. */
export function setReloadHints(who: Character, fn: () => ReloadHints | null): void {
  hintSources.set(who, fn);
}
export function reloadHintsFor(who: Character): ReloadHints | null {
  return hintSources.get(who)?.() ?? null;
}

// ------------------------------------------------------------------ data tables

const ammoByType = new WeakMap<GameData, Map<string, string[]>>();
/** Loose ammo item ids of an ammunition type (BN AMMO items with that `ammo_type`). */
export function ammoItemsOf(data: GameData, type: string): string[] {
  let m = ammoByType.get(data);
  if (!m) {
    m = new Map();
    for (const [id, d] of Object.entries(data.items)) {
      if (!hasSubtype(d, 'AMMO')) continue;
      for (const t of asArray(d.ammo_type)) {
        const list = m.get(t) ?? [];
        list.push(id);
        m.set(t, list);
      }
    }
    ammoByType.set(data, m);
  }
  return m.get(type) ?? [];
}

const commonCache = new WeakMap<GameData, Map<string, number>>();
/**
 * How common an item is in BN's spawn data: the sum over every item group of the chance one
 * roll of that group makes it (distribution: prob / total; collection: prob / 100; nested lists
 * multiply), plus the group's `magazine` chance for a tool/gun's default magazine (a flashlight
 * found in a drawer brings its light disposable battery). Ignores how often mapgen uses each
 * group — it's a ranking for "the usual kind", not a spawn rate.
 */
export function commonness(data: GameData): Map<string, number> {
  const hit = commonCache.get(data);
  if (hit) return hit;
  const score = new Map<string, number>();
  const add = (id: string, w: number) => score.set(id, (score.get(id) ?? 0) + w);
  const visit = (entries: ItemGroupEntry[], distribution: boolean, w: number, magChance: number) => {
    const total = distribution ? entries.reduce((a, e) => a + (e.prob ?? 100), 0) : 100;
    if (total <= 0) return;
    for (const e of entries) {
      const ew = (w * Math.min(e.prob ?? 100, distribution ? Infinity : 100)) / total;
      if (e.item) {
        add(e.item, ew);
        const def = data.items[e.item];
        const mag = def?.magazine_default ? Object.values(def.magazine_default)[0] : undefined;
        if (mag && magChance > 0) add(mag, (ew * magChance) / 100);
      }
      for (const c of e['contents-item'] ?? []) add(c, ew);
      if (e.distribution) visit(e.distribution, true, ew, magChance);
      if (e.collection) visit(e.collection, false, ew, magChance);
    }
  };
  for (const g of Object.values(data.itemGroups)) visit(g.entries ?? [], g.subtype === 'distribution', 1, g.magazine ?? 0);
  commonCache.set(data, score);
  return score;
}

// ------------------------------------------------------------------ what it takes

const isOnState = (d: ItemDef | undefined) => !!d && typeof (d as { revert_to?: string }).revert_to === 'string';
const upsCache = new WeakMap<GameData, string[]>();
function upsIds(data: GameData): string[] {
  let ids = upsCache.get(data);
  // "_on" states are the same UPS switched on: list each kind once.
  if (!ids) upsCache.set(data, (ids = Object.keys(data.items).filter((id) => data.items[id].flags?.includes('IS_UPS') && !isOnState(data.items[id]))));
  return ids;
}

export function reloadNeeds(it: Item): ReloadNeeds {
  const data = it.data;
  const types = it.isBandolier() ? it.def.bandolier!.ammo : it.ammoTypes();
  const none: ReloadNeeds = { kind: 'none', ids: [], ammoTypes: types, extra: [] };
  if (it.hasFlag('USE_UPS') && (it.hasFlag('NO_RELOAD') || (!types.length && !it.takesMagazines()))) {
    return { kind: 'ups', ids: upsIds(data), ammoTypes: types, extra: [] };
  }
  if (it.hasFlag('NO_RELOAD')) return it.hasFlag('RECHARGE') ? { ...none, kind: 'recharge' } : none;
  if (it.takesMagazines() && !it.isMagazine()) {
    // Mod-only magazines can be missing from the loaded data: only name what exists.
    return { kind: 'magazine', ids: it.magazineCompatible().filter((id) => data.items[id]), ammoTypes: types, extra: types.flatMap((t) => ammoItemsOf(data, t)) };
  }
  if (it.isBandolier() || it.isMagazine() || it.hasIntegralMagazine()) {
    // A revolver's speedloader: its rounds are loose ammo to the cylinder (moves.ts), faster.
    const loaders = types.flatMap((t) => it.def.magazines?.[t] ?? []).filter((id) => data.items[id]?.flags?.includes('SPEEDLOADER'));
    return { kind: 'ammo', ids: types.flatMap((t) => ammoItemsOf(data, t)), ammoTypes: types, extra: [...new Set(loaders)] };
  }
  return none;
}

function defName(data: GameData, id: string, n = 1): string {
  const d = data.items[id];
  if (!d) throw new Error(`reloadhelp: unknown item ${id}`);
  return n === 1 ? cddaText(d.name) : cddaText(d.name_plural || d.name, true);
}

export function ammoTypeName(data: GameData, t: string): string {
  return cddaText(data.misc?.ammunition_type?.[t]?.name) || t;
}

/** "a", "a or b", "a, b or c" */
function orList(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

/** "a light battery", "an ultra-light battery", "a UPS", "an S&W 619" (acronyms go by letter sound). */
const aAn = (s: string) => {
  const word = s.split(/[\s-]/)[0];
  const acronym = word.length > 1 && word === word.toUpperCase() && /^[A-Z]/.test(word);
  const vowel = acronym ? /^[AEFHILMNORSX]/.test(word) : /^[aeiou]/i.test(s) && !/^(one|uni|use)/i.test(s);
  return `${vowel ? 'an' : 'a'} ${s}`;
};
export const withArticle = aAn;
/** Loose rounds read without an article ("9x19mm JHP", ".38 Special"); items with one. */
const article = (data: GameData, id: string) => (hasSubtype(data.items[id], 'AMMO') ? defName(data, id) : aAn(defName(data, id)));

/** Most common first; ties keep the data's order. */
function byCommon(data: GameData, ids: string[]): string[] {
  const c = commonness(data);
  return [...new Set(ids)].map((id, i) => ({ id, i, s: c.get(id) ?? 0 })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.id);
}

/** The short name list for a set of ids: all of them up to 3, else the 2 commonest + "N other …". */
function listNames(data: GameData, ids: string[], noun: string): string {
  const sorted = byCommon(data, ids);
  if (sorted.length <= 3) return orList(sorted.map((id) => aAn(defName(data, id))));
  return `${sorted.slice(0, 2).map((id) => aAn(defName(data, id))).join(', ')} or ${sorted.length - 2} other ${noun}`;
}

/**
 * `ids` restricted to what `def`'s own JSON names, dropping ids BN's `magazines_like` expansion
 * added for compatibility only (tools/extract/index.ts finalize_post, `def.magazines_added`): the
 * "Takes:" line should still read "a light battery or an ultra-light battery" for the soldering
 * iron, not "… or 5 other magazines" now that every disposable/rechargeable/plutonium size variant
 * is also an accepted magazine. The full set (with the exact variant you're holding) still shows in
 * "you saw" / "the usual kind". Falls back to the full set if that would leave nothing (shouldn't
 * happen: every added id came from one of the originals).
 */
function declaredMagazines(def: ItemDef, ids: string[]): string[] {
  const added = new Set(Object.values(def.magazines_added ?? {}).flat());
  const kept = ids.filter((id) => !added.has(id));
  return kept.length ? kept : ids;
}

/** The item's name for prose: "flashlight", not "flashlight (off)" (BN puts the state in the name). */
export function plainName(it: Item): string {
  return it.baseName().replace(/ \((off|on|active|covered)\)$/, '');
}

/**
 * What it takes, as a phrase after "takes": "a light battery or a light disposable battery",
 * "a Glock magazine, … (9x19mm)", ".357 Magnum or .38 Special", "arrows". Null when it takes nothing.
 */
export function takesPhrase(it: Item): string | null {
  const n = reloadNeeds(it);
  const data = it.data;
  const tn = n.ammoTypes.map((t) => ammoTypeName(data, t));
  switch (n.kind) {
    case 'magazine': {
      const battery = n.ammoTypes.includes('battery');
      return `${listNames(data, declaredMagazines(it.def, n.ids), 'magazines')}${battery ? '' : ` (${orList(tn)})`}`;
    }
    case 'ammo': {
      const phrase = orList(tn);
      return n.extra.length ? `${phrase} (${aAn(defName(data, n.extra[0]))} loads it faster)` : phrase;
    }
    case 'ups':
      return 'power from a UPS you carry';
    case 'recharge':
      return 'a recharge, not a reload';
    default:
      return null;
  }
}

/** The tooltip / look card line: "Takes: a light battery or a light disposable battery." */
export function takesLine(it: Item): string | null {
  const n = reloadNeeds(it);
  const p = takesPhrase(it);
  if (!p) return null;
  if (n.kind === 'ups') return `Runs on a UPS you carry (it can't be reloaded). ${upsBatteryNote(it.data)}`;
  if (n.kind === 'recharge') return "Recharged, not reloaded (an enabled vehicle battery charger or recharging station).";
  // A battery's own "ammo" is loose battery charge nobody carries: say how it gets charge instead.
  if (it.isMagazine() && n.ammoTypes.includes('battery')) {
    return it.hasFlag('RECHARGE') ? "Rechargeable: it needs an enabled vehicle battery charger or recharging station." : null;
  }
  return `Takes: ${p}.`;
}

function upsBatteryNote(data: GameData): string {
  const ups = data.items.UPS_off;
  const mags = ups?.magazines?.battery;
  if (!mags?.length) return '';
  return `A UPS takes ${orList(byCommon(data, declaredMagazines(ups, mags)).map((id) => aAn(defName(data, id))))}.`;
}

// ------------------------------------------------------------------ examples

export interface Example {
  id: string;
  via: 'seen' | 'common' | 'any';
  sighting?: Sighting;
}

/** 1–n examples of `ids`: recently seen first (newest, then nearest), then most common, then any. */
export function pickExamples(data: GameData, ids: string[], hints: ReloadHints | null, n = 3): Example[] {
  const out: Example[] = [];
  const have = new Set<string>();
  if (hints) {
    const seen: Sighting[] = [];
    for (const id of new Set(ids)) for (const s of hints.seen.sightings(id)) if (hints.stillThere?.(s) !== false) seen.push(s);
    const d = (s: Sighting) => Math.hypot(s.x - hints.here.x, s.y - hints.here.y) + Math.abs(s.z - hints.here.z) * 20;
    // Newest first, but within the same few minutes the nearest one is the useful answer.
    seen.sort((a, b) => Math.floor(b.t / 600) - Math.floor(a.t / 600) || d(a) - d(b));
    for (const s of seen) {
      if (out.length >= n) break;
      if (have.has(s.id)) continue;
      have.add(s.id);
      out.push({ id: s.id, via: 'seen', sighting: s });
    }
  }
  const c = commonness(data);
  for (const id of byCommon(data, ids)) {
    if (out.length >= n) break;
    if (have.has(id)) continue;
    have.add(id);
    out.push({ id, via: (c.get(id) ?? 0) > 0 ? 'common' : 'any' });
  }
  return out;
}

/** "in a dresser 40 m northwest", "on the floor 3 m east, one floor up", "right here" */
export function placePhrase(s: Sighting, here: { x: number; y: number; z: number }): string {
  const dx = s.x - here.x, dy = s.y - here.y;
  const d = Math.round(Math.hypot(dx, dy));
  const floors = s.z - here.z;
  const level = floors === 0 ? '' : `, ${Math.abs(floors) === 1 ? 'one floor' : `${Math.abs(floors)} floors`} ${floors > 0 ? 'up' : 'down'}`;
  if (d < 2 && !floors) return `${s.where} right here`;
  if (d < 2) return `${s.where}${level}`;
  return `${s.where} ${d} m ${compass(dx, dy)}${level}`;
}

function compass(dx: number, dy: number): string {
  const a = Math.atan2(dx, -dy); // 0 = north (−y), clockwise
  const names = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

/** The sentence with the examples: where you saw them, else the common kinds. */
export function examplesSentence(data: GameData, ex: Example[], hints: ReloadHints | null): string {
  const seen = ex.filter((e) => e.via === 'seen' && e.sighting);
  if (seen.length && hints) {
    const parts = seen.slice(0, 2).map((e) => {
      const s = e.sighting!;
      // Loose ammo counts rounds ("30 9x19mm JHPs"), everything else items ("2 light batteries").
      const what = s.n === 1 ? article(data, s.id) : `${s.n} ${defName(data, s.id, s.n)}`;
      return `${what} ${placePhrase(s, hints.here)}`;
    });
    return `You saw ${parts.join(', and ')}.`;
  }
  const rest = ex.filter((e) => e.via !== 'seen').map((e) => article(data, e.id));
  if (!rest.length) return '';
  if (ex[0]?.via === 'common') return rest.length === 1 ? `The usual kind is ${rest[0]}.` : `The usual kinds: ${orList(rest)}.`;
  return `Look for ${orList(rest)}.`;
}

/**
 * The tooltip's second line: where you last saw something it takes ("You saw 2 light batteries
 * in a dresser 40 m northwest."), or null when you haven't (the Takes line already says what).
 */
export function seenLine(it: Item, hints: ReloadHints | null): string | null {
  if (!hints) return null;
  const need = reloadNeeds(it);
  if (need.kind !== 'magazine' && need.kind !== 'ammo' && need.kind !== 'ups') return null;
  const ex = pickExamples(it.data, need.ids, hints, 2).filter((e) => e.via === 'seen');
  return ex.length ? examplesSentence(it.data, ex, hints) : null;
}

// ------------------------------------------------------------------ failure messages

const battery = (it: Item) => reloadNeeds(it).ammoTypes.includes('battery');

/** The disposable battery of the same size (light battery → light disposable battery). */
function sameSizeDisposables(bat: Item): string[] {
  const id = bat.typeId.replace(/_(plus_|atomic_)?battery_cell$/, '_disposable_cell');
  return id !== bat.typeId && bat.data.items[id] ? [id] : [];
}

/** "Disposable ones come charged: you saw one in …" / "…, like the light disposable battery." */
function chargedTip(data: GameData, ids: string[], hints: ReloadHints | null): string {
  const seen = pickExamples(data, ids, hints, 2).filter((e) => e.via === 'seen');
  if (seen.length) return `Disposable ones come charged: ${examplesSentence(data, seen, hints).replace(/^You/, 'you')}`;
  return `Disposable ones come charged, like ${orList(byCommon(data, ids).slice(0, 2).map((id) => `the ${defName(data, id)}`))}.`;
}

/**
 * Why `target` couldn't be reloaded from what you carry (`carried`: everything on you, nested),
 * in words, with examples. Call it only when a reload found nothing to load (the "already full"
 * case has its own message).
 */
export function explainNoReload(target: Item, carried: readonly Item[], hints: ReloadHints | null): string {
  const data = target.data;
  const need = reloadNeeds(target);
  const name = plainName(target);
  const takes = takesPhrase(target);
  // What `takes` named (declaredMagazines): BN's magazines_like expansion can make `need.ids`
  // much longer than what the item's own JSON lists (every battery size variant vs. the one or
  // two the tool actually calls out), so examples keyed off the full set still need their own ids.
  const declared = declaredMagazines(target.def, need.ids);
  const ex = (ids: string[], alreadyNamed = false) => {
    const picked = pickExamples(data, ids, hints);
    // The takes phrase already names every magazine when there are ≤ 3: repeating them as "the
    // usual kinds" says nothing, so only the commonest is pointed out (unless you saw one).
    if (need.kind === 'magazine' && alreadyNamed && ids.length <= 3 && !picked.some((e) => e.via === 'seen')) {
      return ids.length > 1 && picked[0]?.via === 'common' ? `The ${defName(data, picked[0].id)} is the most common.` : '';
    }
    return examplesSentence(data, picked, hints);
  };
  const join = (...xs: string[]) => xs.filter(Boolean).join(' ');

  switch (need.kind) {
    case 'none':
      return `You can't reload the ${name}.`;
    case 'recharge':
      return `Your ${name} can't be reloaded: put it in cargo with an enabled vehicle battery charger or recharging station.`;
    case 'ups': {
      const ups = carried.filter((c) => c.hasFlag('IS_UPS'));
      if (ups.length) {
        const flat = ups.every((u) => u.ammoRemaining() <= 0);
        if (flat) return join(`Your ${name} runs on your UPS, and the UPS is flat.`, upsBatteryNote(data), ex(data.items.UPS_off?.magazines?.battery ?? []));
        // A charged UPS is on you: it powers (and tops up) the item, there's nothing to reload.
        return `Your ${name} can't be reloaded: it runs on the UPS you carry.`;
      }
      return join(`Your ${name} can't be reloaded: it runs on a UPS you carry. You don't have one.`, ex(need.ids), upsBatteryNote(data));
    }
    case 'magazine': {
      const compat = carried.filter((c) => c !== target && c.isMagazine() && target.acceptsMagazine(c));
      const fill = carried.filter((c) => c.isAmmo() && c.charges > 0 && need.ammoTypes.includes(asArray(c.def.ammo_type)[0] ?? ''));
      if (compat.length && compat.every((m) => m.ammoRemaining() <= 0) && !fill.length) {
        const bat = battery(target);
        const kinds = new Set(compat.map((m) => m.typeId));
        const nm = kinds.size === 1 ? defName(data, compat[0].typeId, compat.length) : bat ? 'batteries' : 'magazines';
        const state = bat ? 'flat' : 'empty';
        const head = compat.length === 1 ? `Your ${nm} is ${state}.` : `Your ${nm} are all ${state}.`;
        if (bat) {
          // Rechargeables spawn flat; disposables come full.
          const disposable = need.ids.filter((id) => (data.items[id]?.magazine?.count ?? 0) > 0);
          const charge = compat.some((m) => m.hasFlag('RECHARGE')) ? "Put rechargeable ones in cargo with an enabled vehicle battery charger or recharging station." : '';
          const tip = disposable.length ? chargedTip(data, disposable, hints) : ex(need.ids);
          return join(head, charge, tip);
        }
        return join(head, `You have no ${orList(need.ammoTypes.map((t) => ammoTypeName(data, t)))} to fill ${compat.length === 1 ? 'it' : 'them'}.`, ex(need.extra));
      }
      const wrong = carried.filter((c) => c !== target && c.isMagazine() && !target.acceptsMagazine(c) && !c.hasFlag('SPEEDLOADER') && c.ammoTypes().some((t) => need.ammoTypes.includes(t)));
      if (!compat.length && wrong.length) {
        const w = wrong[0];
        return join(`Your ${w.baseName()} doesn't fit: the ${name} takes ${takes}.`, ex(declared, true));
      }
      if (!compat.length && fill.length) {
        return join(`You have ${fill[0].baseName(2)}, but the ${name} loads from a magazine: it takes ${takes}.`, ex(declared, true));
      }
      return join(`Your ${name} takes ${takes}. You have none.`, ex(declared, true));
    }
    case 'ammo': {
      if (target.isMagazine() && need.ammoTypes.includes('battery')) {
        // A battery is filled by charging, not by loose "battery" charges a player never sees.
        const disposable = sameSizeDisposables(target);
        return join(`Your ${name} is flat. Put rechargeable batteries in cargo with an enabled vehicle battery charger or recharging station.`,
          disposable.length ? chargedTip(data, disposable, hints) : '');
      }
      const loaded = target.ammoData();
      const usable = carried.filter((c) => c.isAmmo() && c.charges > 0 && need.ammoTypes.includes(asArray(c.def.ammo_type)[0] ?? ''));
      if (loaded && target.ammoRemaining() > 0 && usable.length && usable.every((u) => u.typeId !== loaded.id)) {
        return `The ${name} still has ${defName(data, loaded.id, 2)} in it: unload it first to load ${usable[0].baseName(2)}.`;
      }
      return join(`Your ${name} takes ${takes}. You have none.`, ex(need.ids));
    }
  }
}

/**
 * A tool that won't switch on for lack of power (the flashlight's "batteries are dead"): what to
 * do about it — reload with what you carry, or what it takes and where you saw some.
 */
export function explainNoPower(it: Item, carried: readonly Item[], hints: ReloadHints | null): string {
  const need = reloadNeeds(it);
  if (need.kind === 'none') return '';
  if (need.kind === 'magazine') {
    const ready = carried.filter((c) => c !== it.magazine && c.isMagazine() && it.acceptsMagazine(c) && c.ammoRemaining() > 0);
    if (ready.length) return `You have ${aAn(ready[0].baseName())} with charge: reload the ${plainName(it)} with it.`;
  }
  if (need.kind === 'ammo') {
    const ready = carried.filter((c) => c.isAmmo() && c.charges > 0 && it.acceptsAmmo(c));
    if (ready.length) return `You have ${ready[0].baseName(2)}: reload the ${plainName(it)} with them.`;
  }
  return explainNoReload(it, carried, hints);
}
