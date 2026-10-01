import { blockedText, exerciseForLevel, implicitSource, type PracticeBlock, type PracticeEvent } from '../game/practice';

// The practice cue's state (pure, unit-tested; src/ui/practice_cue.ts draws it): practice events
// folded into at most two small cards, one per source ("Disassembling the toaster"), one row per
// skill. Not spammy: a fight's dozens of swings are one "Fighting" card whose rows grow; a
// blocked practice only shows when the player chose the action (a named source) — a zombie
// swing that teaches nothing says nothing — and a gain in the same card replaces it.

export interface CueRow {
  skill: string;
  name: string;
  /** Share of a level gained in this card, summed (0.08 = 8 %). */
  share: number;
  level: number;
  /** Progress toward level+1 now, 0..1. */
  progress: number;
  levelUp: boolean;
  blocked: PracticeBlock | null;
  /** Why nothing was gained (blocked rows). */
  reason: string;
}

export interface CueCard {
  key: string;
  title: string;
  rows: CueRow[];
  /** performance.now() of the last event. */
  updated: number;
}

/** ms a card stays after its last event. */
export const CUE_LINGER = 4500;
/** ms a card with only "no practice" rows stays (it's the one that needs reading). */
export const CUE_LINGER_BLOCKED = 6500;
const MAX_CARDS = 2;

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export class PracticeFeed {
  cards: CueCard[] = [];
  /** Bumped on every change (the DOM redraws on change only). */
  version = 0;

  push(e: PracticeEvent, now: number, skillName: (id: string) => string = (s) => s): void {
    if (e.blocked === 'max' || e.blocked === 'asleep') return;
    if (e.blocked && !e.explicit) return;
    const title = cap1(e.source ?? implicitSource(e.skill));
    let card = this.cards.find((c) => c.key === title);
    if (!card) {
      card = { key: title, title, rows: [], updated: now };
      this.cards.unshift(card);
      if (this.cards.length > MAX_CARDS) this.cards.length = MAX_CARDS;
    } else if (this.cards[0] !== card) {
      this.cards.splice(this.cards.indexOf(card), 1);
      this.cards.unshift(card);
    }
    card.updated = now;
    const name = skillName(e.skill);
    let row = card.rows.find((r) => r.skill === e.skill);
    if (!row) card.rows.push((row = { skill: e.skill, name, share: 0, level: e.level, progress: e.progress, levelUp: false, blocked: null, reason: '' }));
    if (e.blocked) {
      // A gain already shown in this card wins: one rolled-down step doesn't turn it into "no practice".
      if (row.share > 0 || row.levelUp) return void this.version++;
      row.blocked = e.blocked;
      row.reason = blockedText(e, name);
    } else {
      row.blocked = null;
      row.reason = '';
      row.share += e.gained / exerciseForLevel(e.levelBefore);
      row.levelUp ||= e.levelUp;
    }
    row.level = e.level;
    row.progress = e.progress;
    this.version++;
  }

  /** Drop cards past their linger time; true if anything changed. */
  tick(now: number): boolean {
    const keep = this.cards.filter((c) => now - c.updated < (c.rows.every((r) => r.blocked) ? CUE_LINGER_BLOCKED : CUE_LINGER));
    if (keep.length === this.cards.length) return false;
    this.cards = keep;
    this.version++;
    return true;
  }
}

/** "+8%", "<1%", "level 2!" for a gain row; the reason for a blocked one. */
export function rowText(r: CueRow): string {
  if (r.blocked) return r.reason;
  if (r.levelUp) return `${r.name} reached level ${r.level}!`;
  const pct = r.share * 100;
  const prog = r.progress > 0 && r.progress < 0.01 ? '<1' : String(Math.floor(r.progress * 100));
  return `${r.name} +${pct >= 1 ? Math.round(pct) : '<1'}% · ${prog}% to level ${r.level + 1}`;
}
