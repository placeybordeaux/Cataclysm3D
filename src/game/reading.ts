import type { Character } from './character';
import type { Item } from './item';
import { bookRecipeIndex, hasCraftingLight, learnRecipe, recipeName, type CraftHost } from './crafting';
import { cddaText } from './units';

// Reading (activity_actor.cpp read_activity_actor, character_knowledge.cpp), simplified to
// one skill level per skill (no separate theory/practice): the first read of a book is a
// quick skim that identifies it; after that each session ("chapter") trains the book's skill
// up to its max_level, gives the book's fun as morale, and teaches the recipes the book
// contains once you have the skill for them. Reading continues session after session until
// the skill goes up, the book has nothing left to teach, or you're interrupted — like CDDA.

export interface BookData {
  skill?: string;
  /** Skill needed to understand it (CDDA "required_level"). */
  req: number;
  /** Max level it can train to (CDDA "max_level"). */
  level: number;
  /** Seconds per session. */
  time: number;
  intel: number;
  fun: number;
  chapters: number;
}

export function bookData(it: Item): BookData | null {
  if (!it.isBook()) return null;
  const d = it.def;
  return {
    skill: (d.read_skill as string | undefined) ?? (d.skill as string | undefined),
    req: d.required_level ?? 0,
    level: d.max_level ?? 0,
    time: d.time ?? 60,
    intel: d.intelligence ?? 0,
    fun: Number(d.read_fun ?? d.fun ?? 0),
    chapters: d.chapters ?? 0,
  };
}

/** Character::read_speed as a percentage (100 at int 8). */
export function readSpeed(c: Character): number {
  return (180 / (2 + c.int / 8)) * (100 / 60);
}

/** Character::time_to_read: skimming an unidentified book takes a tenth of the time. */
export function timeToRead(c: Character, it: Item): number {
  const b = bookData(it);
  if (!b) return 0;
  let t = (b.time * readSpeed(c)) / 100;
  if (b.intel > c.int) t += (b.time * (b.intel - c.int)) / 60;
  if (!c.identifiedBooks.has(it.typeId)) t /= 10;
  return Math.max(1, Math.round(t));
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

/**
 * The device an e-book is stored on (a phone's or laptop's E_FILE_STORAGE pocket), searched
 * among carried items and those next to the reader; null for paper books.
 */
export function efileDevice(host: CraftHost, it: Item): Item | null {
  const p = host.player;
  const cands: Item[] = [...p.inv.allItems()];
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const mi of host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) if (typeof (mi as Item).walk === 'function') cands.push(...(mi as Item).walk());
  return cands.find((d) => d.pockets.some((pk) => pk.type === 'E_FILE_STORAGE' && pk.contents.includes(it))) ?? null;
}

/**
 * Why an e-book can't be read on its device: storage-only media (USB drives, memory cards)
 * need a reader (CDDA E_FILE_DEVICE), and a reader needs battery charge.
 */
export function ereaderProblem(dev: Item): string | null {
  const reader = dev.magazinePockets().length > 0 || !!dev.magazineWell() || (dev.def.max_charges ?? 0) > 0;
  if (!reader) return `You need a phone or a laptop to read files from the ${dev.baseName()}.`;
  if (dev.ammoRemaining() <= 0) return `The ${dev.baseName()}'s battery is dead.`;
  return null;
}

/** Why `c` can't read `it` right now (CDDA read_condition_result wording), or null. */
export function cantRead(host: CraftHost, it: Item): string | null {
  const c = host.player;
  const b = bookData(it);
  if (!b) return `Your ${it.name()} is not good reading material.`;
  const dev = efileDevice(host, it);
  if (dev) {
    const why = ereaderProblem(dev);
    if (why) return why;
  }
  // A lit screen needs no lamp.
  if (!dev && !hasCraftingLight(host) && !it.hasFlag('CAN_USE_IN_DARK')) return "It's too dark to read!";
  if (c.identifiedBooks.has(it.typeId)) {
    const m = bookMastery(c, it);
    if (m === 'cant_understand') return `${c.skillName(b.skill!)} ${b.req} needed to understand.  You have ${c.getSkill(b.skill!)}.`;
    if (b.fun <= 0 && c.morale.level() < -40) return 'What\'s the point of studying?  (Your morale is too low!)';
    if (m === 'mastered' && b.fun <= 0 && !teachableRecipes(c, it).length) return `You won't learn anything more from ${cddaText(it.def.name)}.`;
  }
  return null;
}

/** Recipes the book would teach `c` now that aren't known yet. */
export function teachableRecipes(c: Character, it: Item) {
  return (bookRecipeIndex(c.data).get(it.typeId) ?? []).filter(
    (br) => !c.learnedRecipes.has(br.recipe.id) && (!br.recipe.skill_used || c.getSkill(br.recipe.skill_used) >= br.level),
  );
}

/** Info lines shown when a book is identified (avatar::identify). */
export function identifyLines(c: Character, it: Item): string[] {
  const b = bookData(it)!;
  const out = [`You skim ${cddaText(it.def.name)} to find out what's in it.`];
  if (b.skill) {
    out.push(`Can bring your ${c.skillName(b.skill)} knowledge to ${b.level}.`);
    if (b.req) out.push(`Requires ${c.skillName(b.skill)} knowledge level ${b.req} to understand.`);
  }
  if (b.intel) out.push(`Requires intelligence of ${b.intel} to easily read.`);
  if (b.fun) out.push(`Reading this book affects your morale by ${b.fun}.`);
  out.push(`A chapter of this book takes ${Math.round(b.time / 60)} minutes to read.`);
  const rec = bookRecipeIndex(c.data).get(it.typeId) ?? [];
  if (rec.length) out.push(`This book contains ${rec.length} crafting recipe${rec.length === 1 ? '' : 's'}: ${rec.slice(0, 6).map((r) => recipeName(c.data, r.recipe)).join(', ')}${rec.length > 6 ? ', …' : ''}.`);
  return out;
}

/**
 * read_activity_actor::read_book + SkillLevel::readBook: experience (lvl+1)*rng(min,max)*100
 * where min/max come from session minutes and intelligence. Returns true on level up.
 */
export function trainFromBook(c: Character, it: Item, host?: CraftHost): boolean {
  const b = bookData(it)!;
  if (!b.skill) return false;
  const sk = (c.skills[b.skill] ??= { level: 0, exercise: 0 });
  if (sk.level >= b.level) return false;
  const minutes = b.time / 60;
  const focus = Math.max(1, c.focus) / 100;
  let minEx = Math.max(1, Math.floor(minutes / 10 + c.int / 4));
  let maxEx = Math.floor(minutes / 5 + c.int / 2 - sk.level);
  minEx = Math.round(minEx * focus);
  maxEx = Math.max(minEx, Math.min(10, Math.max(2, Math.round(maxEx * focus))));
  minEx = Math.max(1, minEx * (sk.level + 1));
  maxEx = Math.max(minEx, maxEx * (sk.level + 1));
  const gain = (sk.level + 1) * c.rng.int(minEx, maxEx) * 100;
  sk.exercise += gain;
  const need = () => 10000 * (sk.level + 1) ** 2;
  let leveled = false;
  while (sk.exercise >= need() && sk.level < b.level) {
    sk.exercise -= need();
    sk.level++;
    leveled = true;
  }
  const say = (t: string, col?: string) => (host ? host.message(t, col) : c.msg(t, col));
  if (leveled) say(`Your skill in ${c.skillName(b.skill)} increases to level ${sk.level}.`, 'c_light_green');
  else say(`You learn a little about ${c.skillName(b.skill)}!  (${Math.floor((100 * sk.exercise) / need())}%)`, 'c_cyan');
  if (sk.level >= b.level) say(`You can no longer learn from ${cddaText(it.def.name)}.`);
  return leveled;
}

/** Learn every recipe from the book the reader now has the skill for. */
export function learnBookRecipes(c: Character, it: Item, host?: CraftHost): string[] {
  const learned: string[] = [];
  for (const br of teachableRecipes(c, it)) {
    if (!learnRecipe(c, br.recipe.id)) continue;
    const name = br.name || recipeName(c.data, br.recipe);
    learned.push(name);
    (host ? host.message.bind(host) : c.msg.bind(c))(`You learn how to craft ${name}.`, 'c_light_green');
  }
  return learned;
}

/** One read session; returns whether to keep reading. */
function finishSession(host: CraftHost, it: Item): boolean {
  const c = host.player;
  const b = bookData(it)!;
  if (!c.identifiedBooks.has(it.typeId)) {
    c.identifiedBooks.add(it.typeId);
    for (const l of identifyLines(c, it)) host.message(l, 'c_light_gray');
    return false;
  }
  if (b.fun !== 0) c.morale.add('morale_book', b.fun * 5, b.fun * 15, 3600, 1800, true, it.typeId);
  const mastery = bookMastery(c, it);
  let keepGoing = false;
  if (mastery === 'learning') keepGoing = !trainFromBook(c, it, host) && bookMastery(c, it) === 'learning';
  learnBookRecipes(c, it, host);
  return keepGoing;
}

/** Start (continuous) reading of `it`. Returns false with a message if it can't be read. */
export function startReading(host: CraftHost, it: Item): boolean {
  const why = cantRead(host, it);
  if (why) {
    host.message(why, 'c_light_red');
    return false;
  }
  const c = host.player;
  const title = cddaText(it.def.name);
  const session = (): boolean =>
    host.activities.start({
      name: c.identifiedBooks.has(it.typeId) ? `reading ${title}` : `skimming ${title}`,
      duration: timeToRead(c, it),
      onComplete: () => {
        const dev = efileDevice(host, it);
        if (!c.inv.has(it) && !nearby(host, it) && !dev) return;
        // Reading on a screen drains the battery: one charge per session.
        if (dev) dev.ammoConsume(1);
        if (finishSession(host, it) && !cantRead(host, it)) session();
        else host.message('You finish reading.');
      },
    });
  return session();
}

function nearby(host: CraftHost, it: Item): boolean {
  const p = host.player;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z).includes(it)) return true;
  return false;
}

/** Books the player carries or has at their feet. */
export function readableBooks(host: CraftHost): Item[] {
  const p = host.player;
  const out = p.inv.allItems().filter((i) => i.isBook());
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      for (const mi of host.map.itemsAt(Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) {
        if (typeof (mi as Item).walk !== 'function') continue;
        // Paper books on the floor, and e-books on a phone or laptop lying there.
        for (const it of (mi as Item).walk()) if (it.isBook() && (it === mi || efileDevice(host, it))) out.push(it);
      }
  return out;
}
