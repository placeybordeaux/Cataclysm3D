// Tip-of-the-day, adapted (docs/ADAPTATION.md). BN's data/core/tips.json is written for the
// turn-based ASCII game: some tips name features this port doesn't have (Safe Mode rules,
// world spawn options, firewood zones, helicopters, going prone), some assume the keyboard-only
// interface ("visit the keybindings menu to learn your ropes"), and a few are in-jokes that land
// only for veterans. Newcomers read the tip on the title screen as a promise about this game.
//
// So: every BN tip is either kept as written, rewritten for a first-person real-time game, or
// dropped — decided here, by the tip's exact text, so a data update that adds a tip can't slip
// an unreviewed one through (unknownTips() lists them; tests/tips_adapted.test.ts fails on
// any). Then a handful of tips this port needs that BN doesn't have.
//
// Options > Tips: "Adapted" (default) or "Cataclysm originals" (the unfiltered BN list).

import { registerOption } from './options';

/** BN tip text → null (drop: feature missing / wrong for this medium) or a rewrite. */
const REVIEW: Record<string, string | null> = {
  'You can automatically learn every recipe for which you meet skill requirements for, by reading the book with them.':
    'Reading a book teaches you every recipe in it that your skills are good enough for.',
  "Even if you don't get the power running again, ovens can be useful fire containers.": null,
  'Power may be out, but by constructing solar panels or other furniture, you can generate your own electricity.': null,
  'Peek around corners.  You may see your enemy before it sees you.':
    'Crouch and look around corners before you step out.  You may see them before they see you.',
  "Just because a place is dangerous doesn't mean it's worth looting.": null,
  'Balance armor versus encumbrance.  Even dropping a backpack can help in melee.':
    'Heavy armour and a stuffed backpack make you slower and clumsier in a fight.  Drop the bag before a brawl.',
  'Scared of melee?  Throw some things at enemies and use reach weapons like spears.':
    'Scared of melee?  A spear keeps them at arm\'s length, and anything you carry can be thrown.',
  'Not much survives a car at 120mph.  Can you?': 'Not much survives being hit by a car.  That includes you: buckle up and slow down near crowds.',
  'Why walk when you can use a car?  Or an APC?': 'Why walk when you can drive?  Walk up to a driver\'s door and press the interact key.',
  'Not all helicopters are useless wrecks.  Some can still be flown, or fixed up to fly again.': null,
  'There are fungi you want to eat, and those you want to burn.  You\'ll know the difference.': null,
  'Be mindful of environmental protection of your gear.  It can take you places.': null,
  "Broken limb pinned you down?  Hospitals might have next-gen tech to get you going.": null,
  "Don't be afraid to make the game easier on yourself.  Worlds can be made to spawn with more resources.":
    "Don't be afraid to make the game easier on yourself.  The Accessible difficulty is the intended way to learn.",
  'When the whole town is one big supermarket a shopping cart becomes your best friend.': null,
  'Learning how to play?  Visit the keybindings menu and learn your ropes.':
    'Learning how to play?  Press ? in game for every key, and open the Journal (J) to read what you have discovered.',
  "Expect the unexpected, even if it's the Spanish Inquisition.": null,
  'You can throw things while peeking around corners.  Perfect for taking down gun turrets.': null,
  'Nobody told the vending machines that the world ended.  Save those cash cards!': null,
  'Deep within a gigantic lab lies a secret.  Bring the best firepower you can muster.': null,
  'The number of zombies in a city is large but finite.  You can (eventually) kill them all.': null,
  'You can make your own Safe Mode rules in the pause menu.': null,
  'Most zombies go through cars, not around them.  Remember that when running away.': null,
  'Certain corpses can give you bionics if you dissect them.': null,
  'Designating a firewood source will make maintaining a fire much simpler.': null,
  'With enough parts, your mobile home could be a rolling mobile command center.': null,
  "Having trouble finding pants that fit after hulking out?  Some outfits can be given that special touch with a tailor's kit.": null,
  'Take cover!  Standing next to sandbags or other obstacles will let you shoot past them unimpeded, while blocking some return fire.': null,
  'Ballistic windows can take the bite out of bullets flying your way.  Boulders or other hard obstacles can also block shots, or be shot over if you\'re next to them.': null,
  'Many types of furniture have a chance to intercept bullets, reducing some of the damage taken.  The bigger and harder the obstacle, the better.': null,
  'If you prefer a more subtle approach to breaking and entering, crouching or going prone will make you automatically prioritize lockpicking over prying tools.': null,
  'Crouching slows you down, but allows you to hide behind obstacles and makes you a smaller target when bullets start flying.':
    'Crouching slows you down, but you make less noise and are harder to spot.',
  'Make every shot count.  Take time to steady your aim, or crouch for more accurate fire.':
    'Make every shot count.  Hold the right mouse button to aim; gunfire brings every zombie for blocks.',
  'Running, swimming, and other physical activity will increase your Athletics skill, reducing encumbrance penalty, decreasing stamina consumption, and making swimming easier.':
    'Running and swimming train your Athletics skill: more stamina, and heavy clothes slow you less.',
  'Smoking and napping is asking for more than a hole in your shirt.': null,
  'Like to gamble?  Use mutagen!  Be a winner today!': null,
  'Mutated wildlife is still edible, but not without risk.  After all, you are what you eat.': null,
  'Famous last words:  Let\'s poke this electric zombie with a metal stick.': null,
  'Moose may not be your friend.': null,
};

/** BN tips kept exactly as written (reviewed: true in this port, plain enough for newcomers). */
const KEEP = new Set<string>([
  'Fires can spread easily, especially with abundance of fuel.',
  "Light itself doesn't draw zombies, it's sight, noise or smell.",
  'Turnout gear protects from fire but not from overheating.',
  'Cold food lasts longer.  Find a cool basement or make a root cellar.',
  "Dying is part of the experience.  Try again with what you've learned.",
  'Underground spaces like basements or caves stay cool year-round.',
  'Afraid of wildlife?  Yell until it goes away.  But beware of what comes instead.',
  'Animals and zombies are not friends.  You can take advantage of that.',
  'A door is not the only way in or out of most places.',
  "Don't fight against the odds.  There's no shame in running to survive.",
  "You don't have to sit next to fire to use it.",
  'Many items have special actions.  Try to find out what they do.',
  "If you're breaking in, be sure you also know how to get back out.",
  "There's usually more than one way to do things.  Think outside the box.",
  'Survival order: shelter, water, food, then everything else.',
  'Makeshift weapons can break easily, but they are weapons, and can be made again.',
  'Drugs are great for quick stat boosts, but be careful of addictions or overdose.',
  'Use your map wisely.  Prioritize looting places that will get you what you need.',
  'Wounds heal over time.  Bandages and antiseptic speeds that up.',
  "Don't get grabbed by zombies.  Their bites can be infectious.",
  'Feeling odd after waking up?  Try eating healthier and your health may improve.',
  'Eat well or your health might suffer.  Fast food is only good in a pinch.',
  'Nature can provide.  You can live off the land if you learn how.',
  "Raw food and water from unsafe sources can't be healthy.  Right?",
  "Food from before the Cataclysm won't last forever.  Keep that in mind.",
  'You can make unusual things from usual stuff.  Go full MacGyver style if needed.',
  'Having a backup weapon is wise.  So is having a backup plan.',
  'Windows can\'t stop zombies but they can stop gas, bile, and smoke.  And your smell.',
  'Wet and angry?  A dry towel will bring your smile back.',
  "You're on fire?  Stop and wait to put it out.",
  "Routine kills.  Stay alert!  Don't let your guard down.",
  "Most medicine doesn't work instantly, so don't swallow a whole bottle of pills.",
  'A full stomach will not solve your starvation.  Give it time and eat regularly.',
  "Don't overlook protective gear, like gas masks or turnout gear.  You never know.",
  'Out of resources?  Breaking or disassembling stuff can yield interesting components.',
  'Temperature affects the shelf life of foods.  The colder, the better.',
  "'Tis but a scratch?'  Bandage and disinfect it anyway to speed up healing.",
  'Terrain that slows you down will also slow down your enemies.',
  'Trying out different characters, professions, and scenarios can spice up your game.  Roleplay!',
  'A survivor saved is a friend earned.  Most of the time…',
  "There's got to be some cool stuff in those top-secret underground labs, right?",
  'Put a funnel over a jug or barrel to collect rainwater over time.',
  "Did you *only* take everything not nailed down?  Go back for the nails!",
  'The best gun in the world is useless without ammo.',
  "If you're stuck inside with a broken leg, read some books to pass the time.",
  "Don't be too greedy.  Loot doesn't matter if you're dead.",
  'The floor is too hard to sleep on?  Try gathering a pile of leaves.',
]);

/**
 * Tips this port needs that BN doesn't have: the real-time, first-person parts a Cataclysm
 * veteran and a newcomer both have to learn. `{key:action}` is replaced by the bound key.
 */
export const PORT_TIPS: string[] = [
  'Watch a zombie\'s arms: when it winds up, hold the right mouse button to guard, or side-step with Space.',
  'Timed jobs like lighting a fire or crafting need you to stand still.  Walking away stops them.',
  'Tap {key:tactical_pause} to pause the world and think.  Nothing moves until you tap it again.',
  'The crosshair tells you what {key:interact} will do.  Walk up to anything and look at it.',
  'A "?" floating over furniture means you haven\'t looked inside yet.',
  'No weapon?  Smash a young tree for a long stick; it beats bare hands.',
  'Zombies follow noise.  A smashed window is heard for blocks; a closed door is not.',
  'Menus pause the game.  {key:close_menu} closes any of them and keeps the mouse in the game.',
  'Running burns stamina.  Watch the stamina bar and stop before you are winded.',
];

export type TipsMode = 'adapted' | 'original';
const KEY = 'cdda3d.tipsMode';

export function tipsMode(): TipsMode {
  try {
    return localStorage.getItem(KEY) === 'original' ? 'original' : 'adapted';
  } catch {
    return 'adapted';
  }
}

export function setTipsMode(m: TipsMode): void {
  try {
    localStorage.setItem(KEY, m);
  } catch {
    // not persisted
  }
}

/** BN tips the review above hasn't decided on (for the test: must be empty). */
export function unknownTips(bnTips: readonly string[]): string[] {
  return bnTips.filter((t) => !KEEP.has(t) && !(t in REVIEW));
}

/**
 * The tip list shown to players. Unreviewed BN tips are left out (not shown unchecked) — the
 * test catches them at build time; at run time a stale review mustn't put a wrong tip on screen.
 */
export function adaptedTips(bnTips: readonly string[], keyLabel: (id: string) => string, mode: TipsMode = tipsMode()): string[] {
  if (mode === 'original') return bnTips.slice();
  const out: string[] = [];
  for (const t of bnTips) {
    if (KEEP.has(t)) out.push(t);
    else if (t in REVIEW && REVIEW[t] !== null) out.push(REVIEW[t]!);
  }
  for (const t of PORT_TIPS) out.push(t.replace(/\{key:([a-z_0-9]+)\}/g, (_m, id: string) => `[${keyLabel(id)}]`));
  return out;
}

let registered = false;
export function registerTipsOption(): void {
  if (registered) return;
  registered = true;
  registerOption({
    name: 'Tips',
    value: () => (tipsMode() === 'original' ? 'Cataclysm originals' : 'Adapted'),
    change: () => setTipsMode(tipsMode() === 'original' ? 'adapted' : 'original'),
    desc: 'Tip of the day: rewritten for this game (default), or the full list from Cataclysm: Bright Nights, including tips about features this version does not have.',
  });
}

// ------------------------------------------------------------------ sleep menu wording

/**
 * The sleep menu entry in words: CDDA's "(wooden floor, comfort 0)" is a raw rating a newcomer
 * can't read. Say how the spot feels, what would be better, and whether you'll drop off at all.
 */
export function sleepSpotText(comfort: number, on: string, sleepiness: string): { spot: string; good: boolean; note: string } {
  const feel = comfort <= -999 ? "you can't sleep here" : comfort < 0 ? 'uncomfortable' : comfort === 0 ? 'hard' : comfort < 3 ? 'a little hard' : comfort < 5 ? 'okay' : comfort < 10 ? 'comfortable' : 'very comfortable';
  // A straw bed (comfort 2) is already a bed: "a bed would help" read as a contradiction while
  // lying in one (playtest, round 6). Name the next step up instead.
  const better = comfort <= -999 || comfort >= 3 ? '' : comfort > 0 ? ': a mattress, a proper bed or a sleeping bag would be better' : ': a bed or sleeping bag would help';
  const note = sleepiness ? '' : "You aren't tired yet: you may just lie awake.";
  return { spot: `${on}, ${feel}${better}`, good: comfort >= 3, note };
}
