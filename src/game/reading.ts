import type { Character } from './character';
import type { Item } from './item';
import { bookRecipeIndex, fineVisionMod, FINE_VISION_THRESHOLD, learnRecipe, recipeName, type CraftHost } from './crafting';
import { cddaText } from './units';

// Reading after Bright Nights (avatar.cpp read / do_read / time_to_read, skill.cpp readBook):
// the first time you open a book you learn what's in it at once (skim); each session
// ("chapter") then gives the book's fun as morale, memorises every recipe in it your skill can
// follow, and trains its skill up to max_level. "Read until you gain a level" keeps going
// session after session; "read once" stops after one. "Read until done" (ours, not BN: the same
// as choosing "until you gain a level" again after each level) keeps going until the book has
// nothing left to teach you. Martial-arts manuals train through readHooks (src/game/martialarts.ts).

export interface BookData {
  skill?: string;
  /** Skill needed to understand it (BN "required_level"). */
  req: number;
  /** Max level it can train to (BN "max_level"). */
  level: number;
  /** Seconds per session (BN minutes × 60). */
  time: number;
  intel: number;
  fun: number;
  chapters: number;
}

export function bookData(it: Item): BookData | null {
  if (!it.isBook()) return null;
  const d = it.def;
  return {
    skill: (d.skill as string | undefined) || undefined,
    req: d.required_level ?? 0,
    level: d.max_level ?? 0,
    time: d.time ?? 60,
    intel: d.intelligence ?? 0,
    fun: Number(d.fun ?? 0),
    chapters: d.chapters ?? 0,
  };
}

/** Character::read_speed: moves per minute of book time (6000 at Int 8, −300 per point above). */
export function readSpeed(c: Character): number {
  let ret = 6000 - 300 * (c.int - 8);
  ret *= c.mutationValue('reading_speed_multiplier');
  ret = c.byEnchant(ret, 'READING_SPEED');
  return Math.max(100, ret);
}

/** avatar::time_to_read in seconds: book minutes × read speed × vision, + the complexity penalty. */
export function timeToRead(c: Character, it: Item, visionMod = 1): number {
  const b = bookData(it);
  if (!b) return 0;
  const minutes = b.time / 60;
  let moves = minutes * readSpeed(c) * Math.max(1, visionMod);
  if (b.intel > c.int) moves += minutes * (b.intel - c.int) * 100;
  return Math.max(1, Math.round(moves / 100));
}

export type Mastery = 'cant_understand' | 'learning' | 'mastered' | 'no_skill';

export function bookMastery(c: Character, it: Item): Mastery {
  const b = bookData(it)!;
  if (!b.skill) return 'no_skill';
  const lvl = c.getSkill(b.skill);
  if (lvl < b.req) return 'cant_understand';
  if (lvl >= b.level) return 'mastered';
  return 'learning';
}

/** character_funcs::is_fun_to_read (fun, ignoring traits that change it). */
function funToRead(it: Item): boolean {
  return (bookData(it)?.fun ?? 0) > 0;
}

/** avatar::get_book_reader: why `c` can't read `it` right now (BN wording), or null. */
export function cantRead(host: CraftHost, it: Item): string | null {
  const c = host.player;
  const b = bookData(it);
  if (!b) return `Your ${it.name()} is not good reading material.`;
  if (!funToRead(it) && c.morale.level() < -40) return "What's the point of studying?  (Your morale is too low!)";
  if (b.skill && c.getSkill(b.skill) < b.req) return `${c.skillName(b.skill)} ${b.req} needed to understand.  You have ${c.getSkill(b.skill)}`;
  if (b.intel > 0 && c.hasTrait('ILLITERATE')) return "You're illiterate!";
  if (fineVisionMod(host) > FINE_VISION_THRESHOLD && !it.hasFlag('CAN_USE_IN_DARK')) return "It's too dark to read!";
  return null;
}

/** Recipes the book would teach `c` now that aren't known yet. */
export function teachableRecipes(c: Character, it: Item) {
  return (bookRecipeIndex(c.data).get(it.typeId) ?? []).filter(
    (br) => !c.learnedRecipes.has(br.recipe.id) && !br.recipe.never_learn && (!br.recipe.skill_used || c.getSkill(br.recipe.skill_used) >= br.level),
  );
}

/** Nothing left to gain: skill maxed (or none), no recipes to learn, no fun. */
export function nothingToLearn(c: Character, it: Item): boolean {
  const b = bookData(it)!;
  const trains = !!b.skill && c.getSkill(b.skill) < b.level && c.getSkill(b.skill) < 10;
  return !trains && teachableRecipes(c, it).length === 0;
}

/** skim_book_msg: what the first look at a book tells you. */
export function identifyLines(c: Character, it: Item): string[] {
  const b = bookData(it)!;
  const out = [`You skim ${cddaText(it.def.name)} to find out what's in it.`];
  if (b.skill && c.getSkill(b.skill) < 10) {
    out.push(`Can bring your ${c.skillName(b.skill)} skill to ${b.level}.`);
    if (b.req) out.push(`Requires ${c.skillName(b.skill)} level ${b.req} to understand.`);
  }
  if (b.intel) out.push(`Requires intelligence of ${b.intel} to easily read.`);
  if (b.fun) out.push(`Reading this book affects your morale by ${b.fun}`);
  const min = Math.round(b.time / 60);
  out.push(`A chapter of this book takes ${min} minute${min === 1 ? '' : 's'} to read.`);
  const rec = bookRecipeIndex(c.data).get(it.typeId) ?? [];
  if (rec.length) out.push(`This book contains ${rec.length} crafting recipe${rec.length === 1 ? '' : 's'}: ${rec.slice(0, 6).map((r) => recipeName(c.data, r.recipe)).join(', ')}${rec.length > 6 ? ', …' : ''}`);
  return out;
}

/** Character::adjust_for_focus. */
function adjustForFocus(c: Character, amount: number): number {
  return c.rollRemainder((amount * effectiveFocus(c)) / 100);
}

function effectiveFocus(c: Character): number {
  let focus = c.focus + c.enchantBonus('EFFECTIVE_FOCUS', c.focus);
  if (c.hasTrait('FASTLEARNER')) focus += 15;
  if (c.hasTrait('SLOWLEARNER')) focus -= 15;
  focus += (c.int - 8) * 5;
  return focus;
}

/**
 * trainFromBook's min/max experience for one session at skill `lvl`, before the random roll.
 * `adjust` is adjustForFocus (rolling) or its expectation (the estimate below).
 */
function sessionExRange(c: Character, b: BookData, lvl: number, adjust: (amount: number) => number): [number, number] {
  const minutes = b.time / 60;
  let minEx = adjust(Math.max(1, Math.floor(minutes / 10 + c.int / 4)));
  let maxEx = adjust(Math.floor(minutes / 5 + c.int / 2 - lvl));
  maxEx = Math.max(minEx, Math.min(10, Math.max(2, maxEx)));
  minEx = Math.max(1, minEx * (lvl + 1));
  maxEx = Math.max(minEx, maxEx * (lvl + 1));
  return [minEx, maxEx];
}

/**
 * About how many more chapters until the next level (and until the book's max level), at the
 * reader's focus right now: the reading card's "~3 chapters to level 2". An estimate: focus
 * drifts while you read and each chapter's experience is a roll. null when the book doesn't
 * train you any further.
 */
export function chaptersToLevel(c: Character, it: Item): { next: number; done: number; nextLevel: number; maxLevel: number } | null {
  const b = bookData(it);
  if (!b?.skill) return null;
  const lvl0 = c.getSkill(b.skill);
  const top = Math.min(b.level, 10);
  if (lvl0 >= top) return null;
  const expect = (amount: number) => (amount * effectiveFocus(c)) / 100;
  let exercise = c.skills[b.skill]?.exercise ?? 0;
  let next = 0, done = 0;
  for (let lvl = lvl0; lvl < top; lvl++) {
    const [lo, hi] = sessionExRange(c, b, lvl, expect);
    // train(): (lvl+1) × roll(min..max), stored ×100
    const perSession = Math.max(1, (lvl + 1) * ((lo + hi) / 2) * 100);
    const need = 10000 * (lvl + 1) ** 2 - exercise;
    const n = Math.max(1, Math.ceil(need / perSession));
    if (lvl === lvl0) next = n;
    done += n;
    exercise = 0;
  }
  return { next, done, nextLevel: lvl0 + 1, maxLevel: top };
}

/** BN SkillLevel::train (exercise stored ×100: a level takes 10000 × (level+1)²). */
function train(c: Character, skill: string, amount: number): boolean {
  const sk = (c.skills[skill] ??= { level: 0, exercise: 0 });
  sk.exercise += amount * 100;
  if (sk.exercise >= 10000 * (sk.level + 1) ** 2) {
    sk.exercise = 0;
    sk.level++;
    return true;
  }
  return false;
}

/**
 * The read quiz's practice bonus (src/game/readquiz/): `amount` exercise points (BN units,
 * ×100 inside) in the book's skill. Within the book's caps — nothing once the skill reaches
 * the book's max level (or 10) — and never a level-up by itself: it stops just short, so the
 * level still comes at the end of a chapter as BN's readBook does it. Returns points added.
 */
export function readingPractice(c: Character, it: Item, amount: number): number {
  const b = bookData(it);
  if (!b?.skill || !(amount > 0)) return 0;
  const lvl = c.getSkill(b.skill);
  if (lvl >= b.level || lvl >= 10) return 0;
  const sk = (c.skills[b.skill] ??= { level: 0, exercise: 0 });
  const room = Math.max(0, 10000 * (sk.level + 1) ** 2 - 1 - sk.exercise);
  const add = Math.min(amount * 100, room);
  sk.exercise += add;
  return add / 100;
}

/**
 * The read quiz's "progress jump": skip `gameSeconds` of the chapter being read now. Game
 * time, not the clock, so it's the same jump at any fast-forward speed. Never past the end:
 * the chapter still finishes through ActivityManager.update (rewards, the next chapter,
 * interrupts) on the next tick. Returns the seconds actually skipped (0 when not reading).
 */
export function skipReading(host: Pick<CraftHost, 'activities'>, gameSeconds: number): number {
  const a = host.activities.current;
  if (!a || a.spec.kind !== 'read' || !(gameSeconds > 0)) return 0;
  const skip = Math.min(gameSeconds, Math.max(0, a.spec.duration - a.elapsed));
  a.elapsed += skip;
  return skip;
}

/** Exercise towards the next level of `skill`, 0..1 (the reading UI's bar). */
export function skillProgress(c: Character, skill: string): number {
  const sk = c.skills[skill];
  if (!sk) return 0;
  return Math.min(1, sk.exercise / (10000 * (sk.level + 1) ** 2));
}

/**
 * do_read's skill part: min/max experience from the session's minutes and Int, focus-adjusted,
 * then SkillLevel::readBook. Returns true on level up.
 */
export function trainFromBook(c: Character, it: Item, host?: CraftHost): boolean {
  const b = bookData(it)!;
  if (!b.skill) return false;
  const lvl = c.getSkill(b.skill);
  if (lvl >= b.level || lvl >= 10) return false;
  const [minEx, maxEx] = sessionExRange(c, b, lvl, (a) => adjustForFocus(c, a));
  const leveled = train(c, b.skill, (lvl + 1) * c.rng.int(minEx, maxEx));
  const say = (t: string, col?: string) => (host ? host.message(t, col) : c.msg(t, col));
  if (leveled) say(`You increase ${c.skillName(b.skill)} to level ${lvl + 1}.`, 'c_light_green');
  else say(`You learn a little about ${c.skillName(b.skill)}!  (${Math.floor(skillProgress(c, b.skill) * 100)}%)`, 'c_cyan');
  return leveled;
}

/** Memorise every recipe from the book the reader now has the skill for. */
export function learnBookRecipes(c: Character, it: Item, host?: CraftHost): string[] {
  const learned: string[] = [];
  for (const br of teachableRecipes(c, it)) {
    if (!learnRecipe(c, br.recipe.id)) continue;
    const name = recipeName(c.data, br.recipe);
    learned.push(name);
    (host ? host.message.bind(host) : c.msg.bind(c))(`You memorize a recipe for ${name}.`, 'c_light_green');
  }
  return learned;
}

/** Called after each full read session of a book (martial-arts manuals teach their style). */
export const readHooks: ((c: Character, it: Item, host: CraftHost) => void)[] = [];

export type ReadMode = 'until_level' | 'until_done' | 'once';

/** do_read: one session. Returns whether to keep reading (until-level mode, no level yet). */
function finishSession(host: CraftHost, it: Item, mode: ReadMode): boolean {
  const c = host.player;
  const b = bookData(it)!;
  if (b.fun !== 0) c.morale.add('morale_book', b.fun * 5, b.fun * 15, 3600, 1800, true, it.typeId);
  for (const h of readHooks) h(c, it, host);
  learnBookRecipes(c, it, host);
  let keepGoing = false;
  if (b.skill && c.getSkill(b.skill) < b.level && c.getSkill(b.skill) < 10) {
    const leveled = trainFromBook(c, it, host);
    if (!leveled && mode === 'until_level') keepGoing = true;
    if (mode === 'until_done' && c.getSkill(b.skill) < b.level && c.getSkill(b.skill) < 10) keepGoing = true;
    if (c.getSkill(b.skill) >= b.level && !teachableRecipes(c, it).length) host.message(`You can no longer learn from ${cddaText(it.def.name)}.`);
  } else if (b.skill && !teachableRecipes(c, it).length) host.message(`You can no longer learn from ${cddaText(it.def.name)}.`);
  return keepGoing;
}

/** Live state of a reading session, for the reading UI. */
export interface ReadingState {
  book: Item;
  mode: ReadMode;
  sessions: number;
}
export const reading: { current: ReadingState | null } = { current: null };
/** Listeners: a session ended (UI refresh). */
export const readSessionHooks: ((st: ReadingState) => void)[] = [];

/**
 * avatar::read: identify on first look (skim messages), check the reader, then read a session
 * (repeating in 'until_level' mode). Returns false with a message if it can't be read.
 */
export function startReading(host: CraftHost, it: Item, mode: ReadMode = 'until_level'): boolean {
  const c = host.player;
  if (it.isBook() && !c.identifiedBooks.has(it.typeId)) {
    c.identifiedBooks.add(it.typeId);
    for (const l of identifyLines(c, it)) host.message(l, 'c_light_gray');
  }
  const why = cantRead(host, it);
  if (why) {
    host.message(why, 'c_light_red');
    return false;
  }
  const b = bookData(it)!;
  if (b.intel > c.int) host.message('This book is too complex for you to easily understand.  It will take longer to read.', 'c_yellow');
  const title = cddaText(it.def.name);
  // Nothing left to train: "until you gain a level" would just be one chapter anyway.
  if (!b.skill || c.getSkill(b.skill) >= b.level) mode = 'once';
  const st: ReadingState = { book: it, mode, sessions: 0 };
  const session = (): boolean => {
    const vision = fineVisionMod(host);
    if (vision > 1.5) host.message("It's difficult for you to see fine details right now.  Reading will take longer than usual.", 'c_yellow');
    reading.current = st;
    const ok = host.activities.start({
      name: `reading ${title}`,
      kind: 'read',
      target: it,
      customUi: true,
      duration: timeToRead(c, it, vision),
      onComplete: () => {
        st.sessions++;
        if (!c.inv.has(it) && !nearby(host, it)) {
          reading.current = null;
          return;
        }
        const more = finishSession(host, it, mode);
        for (const h of readSessionHooks) h(st);
        if (more && !cantRead(host, it)) session();
        else {
          reading.current = null;
          host.message('You finish reading.');
        }
      },
      onCancel: () => void (reading.current = null),
    });
    if (!ok) reading.current = null;
    return ok;
  };
  return session();
}

function nearby(host: CraftHost, it: Item): boolean {
  const p = host.player;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const mi of host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) if (mi === it || (typeof (mi as Item).walk === 'function' && [...(mi as Item).walk()].includes(it))) return true;
  return false;
}

/** Books the player carries or has within reach. */
export function readableBooks(host: CraftHost): Item[] {
  const p = host.player;
  const out = p.inv.allItems().filter((i) => i.isBook());
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const mi of host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) {
        if (typeof (mi as Item).walk !== 'function') continue;
        // Books on the floor, or in a container lying there.
        for (const it of (mi as Item).walk()) if (it.isBook()) out.push(it);
      }
  return out;
}
