// Ties the reading minigame (session.ts) to a reading activity: one session per reading run
// (it carries on across chapters of "read until you gain a level"), rewards for right
// answers / skim hits, the "You know this. Skim it?" offer, and the rules for when the game
// waits:
//
//  * fast-forward (Game.simSpeed > 1, src/game/timewarp.ts): the quiz *pauses* — no new
//    question, the clocks stop, the card says so. Fast-forward is "get this over with"; the
//    quiz is the other way through a book faster, and a jump worth 2.5 s at ×1 would be worth
//    a fraction of a second at ×8. A question already up waits with it (hidden, not
//    answerable), and is there again the moment you're back at ×1. The jump itself is game
//    time (skipReading), so it would mean the same at any speed — pausing is about attention,
//    not arithmetic. Documented in docs/ADAPTATION.md.
//  * the game paused (tactical pause, a menu that stops time): clocks stop too, so a cooldown
//    can't be waited out at zero cost; a question already up can still be answered.
//  * the reading stops (moved, a zombie in view, hurt): the session ends with it.
//
// No DOM: src/ui/readquiz.ts draws it and forwards keys/clicks.

import { Rng, hashString } from '../../core/rng';
import { clockScale } from '../../core/time';
import type { CraftHost } from '../crafting';
import type { Item } from '../item';
import { bookData, reading, readingPractice, skipReading, teachableRecipes, type ReadingState } from '../reading';
import { bookHasQuiz } from './questions';
import { QuizSession, SkimSession, TUNING, type ReadingGame } from './session';

export interface QuizHost extends CraftHost {
  /** Fast-forward speed (Game.simSpeed); absent = 1. */
  simSpeed?: number;
}

/** Nothing left to gain from it: offer to skim it instead of reading the chapter. */
export function knowsBook(host: CraftHost, it: Item): boolean {
  const c = host.player;
  const b = bookData(it);
  if (!b) return false;
  if (b.skill) return c.getSkill(b.skill) >= Math.min(b.level, 10);
  // A recipe-only book whose recipes you've all memorised.
  return !it.def.martial_art && bookHasQuiz(host.data, it.typeId) && teachableRecipes(c, it).length === 0;
}

/** What the last reward did, for the card's "+12 min" flash. */
export interface Reward {
  skippedS: number;
  practice: number;
  at: number;
}

export class ReadQuizController {
  quiz: QuizSession | null = null;
  skim: SkimSession | null = null;
  /** Which reading run the session belongs to. */
  private forRun: ReadingState | null = null;
  lastReward: Reward | null = null;
  /** Real ms since the controller started (for the reward flash). */
  now = 0;
  /** Why the game is waiting right now ('fast' / 'paused'), or null. */
  frozen: 'fast' | 'paused' | null = null;
  readonly totals = { right: 0, wrong: 0, hits: 0, misses: 0, skippedS: 0, skims: 0 };

  constructor(
    private host: QuizHost,
    private mode: () => ReadingGame,
    private seed = 1,
  ) {}

  /** The reading activity now, if any. */
  private readingNow(): { st: ReadingState; book: Item } | null {
    const st = reading.current;
    const a = this.host.activities.current;
    if (!st || !a || a.spec.kind !== 'read' || a.spec.target !== st.book) return null;
    return { st, book: st.book };
  }

  /** Per frame, real milliseconds. `paused`: the game isn't running time (tactical pause, menu). */
  update(dtMs: number, paused = false): void {
    this.now += dtMs;
    const r = this.readingNow();
    const mode = this.mode();
    if (!r || mode === 'off' || !bookHasQuiz(this.host.data, r.book.typeId)) {
      // A chapter boundary in a reading run: the next chapter starts in the same tick, so the
      // run (reading.current) outlives the activity gap; only a cancelled run ends the session.
      if (!reading.current || mode === 'off') this.end();
      return;
    }
    if (r.st !== this.forRun || (mode === 'quiz' && !this.quiz) || (mode === 'skim' && !this.skim)) this.begin(r.st, r.book, mode);
    this.frozen = (this.host.simSpeed ?? 1) > 1 ? 'fast' : paused ? 'paused' : null;
    if (this.frozen) return;
    this.quiz?.tick(dtMs);
    this.skim?.tick(dtMs);
  }

  private begin(st: ReadingState, book: Item, mode: ReadingGame): void {
    this.end();
    this.forRun = st;
    const rng = new Rng(hashString(book.typeId) ^ (this.seed * 2654435761));
    this.seed++;
    const offer = knowsBook(this.host, book);
    if (mode === 'quiz') this.quiz = new QuizSession(this.host.data, book.typeId, rng, offer);
    else {
      this.skim = new SkimSession(this.host.data, book.typeId, rng);
      // The skim game has no question card to put the offer on: the quiz session holds it.
      if (offer) this.quiz = new QuizSession(this.host.data, book.typeId, rng, true);
    }
  }

  end(): void {
    this.quiz = null;
    this.skim = null;
    this.forRun = null;
    this.frozen = null;
  }

  /** Real seconds at ×1 → game seconds of this chapter (the activity's own clock warp). */
  private realToGame(realS: number): number {
    const a = this.host.activities.current!;
    const warp = this.host.clock.warp || 1;
    return Math.min(realS * clockScale() * warp, a.spec.duration * TUNING.skipMaxFrac);
  }

  private reward(book: Item, realS: number): Reward {
    const skippedS = skipReading(this.host, this.realToGame(realS));
    const c = this.host.player;
    const b = bookData(book);
    const practice = b?.skill ? readingPractice(c, book, TUNING.practice * (c.getSkill(b.skill) + 1)) : 0;
    this.totals.skippedS += skippedS;
    return (this.lastReward = { skippedS, practice, at: this.now });
  }

  /** Answer the current question (0-based option), or accept/decline the skim offer (0 = skim, 1 = read). */
  answer(i: number): 'right' | 'wrong' | 'skim' | 'read' | null {
    const r = this.readingNow();
    const q = this.quiz;
    if (!r || !q) return null;
    if (q.phase === 'offer') {
      if (i === 0) {
        q.resolveOffer(true);
        this.skimKnown();
        return 'skim';
      }
      if (i === 1) {
        q.resolveOffer(false);
        // In the skim game the offer was all the quiz session was for.
        if (this.skim) this.quiz = null;
        return 'read';
      }
      return null;
    }
    // Fast-forwarding: the question is hidden and waits for ×1 (see the header).
    if (this.frozen === 'fast') return null;
    const v = q.answer(i);
    if (v === 'right') {
      this.totals.right++;
      this.reward(r.book, TUNING.skipRealS);
    } else if (v === 'wrong') this.totals.wrong++;
    return v;
  }

  /**
   * "You know this. Skim it?" — yes: the chapter ends now and resolves as BN's would (recipes
   * memorised, the book's morale, no skill: you're past what it teaches), and the run stops.
   */
  skimKnown(): void {
    const r = this.readingNow();
    if (!r) return;
    r.st.mode = 'once';
    this.totals.skims++;
    const a = this.host.activities.current!;
    skipReading(this.host, a.spec.duration - a.elapsed);
  }

  /** Skim game: grab what's in the lens (key 1). */
  press(): 'hit' | 'miss' | null {
    const r = this.readingNow();
    if (!r || !this.skim || this.quiz?.phase === 'offer' || this.frozen === 'fast') return null;
    const v = this.skim.press();
    this.afterSkim(r.book, v);
    return v;
  }

  /** Skim game: a click on word `index` of the strip. */
  clickWord(index: number): 'hit' | 'miss' | null {
    const r = this.readingNow();
    const w = this.skim?.words[index];
    if (!r || !this.skim || !w || this.quiz?.phase === 'offer' || this.frozen === 'fast') return null;
    const v = this.skim.click(w);
    this.afterSkim(r.book, v);
    return v;
  }

  private afterSkim(book: Item, v: 'hit' | 'miss' | null): void {
    if (v === 'hit') {
      this.totals.hits++;
      this.reward(book, TUNING.skimSkipRealS);
    } else if (v === 'miss') this.totals.misses++;
  }

  /** Is the card interactive right now (keys 1–4 / clicks mean something)? */
  live(): boolean {
    if (!this.readingNow()) return false;
    if (this.quiz?.phase === 'offer') return true;
    if (this.frozen === 'fast') return false;
    if (this.skim) return true;
    return this.quiz?.phase === 'ask';
  }
}
