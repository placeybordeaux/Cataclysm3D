// Pure presentation rules for the dialogue panel (unit-tested): how a response reads (odds,
// what the roll uses, why it's unavailable), which key picks it, and how the NPC feels about
// you in words instead of CDDA's raw opinion numbers.

import type { ResponseView, TrialView } from '../../game/talk';
import type { Tone } from '../../ui2';

/** Keys 1…9 then 0 pick the first ten responses; the rest are mouse/arrow only. */
export const RESPONSE_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const;

export function responseKey(i: number): string | undefined {
  return RESPONSE_KEYS[i];
}

/** Index for a pressed key, or -1. Only digits: letters stay free for the window's own keys. */
export function keyToResponse(key: string, count: number): number {
  const i = (RESPONSE_KEYS as readonly string[]).indexOf(key);
  return i >= 0 && i < count ? i : -1;
}

/** Green when it's likely, amber when it's a gamble, red when it's a long shot. */
export function oddsTone(chance: number): Tone {
  return chance >= 75 ? 'good' : chance >= 40 ? 'warn' : 'bad';
}

const TRIAL_NAME: Record<TrialView['kind'], string> = {
  PERSUADE: 'Persuade', LIE: 'Lie', INTIMIDATE: 'Intimidate', SKILL_CHECK: 'Skill', CONDITION: 'Check',
};

export interface ResponseChip {
  /** "Persuade 45%" / "Mechanics 2/4". */
  label: string;
  tone: Tone;
  /** Tooltip: what the roll uses and what it means. */
  detail: string;
}

/** The odds chip shown next to a trial response, or null for plain responses. */
export function trialChip(t: TrialView | undefined): ResponseChip | null {
  if (!t) return null;
  if (t.kind === 'SKILL_CHECK') {
    const ok = (t.have ?? 0) >= (t.need ?? 0);
    return {
      label: `${t.skill ?? 'Skill'} ${Math.min(t.have ?? 0, t.need ?? 0)}/${t.need ?? 0}`,
      tone: ok ? 'good' : 'bad',
      detail: ok ? `Your ${t.skill} is high enough: this always works.` : `Needs ${t.skill} ${t.need}; you have ${t.have}. It will fail.`,
    };
  }
  if (t.kind === 'CONDITION') return { label: t.chance >= 100 ? 'Will work' : 'Will fail', tone: t.chance >= 100 ? 'good' : 'bad', detail: 'Depends on the situation, not a roll.' };
  return {
    label: `${TRIAL_NAME[t.kind]} ${t.chance}%`,
    tone: oddsTone(t.chance),
    detail: `${t.chance}% chance to succeed. Uses ${t.uses}${t.kind === 'INTIMIDATE' ? '' : ', and how much they trust you'}.${t.kind === 'LIE' ? ' Getting caught hurts their trust.' : ''}`,
  };
}

/** Result line for the history after a trial response. */
export function trialOutcome(kind: string, chance: number, success: boolean): { text: string; tone: Tone } {
  const name = (TRIAL_NAME as Record<string, string>)[kind] ?? kind;
  return { text: `${name} ${success ? 'succeeded' : 'failed'} (${chance}% chance)`, tone: success ? 'good' : 'bad' };
}

export interface ResponseRow {
  key?: string;
  text: string;
  chip: ResponseChip | null;
  /** Greyed, with the reason it can't be picked (or picking it just gets turned down). */
  unavailable?: string;
  /** Shown only because "show unavailable" is on. */
  hidden: boolean;
  tone: Tone | undefined;
  action?: ResponseView['action'];
}

/**
 * One response for the panel. Unavailable ones keep their reason (BN failure_explanation /
 * show_reason, else a generic line) instead of the "*reason: text" prefix of the curses UI.
 */
export function responseRow(r: ResponseView, i: number): ResponseRow {
  const text = stripTags(r.plain ?? r.text);
  const tone: Tone | undefined = r.color === 'c_red' ? 'bad' : r.color === 'c_green' ? 'good' : r.color === 'c_light_red' ? 'warn' : undefined;
  return {
    key: responseKey(i),
    text,
    chip: trialChip(r.trial),
    unavailable: r.available ? undefined : r.reason ?? (r.hidden ? 'Not possible right now.' : 'Not available.'),
    hidden: !!r.hidden,
    tone,
    action: r.action,
  };
}

/** CDDA colour tags ("<color_red>…</color>") out: the panel colours by meaning instead. */
export function stripTags(s: string): string {
  return s.replace(/<\/?color[^>]*>/g, '');
}

export interface Opinion {
  trust: number;
  fear: number;
  value: number;
  anger: number;
  owed: number;
}

/**
 * How the NPC regards you, in a word and a tone (npc_opinion, summarised): anger dominates,
 * then trust vs fear. Raw numbers stay available in the tooltip for veterans.
 */
export function opinionWord(op: Opinion, hostile: boolean, ally: boolean): { word: string; tone: Tone } {
  if (hostile) return { word: 'Hostile', tone: 'bad' };
  if (ally) return { word: op.trust >= 5 ? 'Loyal' : 'Follower', tone: 'good' };
  if (op.anger >= 5) return { word: 'Angry', tone: 'bad' };
  if (op.fear >= 5 && op.fear > op.trust) return { word: 'Afraid', tone: 'warn' };
  if (op.trust >= 5 || op.value >= 5) return { word: 'Friendly', tone: 'good' };
  if (op.trust <= -3 || op.anger >= 2) return { word: 'Wary', tone: 'warn' };
  return { word: 'Neutral', tone: 'dim' };
}
