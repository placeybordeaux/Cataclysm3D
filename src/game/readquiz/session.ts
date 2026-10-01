// The reading minigame's state machines, real-time and DOM-free (docs/ADAPTATION.md "Reading:
// field notes"). Two games, picked by Options > Reading / ?reading=:
//
//   quiz  a "field notes" question every few seconds (questions.ts); a right answer skips some
//         reading, a wrong one shows the right answer and waits a few seconds before the next.
//   skim  key terms from the book drift through a strip with the filler text; catch one in the
//         lens (1 or a click) to skip some reading; grabbing filler loses your place briefly.
//
// Either way reading carries on underneath at its normal pace: ignoring the card costs nothing.
// The controller (controller.ts) feeds these real milliseconds, turns their verdicts into
// rewards and freezes them while the game is paused or fast-forwarding.

import type { Rng } from '../../core/rng';
import type { GameData } from '../../data/types';
import { nextQuestion, questionKey, tierFor, type Question } from './questions';
import { bookRecipeIndex, recipeName } from '../crafting';
import { cddaText } from '../units';

export type ReadingGame = 'quiz' | 'skim' | 'off';
export const READING_GAMES: ReadingGame[] = ['quiz', 'skim', 'off'];

/**
 * Tuning. A chapter takes 2–8 real seconds at ×1 (activity.ts defaultWarp) and leveling a
 * skill from a book takes tens of chapters, so the quiz is tuned against whole reading runs:
 * a good player (right answers ~2 s after each question appears) reads about twice as fast
 * (tests/readquiz.test.ts measures it), a careless one barely faster, never slower.
 */
export const TUNING = {
  /** First question after you start reading (time to settle in). */
  leadMs: 1500,
  /** After a right answer: the card says "+12 min" this long, then the next question. */
  rightShowMs: 1100,
  /** After a wrong answer the right one stays marked this long (you learned it)… */
  wrongShowMs: 2600,
  /** …and the next question comes no sooner than this after the wrong answer. */
  cooldownMs: 5000,
  /** A right answer skips the reading that would take this many real seconds at ×1. */
  skipRealS: 2.5,
  /** …but never more than this share of one chapter at once. */
  skipMaxFrac: 0.6,
  /** Practice per right answer, BN exercise points × (skill level + 1); see readingPractice. */
  practice: 1,
  /** Skim: strip speed in characters per second by tier (beginner, mid, advanced books). */
  skimSpeed: [5.5, 7, 8.5],
  /** Skim: half-width of the lens in characters. */
  skimLens: 4,
  /** Skim: a hit skips this many real seconds of reading at ×1. */
  skimSkipRealS: 2.5,
  /** Skim: grabbing filler blanks the strip this long. */
  skimCooldownMs: 3000,
  /** Skim: filler words between key terms. */
  skimGap: [3, 6] as [number, number],
};

// ------------------------------------------------------------------ quiz

export type QuizPhase = 'offer' | 'wait' | 'ask' | 'right' | 'wrong' | 'done';

export class QuizSession {
  phase: QuizPhase;
  question: Question | null = null;
  /** The option the player picked last (for the right/wrong colours). */
  picked = -1;
  /** Milliseconds spent in the current phase (only counts while not frozen). */
  t = 0;
  /** How long the current 'wait' lasts. */
  waitMs: number;
  readonly stats = { right: 0, wrong: 0, asked: 0 };
  private recent: string[] = [];

  constructor(
    readonly data: GameData,
    readonly bookId: string,
    private rng: Rng,
    /** "You know this. Skim it?" first (the reader has nothing left to learn from it). */
    offerSkim = false,
  ) {
    this.phase = offerSkim ? 'offer' : 'wait';
    this.waitMs = TUNING.leadMs;
  }

  /** Advance the clocks; returns true when a new question appeared. */
  tick(dtMs: number): boolean {
    if (!(dtMs >= 0)) throw new Error(`QuizSession.tick: bad dt ${dtMs}`);
    if (this.phase === 'offer' || this.phase === 'done' || this.phase === 'ask') {
      this.t += dtMs;
      return false;
    }
    this.t += dtMs;
    if (this.phase === 'right' && this.t >= TUNING.rightShowMs) this.toWait(0);
    else if (this.phase === 'wrong' && this.t >= TUNING.wrongShowMs) this.toWait(TUNING.cooldownMs - TUNING.wrongShowMs);
    if (this.phase === 'wait' && this.t >= this.waitMs) return this.ask();
    return false;
  }

  private toWait(ms: number): void {
    this.phase = 'wait';
    this.t = 0;
    this.waitMs = ms;
    this.question = null;
    this.picked = -1;
  }

  private ask(): boolean {
    const q = nextQuestion(this.data, this.bookId, this.rng, new Set(this.recent));
    if (!q) {
      this.phase = 'done';
      return false;
    }
    this.question = q;
    this.recent.push(questionKey(q));
    if (this.recent.length > 8) this.recent.shift();
    this.phase = 'ask';
    this.t = 0;
    this.picked = -1;
    this.stats.asked++;
    return true;
  }

  /** Pick option `i` (0-based). Null when no question is up or `i` is out of range. */
  answer(i: number): 'right' | 'wrong' | null {
    const q = this.question;
    if (this.phase !== 'ask' || !q || !(i >= 0 && i < q.options.length)) return null;
    this.picked = i;
    this.t = 0;
    if (i === q.answer) {
      this.phase = 'right';
      this.stats.right++;
      return 'right';
    }
    this.phase = 'wrong';
    this.stats.wrong++;
    return 'wrong';
  }

  /** The "You know this" offer: accept (the controller finishes the chapter) or read on with questions. */
  resolveOffer(skim: boolean): void {
    if (this.phase !== 'offer') return;
    if (skim) this.phase = 'done';
    else this.toWait(TUNING.leadMs);
  }

  /** Seconds until the next question (for "next note in 3 s"), or 0. */
  nextInMs(): number {
    if (this.phase === 'wait') return Math.max(0, this.waitMs - this.t);
    if (this.phase === 'wrong') return Math.max(0, TUNING.cooldownMs - this.t);
    if (this.phase === 'right') return Math.max(0, TUNING.rightShowMs - this.t);
    return 0;
  }
}

// ------------------------------------------------------------------ skim

export interface SkimWord {
  text: string;
  key: boolean;
  /** Left edge, in characters along the stream. */
  x: number;
  hit: boolean;
  /** Grabbed by mistake (filler) — drawn struck out. */
  wrong: boolean;
}

const FILLER = [
  'the', 'and', 'then', 'with', 'a', 'little', 'care', 'you', 'can', 'usually', 'which', 'is', 'why', 'most', 'people', 'first', 'should', 'always',
  'keep', 'it', 'in', 'mind', 'that', 'some', 'of', 'these', 'are', 'not', 'what', 'they', 'seem', 'so', 'take', 'your', 'time', 'here', 'next',
  'chapter', 'figure', 'see', 'also', 'note', 'carefully', 'before', 'after', 'during', 'simple', 'basic', 'common', 'mistake', 'step',
];

/** The book's key terms: names of what it teaches (recipes), else answers to its questions. */
export function skimTerms(data: GameData, bookId: string, rng: Rng): string[] {
  const out = new Set<string>();
  for (const br of bookRecipeIndex(data).get(bookId) ?? []) out.add(recipeName(data, br.recipe));
  for (let i = 0; out.size < 12 && i < 30; i++) {
    const q = nextQuestion(data, bookId, rng);
    if (!q) break;
    out.add(q.options[q.answer]);
  }
  return [...out].map((t) => t.toLowerCase()).filter((t) => t.length <= 28);
}

export class SkimSession {
  /** Stream offset: characters scrolled past so far. */
  off = 0;
  words: SkimWord[] = [];
  /** Remaining cooldown after grabbing filler. */
  cooldownMs = 0;
  /** Milliseconds since the last hit (for the "+N min" flash). */
  sinceHitMs = Infinity;
  readonly speed: number;
  readonly stats = { hits: 0, misses: 0, passed: 0 };
  private end = 0;
  private gap = 0;
  private filler: string[];

  constructor(
    data: GameData,
    bookId: string,
    private rng: Rng,
    readonly terms: string[] = skimTerms(data, bookId, rng),
    /** Characters visible in the strip; the lens is in the middle. */
    readonly width = 44,
  ) {
    if (!terms.length) throw new Error(`SkimSession: no key terms for ${bookId}`);
    const tier = tierFor(data.items[bookId]);
    this.speed = TUNING.skimSpeed[tier.options === 3 ? 0 : tier.familiar ? 1 : 2];
    const desc = cddaText(data.items[bookId].description).toLowerCase().replace(/[^a-z' -]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && w.length < 12);
    this.filler = [...FILLER, ...desc];
    // Start with an empty stretch: the first term arrives after a moment, not under the lens.
    this.end = width * 0.8;
    this.gap = rng.int(1, 2);
    this.fill();
  }

  get lens(): [number, number] {
    const c = this.off + this.width / 2;
    return [c - TUNING.skimLens, c + TUNING.skimLens];
  }

  private fill(): void {
    while (this.end < this.off + this.width + 20) {
      const key = this.gap <= 0;
      const text = key ? this.rng.pick(this.terms) : this.rng.pick(this.filler);
      this.words.push({ text, key, x: this.end, hit: false, wrong: false });
      this.end += text.length + 2;
      this.gap = key ? this.rng.int(TUNING.skimGap[0], TUNING.skimGap[1]) : this.gap - 1;
    }
  }

  tick(dtMs: number): void {
    if (!(dtMs >= 0)) throw new Error(`SkimSession.tick: bad dt ${dtMs}`);
    this.off += (this.speed * dtMs) / 1000;
    this.cooldownMs = Math.max(0, this.cooldownMs - dtMs);
    this.sinceHitMs += dtMs;
    while (this.words.length && this.words[0].x + this.words[0].text.length < this.off - 2) {
      const w = this.words.shift()!;
      if (w.key && !w.hit) this.stats.passed++;
    }
    this.fill();
  }

  /** The word under the lens (overlapping it), key terms first. */
  inLens(): SkimWord | null {
    const [a, b] = this.lens;
    const over = this.words.filter((w) => w.x < b && w.x + w.text.length > a);
    return over.find((w) => w.key && !w.hit) ?? over[0] ?? null;
  }

  /** Grab what's in the lens (key 1). */
  press(): 'hit' | 'miss' | null {
    if (this.cooldownMs > 0) return null;
    const w = this.inLens();
    return this.grab(w && w.key && !w.hit ? w : null, w);
  }

  /** Click a word in the strip directly (free cursor): any visible key term counts. */
  click(w: SkimWord): 'hit' | 'miss' | null {
    if (this.cooldownMs > 0 || !this.words.includes(w) || w.hit) return null;
    const visible = w.x + w.text.length > this.off && w.x < this.off + this.width;
    if (!visible) return null;
    return this.grab(w.key ? w : null, w);
  }

  private grab(hit: SkimWord | null, at: SkimWord | null): 'hit' | 'miss' {
    if (hit) {
      hit.hit = true;
      this.stats.hits++;
      this.sinceHitMs = 0;
      return 'hit';
    }
    if (at) at.wrong = true;
    this.stats.misses++;
    this.cooldownMs = TUNING.skimCooldownMs;
    return 'miss';
  }
}
