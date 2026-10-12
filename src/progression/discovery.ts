// In-run discovery (docs/DESIGN_V2.md decision 6): first-time explanations of mechanics as
// the player meets them, and "you could craft…" when what you carry or stand next to makes
// a recipe newly craftable. UI-free: the rules here decide *whether and when*; install.ts
// detects the situations and draws the toasts.
//
// Never naggy:
//   - each tip is shown once per profile (profile.hintsShown), then lives in the journal;
//   - at most one nudge per MIN_GAP (20 s of real time), queued otherwise;
//   - nothing while fighting or while a window is open (queued until calm);
//   - recipe nudges group ("3 new recipes: …") and never repeat a recipe you were told
//     about or have crafted;
//   - "Don't show hints" (profile option) stops the toasts; the journal still fills in.
//
// Text may use `<keybind:action>` (resolved to the player's current key by the caller).

export type NudgeCategory = 'discovery' | 'warning';

export interface NudgeDef {
  id: string;
  /** Toast title. */
  title: string;
  /** Toast body: one sentence, with the key to press. */
  body: string;
  /** Longer journal text. */
  journal: string;
  /** Journal section. */
  topic: 'Basics' | 'Combat' | 'Needs' | 'World' | 'Items';
  /** Higher shows first when several are queued; urgent ones use the warning style. */
  priority: number;
  category?: NudgeCategory;
}

const N = (id: string, topic: NudgeDef['topic'], priority: number, title: string, body: string, journal: string, category: NudgeCategory = 'discovery'): NudgeDef =>
  ({ id, topic, priority, title, body, journal, category });

/** Every first-encounter tip. Ids are stable (stored in profiles). */
export const NUDGES: Record<string, NudgeDef> = Object.fromEntries([
  N('welcome', 'Basics', 5, 'Search for supplies',
    'Walk up to lockers and cupboards and press <keybind:interact>. <keybind:pickup> picks things up.',
    'Everything in the world is a real object. Furniture holds loot: walk up to it and press <keybind:interact> to look inside, <keybind:pickup> to pick up what lies around you. <keybind:inventory> shows what you carry.'),
  N('first_zombie', 'Combat', 9, 'Zombie!',
    'Hold right mouse to ready your weapon, left mouse swings. Space side-steps. Shift runs: you can outrun most of them.',
    'Zombies are slow but hit hard and come in crowds. Hold right mouse to ready your weapon (you walk slower and guard while it is up), then left mouse swings; watch the wind-up before their blows land. Space side-steps out of a swing. Shift lowers the weapon and runs; running away is always an option. Noise (smashing, shouting, gunfire) pulls in everything nearby. (Options > Controls > Melee brings back swinging any time.)'),
  N('first_hunger', 'Needs', 6, 'You are getting hungry',
    'Eat with <keybind:eat>. Fresh food spoils; canned and dried food keeps.',
    'Hunger builds slowly. <keybind:eat> eats or drinks something you carry or stand next to. Fresh food rots in a few days; canned, dried and junk food keeps. Cooking needs a fire and a pot.'),
  N('no_food', 'Needs', 7, 'Nothing to eat',
    'Kitchens (cupboards, fridges), stores and crates hold food. Canned food keeps for years.',
    'Food is where people kept it: kitchen cupboards and fridges in houses, grocery and convenience stores, crates and boxes in warehouses. Canned, dried and junk food keeps; fresh food spoils in days. Hunger works slowly (you weaken over days), thirst much faster: find water first.'),
  N('first_thirst', 'Needs', 7, 'You are thirsty',
    'Drink with <keybind:eat>. Water from rivers and toilets should be boiled first.',
    // Not "can make you sick": in BN unclean water has no disease (no contamination in its
    // JSON; iuse::blech_because_unclean only asks for confirmation). Say what's true.
    'Thirst is faster than hunger. Bottled water and soda are clean; water from rivers, lakes and toilets is unclean ("safer to drink once purified"). Boil it at a fire with a pot (the fire offers Boil water) and keep a container of clean water.'),
  N('first_fatigue', 'Needs', 6, 'You are getting tired',
    'Sleep with <keybind:sleep>, ideally in a bed behind a closed door.',
    'Sleep restores you. <keybind:sleep> lies down; a bed or a sleeping bag helps you fall asleep, and a closed room keeps wanderers from finding you. <keybind:wait> waits without sleeping.'),
  N('first_night', 'World', 6, 'Night falls',
    'Press <keybind:flashlight> for your flashlight if you have one. Light lets you see — and be seen.',
    'Nights are dark. You need light to read and craft, and to see what is coming. <keybind:flashlight> toggles a flashlight you carry. Light also shows you to everything outside: many survivors spend the night indoors.'),
  N('first_bleed', 'Combat', 10, 'You are bleeding',
    'Apply a bandage or rag with <keybind:apply> before you lose too much blood.',
    'Deep wounds bleed until treated. <keybind:apply> a bandage, rag or first aid kit to stop it. Losing blood makes you weak and eventually kills you.', 'warning'),
  N('first_locked', 'World', 5, 'Locked door',
    'Smash it with <keybind:smash> (noisy), or pry it open with a crowbar via <keybind:apply>.',
    'Locked doors can be smashed with <keybind:smash> — loud, and it attracts zombies — or opened quietly: a crowbar or halligan bar pries, lockpicks pick. Windows are another way in (mind the glass).'),
  N('first_overweight', 'Items', 7, 'You are carrying too much',
    'Over your weight limit you move slowly and tire fast. Drop something with <keybind:drop>.',
    'Every item has weight and volume. Over your weight limit you move slowly and burn stamina; over your bag space you can\'t pick more up. Wear a backpack and leave heavy junk behind (<keybind:drop>).', 'warning'),
  N('first_stairs', 'World', 4, 'Stairs',
    'Use <keybind:stairs_up> and <keybind:stairs_down> to climb and descend.',
    'Buildings have upper floors, roofs and basements. Stand on stairs or a ladder and press <keybind:stairs_up> / <keybind:stairs_down>. Basements are dark: bring light.'),
  N('first_vehicle', 'World', 4, 'A vehicle',
    'Walk up to the driver\'s door and press <keybind:interact> to drive; <keybind:vehicle_engine> starts the engine, WASD drives.',
    'Vehicles are the fastest way to travel and carry loot. Walk up to the driver\'s door and press <keybind:interact> (or <keybind:control_vehicle> from anywhere near the seat), start the engine (<keybind:vehicle_engine>) and drive with WASD; Space is the handbrake. Many need fuel, a battery or repairs.'),
  N('first_npc', 'World', 5, 'Another survivor',
    'Walk up and press <keybind:interact> to talk. Not everyone is friendly.',
    'Other survivors roam the world. <keybind:interact> talks to them; you can trade, recruit and take missions (<keybind:missions>). Some will rob you.'),
  N('first_corpse', 'Items', 4, 'A corpse',
    'Butcher it with <keybind:butcher> using a cutting tool: meat, bones and leather.',
    'Corpses can be butchered with a knife (<keybind:butcher>) for meat, fat, bones and skin. Zombie flesh is tainted: don\'t eat it. Smash zombie corpses so they don\'t get back up.'),
  N('first_cold', 'Needs', 7, 'You are cold',
    'Put on warmer clothes with <keybind:wear>, get out of the rain, or light a fire.',
    'Body temperature matters: cold slows you and can kill. Wear layers (<keybind:wear>), stay dry, and warm up next to a fire or indoors.', 'warning'),
  N('first_book', 'Items', 4, 'A book',
    'Read it with <keybind:read>: books teach skills and recipes.',
    'Books teach skills and contain recipes. <keybind:read> reads one (you need light). Fun books lift your mood; manuals and textbooks train skills.'),
  // Combat lessons taught by short crosshair hints (src/ui/combatHints.ts) rather than toasts:
  // they are only marked discovered here so the journal keeps the longer explanation.
  N('aim_sway', 'Combat', 0, 'Your aim sways',
    'Your aim sways: fire as it crosses the target.',
    'In first person your shot goes exactly where the crosshair is. The less skilled you are, the more the crosshair weaves (and walking, running, pain and exhaustion make it worse); holding right mouse steadies it. Fire as it crosses the target. Skill also makes every hit do more damage.'),
  N('aim_headshot', 'Combat', 0, 'Headshots',
    'Aim for the head: ×2 damage.',
    'Where a shot or a blow lands matters: the head takes double damage (a club to the head can stun), legs and arms less (a blow to the legs can knock a zombie down). The line above the crosshair says why a hit was strong or weak.'),
  N('melee_guard', 'Combat', 0, 'Guard',
    'Hold right mouse to guard · Space to side-step.',
    'Zombies rear back before they strike. Holding right mouse (your weapon readied) is your guard; raising it just as the blow comes is a parry that staggers them. Or tap Space to side-step out of reach.'),
  N('first_rain', 'World', 3, 'Rain',
    'Getting wet chills you. Head indoors, or wear something waterproof.',
    'Rain soaks your clothes, and wet clothes make you cold. It also muffles sound and limits sight — for them as well as for you.'),
  N('first_craft', 'Items', 5, 'Crafting',
    'Open the crafting menu with <keybind:craft> to see everything you can make.',
    'Crafting (<keybind:craft>) uses what you carry and what lies within two steps of you. Recipes need components, tools and skill; books teach more. The journal lists recipes you have discovered.'),
].map((d) => [d.id, d]));

/** A nudge waiting to be shown. `repeatable` ones (recipes) aren't once-per-profile. */
export interface Pending {
  id: string;
  priority: number;
  repeatable?: boolean;
  queuedAt: number;
}

export interface NudgeRules {
  /** ms between shown nudges. */
  minGap: number;
  maxQueue: number;
  /** Queued entries older than this (ms) are dropped: the moment passed. */
  maxAge: number;
}
export const NUDGE_RULES: NudgeRules = { minGap: 20_000, maxQueue: 6, maxAge: 5 * 60_000 };

export type OfferResult = 'queued' | 'seen' | 'duplicate' | 'dropped';

/**
 * The rate limiter. `offer` when something is noticed, `next` every frame-ish with whether
 * nudges are blocked right now (fighting, a window open); it returns the id to show or null.
 * The caller marks non-repeatable ids as shown when it actually shows them.
 */
export class NudgeQueue {
  readonly queue: Pending[] = [];
  private lastShown = -Infinity;

  constructor(
    private readonly shown: (id: string) => boolean,
    readonly rules: NudgeRules = NUDGE_RULES,
  ) {}

  offer(id: string, priority: number, now: number, repeatable = false): OfferResult {
    if (!repeatable && this.shown(id)) return 'seen';
    if (this.queue.some((p) => p.id === id)) return 'duplicate';
    this.queue.push({ id, priority, repeatable, queuedAt: now });
    // Highest priority first; ties keep arrival order (stable sort).
    this.queue.sort((a, b) => b.priority - a.priority);
    if (this.queue.length > this.rules.maxQueue) {
      const dropped = this.queue.pop()!;
      return dropped.id === id ? 'dropped' : 'queued';
    }
    return 'queued';
  }

  /** The next nudge to show now, or null (too soon, blocked, or nothing queued). */
  next(now: number, blocked: boolean): Pending | null {
    for (let i = this.queue.length - 1; i >= 0; i--) if (now - this.queue[i].queuedAt > this.rules.maxAge) this.queue.splice(i, 1);
    if (blocked || !this.queue.length || now - this.lastShown < this.rules.minGap) return null;
    // A tip shown since it was queued (another path, an import) is skipped, not re-shown.
    while (this.queue.length && !this.queue[0].repeatable && this.shown(this.queue[0].id)) this.queue.shift();
    const p = this.queue.shift();
    if (!p) return null;
    this.lastShown = now;
    return p;
  }

  /** ms until the next nudge may show (0 = now). */
  cooldown(now: number): number {
    return Math.max(0, this.rules.minGap - (now - this.lastShown));
  }

  clear(): void {
    this.queue.length = 0;
  }
}

/**
 * Recipe ids announced by a "you could craft" nudge that the player hasn't looked at yet: the
 * crafting screen marks them NEW (and starts on them) and clears the set when it closes.
 */
export const newRecipes = new Set<string>();

/**
 * Recipes that just became craftable and are worth telling about: craftable now, not a
 * moment ago, never crafted and never announced. Pure; the caller supplies the sets.
 */
export function craftableDiff(prev: ReadonlySet<string>, now: ReadonlySet<string>, crafted: (id: string) => boolean, notified: (id: string) => boolean): string[] {
  const out: string[] = [];
  for (const id of now) if (!prev.has(id) && !crafted(id) && !notified(id)) out.push(id);
  return out;
}

/** "You could craft: wooden spear" / "3 new recipes: a, b and c" (names already resolved). */
export function recipeNudgeText(names: string[]): { title: string; body: string } {
  if (!names.length) throw new Error('recipeNudgeText: no recipes');
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  if (sorted.length === 1) return { title: `You could craft: ${sorted[0]}`, body: 'Open crafting with <keybind:craft>.' };
  const shown = sorted.slice(0, 3);
  const rest = sorted.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return { title: `${sorted.length} new recipes`, body: `You could craft ${list}. Open crafting with <keybind:craft>.` };
}

/**
 * Signature of what the craftable set depends on (item types + counts in reach, known
 * recipes, skill levels). Recomputing craftability is only worth it when this changes.
 */
export function reachSignature(parts: Iterable<string>): string {
  const counts = new Map<string, number>();
  for (const p of parts) counts.set(p, (counts.get(p) ?? 0) + 1);
  return [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}:${v}`).join(',');
}
