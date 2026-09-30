// Pure rules behind the modern HUD (src/ui/hud_modern.ts): how bad each need is and what to
// tell the player about it, body-part tones, compass geometry, message tones, light labels.
// No DOM, unit-tested in tests/hud.test.ts.

export type Severity = 0 | 1 | 2 | 3;
export type NeedId = 'hunger' | 'thirst' | 'fatigue' | 'temperature' | 'pain' | 'morale' | 'weight';

export interface NeedState {
  id: NeedId;
  /** 0 = nothing to worry about (the icon stays dim), 3 = an emergency (pulses). */
  level: Severity;
  /** A positive state worth a small green note (well fed, good mood). */
  good?: boolean;
  /** Short state word shown next to a lit icon ("Thirsty"); '' when fine. */
  label: string;
  /** Tooltip title + what it means + what to do (keys already resolved). */
  title: string;
  tip: string;
  advice: string;
}

/** The slice of Character the need rules read (keeps the rules testable with a stub). */
export interface NeedSource {
  hungerState(): string;
  thirstDescription(): string;
  sleepinessDescription(): string;
  bodyTempDescription(): string;
  perceivedPain(): number;
  painDescription(): string;
  morale: { level(): number };
  inv: { weightCarried(): number; weightCapacity(): number };
  /** Active effects (only `bloated` is read: see the hunger rule). Optional for test stubs. */
  effects?: { has(id: string): boolean };
}

/**
 * Effects whose meaning the need icons already carry, so the HUD shouldn't show them again as a
 * chip. "Bloated" next to "Famished" read as a contradiction in playtests: in BN the first is
 * the stomach (you just ate or drank more than it holds at once), the second the body's
 * reserves (days of eating too little). The hunger icon now says both in one place.
 */
export const EFFECTS_SHOWN_AS_NEEDS = new Set(['bloated']);

/** A key label for an action id ("E"); the HUD passes game.keys.label. */
export type KeyLabel = (actionId: string) => string;

const HUNGER: Record<string, [Severity, string]> = {
  Engorged: [1, 'Overfull: you ate far more than you need. Eating more now is wasted and may make you sick.'],
  Sated: [0, ''],
  Hungry: [1, 'You could use a meal. Hunger slowly saps your strength and mood.'],
  'Very Hungry': [2, 'You are getting weak from hunger. Eat something soon.'],
  Famished: [3, 'Your body is burning its reserves. You are weaker and slower until you eat.'],
  Starving: [3, 'You are starving to death. Eat anything you can, now.'],
};

const THIRST: Record<string, [Severity, string]> = {
  '': [0, ''],
  Hydrated: [0, ''],
  Turgid: [0, ''],
  Thirsty: [1, 'You are thirsty. Thirst gets serious much faster than hunger.'],
  'Very Thirsty': [2, 'Very thirsty: your thinking and senses start to suffer.'],
  Dehydrated: [3, 'Dehydrated: you are losing health. Drink clean water as soon as you can.'],
  Parched: [3, 'Parched: you will die of thirst soon. Drink anything safe right now.'],
};

const FATIGUE: Record<string, [Severity, string]> = {
  '': [0, ''],
  Tired: [1, 'You are tired. It is fine for now, but plan somewhere safe to sleep.'],
  'Dead Tired': [2, 'Dead tired: you are clumsy and slow. Find a safe spot and sleep.'],
  Exhausted: [3, 'Exhausted: you may pass out where you stand. Sleep as soon as possible.'],
};

const TEMP: Record<string, [Severity, string, boolean]> = {
  Comfortable: [0, '', false],
  Chilly: [1, 'You are getting cold. Put on warmer clothes or get indoors.', true],
  'Very cold!': [2, 'Very cold: you are slowing down and your hands are clumsy. Warm up by a fire, indoors, or with more layers.', true],
  'Freezing!': [3, 'Freezing: frostbite and hypothermia will hurt you. Get warm immediately.', true],
  Warm: [1, 'You are warm. Take off a layer if you are sweating; heat makes you thirsty.', false],
  'Very hot!': [2, 'Very hot: you are overheating and dehydrating fast. Remove clothes, find shade, drink.', false],
  'Scorching!': [3, 'Scorching: heatstroke is hurting you. Strip layers and get out of the heat now.', false],
};

/** Every need, in HUD order, with severity and advice. */
export function needStates(p: NeedSource, key: KeyLabel): NeedState[] {
  const out: NeedState[] = [];
  const eat = `[${key('eat')}]`;
  const sleep = `[${key('sleep')}]`;
  const wear = `[${key('wear')}]`;

  const hs = p.hungerState();
  const [hl, htip] = HUNGER[hs] ?? [0, ''];
  const full = !!p.effects?.has('bloated');
  if (full && hl >= 2) {
    // Full stomach, empty reserves: say it once, as one state, and what to do about it.
    out.push({
      id: 'hunger', level: 1, label: `Full, still ${hs.toLowerCase()}`, title: `Hunger: ${hs}, but your stomach is full`,
      tip: `Your stomach is full right now, but your body's reserves are low (${hs.toLowerCase()}). A full stomach doesn't undo days of eating too little.`,
      advice: `Wait a few minutes for it to settle, then keep eating regular, filling meals (${eat}). Eating more right now may make you throw up.`,
    });
  } else {
    out.push({
      id: 'hunger', level: hl, label: hl ? hs : full ? 'Full' : '', title: `Hunger: ${hs || 'fine'}${full ? ' (stomach full)' : ''}`,
      tip: (htip || 'You are well fed.') + (full ? ' Your stomach is full for now: you ate or drank more than it holds at once.' : ''),
      advice: full ? 'Stop eating or drinking for a few minutes, or you may throw up.' : hs === 'Engorged' ? 'Stop eating for a while.' : hl ? `Eat food with ${eat} (Eat/drink), or from the inventory's right-click menu.` : '',
      good: hs === 'Sated' && !full,
    });
  }

  const th = p.thirstDescription();
  const [tl, ttip] = THIRST[th] ?? [0, ''];
  out.push({
    id: 'thirst', level: tl, label: tl ? th : '', title: `Thirst: ${th || 'fine'}`,
    tip: ttip || 'You are not thirsty.',
    advice: tl ? `Drink with ${eat}. Water from a tap, a toilet tank or bottled drinks is safe; boil anything from a river first.` : '',
    good: th === 'Hydrated' || th === 'Turgid',
  });

  const sl = p.sleepinessDescription();
  const [fl, ftip] = FATIGUE[sl] ?? [0, ''];
  out.push({
    id: 'fatigue', level: fl, label: fl ? sl : '', title: `Sleep: ${sl || 'rested'}`,
    tip: ftip || 'You are rested.',
    advice: fl ? `Sleep with ${sleep}. Lock yourself in a room first: sleeping in the open is dangerous.` : '',
  });

  const tp = p.bodyTempDescription();
  const [pl, ptip, cold] = TEMP[tp] ?? [1, `Body temperature: ${tp}.`, false];
  out.push({
    id: 'temperature', level: pl, label: pl ? tp.replace('!', '') : '', title: `Body temperature: ${tp}`,
    tip: ptip || 'Your body temperature is comfortable.',
    advice: pl ? (cold ? `Wear warmer clothes (${wear}), get out of the wind and rain, or sit by a fire.` : 'Take off a layer, stay out of the sun, drink water.') : '',
  });

  const pain = p.perceivedPain();
  const painLevel: Severity = pain <= 0 ? 0 : pain < 40 ? 1 : pain < 60 ? 2 : 3;
  out.push({
    id: 'pain', level: painLevel, label: painLevel ? p.painDescription().replace(/ pain$/, '') : '', title: `Pain: ${p.painDescription()}`,
    tip: painLevel ? 'Pain lowers your stats and speed. It fades as wounds heal.' : 'You feel no pain.',
    advice: painLevel ? 'Painkillers (aspirin, ibuprofen…) help; so does rest. Treat wounds with bandages first.' : '',
  });

  const m = p.morale.level();
  const ml: Severity = m <= -100 ? 3 : m <= -50 ? 2 : m <= -10 ? 1 : 0;
  out.push({
    id: 'morale', level: ml, good: m >= 10, label: ml ? (ml === 3 ? 'Despair' : ml === 2 ? 'Miserable' : 'Unhappy') : '',
    title: `Morale: ${m >= 50 ? 'great' : m >= 10 ? 'good' : m > -10 ? 'neutral' : m > -50 ? 'low' : 'very low'} (${m})`,
    tip: ml ? 'Low morale slows how fast you learn and focus; very low morale makes you give up on crafting and reading.' : m >= 10 ? 'Good morale helps you focus and learn.' : 'Your mood is steady.',
    advice: ml ? 'Eat something tasty, get warm and dry, rest, read something fun. Pain, hunger and wet clothes drag morale down.' : '',
  });

  const wt = p.inv.weightCarried(), cap = p.inv.weightCapacity();
  const over = cap > 0 ? wt / cap : 0;
  const wl: Severity = over > 1.5 ? 3 : over > 1.2 ? 2 : over > 1 ? 1 : 0;
  out.push({
    id: 'weight', level: wl, label: wl ? 'Overloaded' : '', title: `Carrying ${(wt / 1000).toFixed(1)} / ${(cap / 1000).toFixed(1)} kg`,
    tip: wl ? 'You carry more than you can: you tire quickly and move slowly.' : 'Your load is fine.',
    advice: wl ? `Drop or stash heavy things ([${key('drop')}]), or wear a better bag.` : '',
  });
  return out;
}

// ------------------------------------------------------------------ body

export type PartTone = 'good' | 'ok' | 'warn' | 'bad' | 'broken';

/** Colour class of a body part on the silhouette: full → green … low → red, 0 HP = broken. */
export function partTone(cur: number, max: number, broken: boolean): PartTone {
  if (broken || cur <= 0) return 'broken';
  const f = max > 0 ? cur / max : 0;
  if (f >= 0.95) return 'good';
  if (f >= 0.65) return 'ok';
  if (f >= 0.35) return 'warn';
  return 'bad';
}

// ------------------------------------------------------------------ compass

/** Compass bearing from (px, py) to (tx, ty): 0 = north (−y), clockwise, radians in [0, 2π). */
export function bearing(px: number, py: number, tx: number, ty: number): number {
  const a = Math.atan2(tx - px, -(ty - py));
  return a < 0 ? a + Math.PI * 2 : a;
}

/** Signed angle from the view direction (player yaw, same convention) to a bearing, in [−π, π). */
export function relativeAngle(b: number, yaw: number): number {
  let d = (b - yaw) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  if (d >= Math.PI) d -= Math.PI * 2;
  return d;
}

/**
 * Where a relative angle lands on a compass strip spanning `fov` radians: 0..1 across, or the
 * nearer edge (0 or 1) with `clamped` when it is behind/outside, so off-strip threats still
 * show at the edge they're closer to.
 */
export function stripPos(rel: number, fov: number): { x: number; clamped: boolean } {
  const x = rel / fov + 0.5;
  if (x < 0) return { x: 0, clamped: true };
  if (x > 1) return { x: 1, clamped: true };
  return { x, clamped: false };
}

export const CARDINALS: [string, number][] = [
  ['N', 0], ['NE', 45], ['E', 90], ['SE', 135], ['S', 180], ['SW', 225], ['W', 270], ['NW', 315],
];

// ------------------------------------------------------------------ danger

export type DangerLevel = 'safe' | 'aware' | 'near' | 'grabbed';

/** Hostiles you can see (distances in tiles, nearest first) → what the danger light says. */
export function dangerLevel(dists: number[], grabbed: boolean): DangerLevel {
  if (grabbed) return 'grabbed';
  if (!dists.length) return 'safe';
  return dists[0] <= 6 ? 'near' : 'aware';
}

// ------------------------------------------------------------------ messages

export type Tone = 'good' | 'bad' | 'warn' | 'info' | 'magic' | 'bright' | 'text' | 'dim';

/** CDDA message colour → a palette tone (the raw curses reds/greens are too harsh over 3D). */
export function messageTone(color: string | undefined): Tone {
  const n = (color ?? 'c_light_gray').replace(/^[cih]_/, '');
  if (/^(light_)?red|^red_/.test(n)) return 'bad';
  if (/^(light_)?green/.test(n)) return 'good';
  if (/^yellow|^brown/.test(n)) return 'warn';
  if (/^(light_)?(cyan|blue)/.test(n)) return 'info';
  if (/^(magenta|pink)/.test(n)) return 'magic';
  if (/^white/.test(n)) return 'bright';
  if (/^dark_gray/.test(n)) return 'dim';
  return 'text';
}

/** How opaque a feed line is `age` seconds after it last happened: readable 8 s, fades 6 s. */
export function feedAlpha(age: number, hold = 8, fade = 6): number {
  if (age < hold) return 1;
  return Math.max(0, 1 - (age - hold) / fade);
}

// ------------------------------------------------------------------ light

/** CDDA light units (vision.ts) → a word and a 0..4 meter for the HUD. */
export function lightLabel(lum: number): { label: string; bars: number; tip: string } {
  if (lum >= 50) return { label: 'Bright', bars: 4, tip: 'Broad daylight.' };
  if (lum >= 10) return { label: 'Lit', bars: 3, tip: 'Enough light to read and craft.' };
  if (lum >= 5) return { label: 'Dim', bars: 2, tip: 'Dim: too dark to read or craft well.' };
  if (lum > 3.5) return { label: 'Dark', bars: 1, tip: 'Dark: you can barely see. A flashlight helps (and makes you visible).' };
  return { label: 'Pitch black', bars: 0, tip: 'Pitch black: you cannot see. Use a light source.' };
}
