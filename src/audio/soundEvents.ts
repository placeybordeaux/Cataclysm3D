// Map world `sound` events (CDDA sounds::sound: position, loudness, description, optional
// sfx id/variant) to a sound effect. Events that carry an sfx id use it verbatim, like CDDA;
// otherwise the description is matched against keyword rules (CDDA descriptions are
// onomatopoeia such as "Smash!", "a loud crash!", "whump!", "a scream").

export interface SoundEventLike {
  volume: number;
  description: string;
  sfxId?: string;
  sfxVariant?: string;
}

export interface EventSound {
  id: string;
  variant: string;
}

interface Rule {
  re: RegExp;
  minVolume?: number;
  sound: EventSound | ((volume: number) => EventSound);
}

// Order matters: first match wins.
const RULES: Rule[] = [
  { re: /glass|shatter|tinkle/i, sound: { id: 'smash', variant: 'glass' } },
  { re: /explo|kaboom|\bboom\b|kerblam/i, sound: (v) => ({ id: 'explosion', variant: v >= 90 ? 'huge' : v >= 40 ? 'default' : 'small' }) },
  { re: /gunshot|gunfire|\bbang\b|blam|crack-crack|rat-a-tat/i, minVolume: 30, sound: { id: 'fire_gun', variant: 'default' } },
  { re: /alarm|siren|beep-beep|wail/i, sound: { id: 'environment', variant: 'alarm' } },
  { re: /church bell|bells? ring/i, sound: { id: 'environment', variant: 'church_bells' } },
  { re: /\bgroan|\bmoan|\bgrowl(?!s? of)|\bhiss\b|\bshriek|\bhowl/i, sound: { id: 'speech', variant: 'mon_zombie' } },
  { re: /smash|crash|crunch|crack!|splinter|\bsnap\b|wham|clang/i, sound: { id: 'smash_success', variant: 'default' } },
  { re: /thump|whump|thud|\bbash|\bbonk|knock/i, sound: { id: 'smash_fail', variant: 'default' } },
  { re: /footstep|shuffl|scrap(e|ing)|rustl/i, sound: { id: 'synth_monster_step', variant: 'default' } },
  { re: /door (open|creak)|creak/i, sound: { id: 'open_door', variant: 't_door_c' } },
  { re: /door (clos|slam)|slam/i, sound: { id: 'close_door', variant: 't_door_o' } },
  { re: /electric|\bhum(ming)?\b|buzz/i, sound: { id: 'humming', variant: 'electric' } },
  { re: /machine|motor|whirr/i, sound: { id: 'humming', variant: 'machinery' } },
  { re: /static|radio/i, sound: { id: 'radio', variant: 'static' } },
  { re: /fire|crackl/i, sound: { id: 'fire', variant: 'ignition' } },
];

/** null = nothing obvious; stay silent rather than guess (the message log still shows it). */
export function soundForEvent(e: SoundEventLike): EventSound | null {
  if (e.sfxId !== undefined) return e.sfxId ? { id: e.sfxId, variant: e.sfxVariant ?? 'default' } : null;
  for (const r of RULES) {
    if (!r.re.test(e.description)) continue;
    if (r.minVolume !== undefined && e.volume < r.minVolume) continue;
    return typeof r.sound === 'function' ? r.sound(e.volume) : r.sound;
  }
  return null;
}
