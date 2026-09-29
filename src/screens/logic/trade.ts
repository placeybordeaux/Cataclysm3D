// Pure rules for the trade screen (unit-tested): the balance meter and the NPC's reaction to
// the current offer. The deal itself is TradeSession (src/game/trade.ts): the screen only sets
// counts on its entries and calls commit(), which moves everything inside one transaction.

import type { Tone } from '../../ui2';

export interface BalanceMeter {
  /** -1..1: where the needle sits (0 = even). Positive: the NPC gets more than it gives. */
  needle: number;
  /** -1..0: how far left the NPC's credit reaches (the green zone extends to here). */
  creditEdge: number;
  tone: Tone;
  /** One line under the bar. */
  text: string;
  acceptable: boolean;
}

/** "$12.50". */
export function money(cents: number): string {
  return `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`;
}

/**
 * The balance bar: `balance` is what the NPC will owe you after the deal (negative: you owe
 * them), `credit` how much they'd let you owe (Infinity for followers). The scale grows with
 * the deal's size so a $2 difference on a $500 trade doesn't pin the needle.
 */
export function balanceMeter(balance: number, credit: number, dealSize: number, npcName: string): BalanceMeter {
  const scale = Math.max(1000, dealSize, Math.abs(balance), Number.isFinite(credit) ? credit : 0);
  const needle = Math.max(-1, Math.min(1, balance / scale));
  const creditEdge = Number.isFinite(credit) ? -Math.min(1, credit / scale) : -1;
  const acceptable = balance + credit >= 0;
  if (!Number.isFinite(credit)) return { needle, creditEdge, tone: 'good', acceptable: true, text: `${npcName} is with you: take what you need.` };
  if (balance > 0) return { needle, creditEdge, tone: 'good', acceptable, text: `${npcName} will owe you ${money(balance)}.` };
  if (balance === 0) return { needle, creditEdge, tone: 'good', acceptable, text: 'An even trade.' };
  if (acceptable) return { needle, creditEdge, tone: 'warn', acceptable, text: `You will owe ${npcName} ${money(-balance)} (on credit).` };
  return { needle, creditEdge, tone: 'bad', acceptable, text: `${money(-balance - credit)} short of a deal ${npcName} will take.` };
}

export type Mood = 'waiting' | 'pleased' | 'fair' | 'reluctant' | 'refuses';

/**
 * What the NPC says about the offer as it changes (BN has no such barks; these read like its
 * trade lines: "…thinks you're getting the better end of this deal").
 */
export function reaction(empty: boolean, balance: number, credit: number, npcName: string): { mood: Mood; line: string; tone: Tone } {
  if (empty) return { mood: 'waiting', line: `${npcName} waits for your offer.`, tone: 'dim' };
  if (!Number.isFinite(credit)) return { mood: 'pleased', line: `"Sure, take it."`, tone: 'good' };
  if (balance + credit < 0) return { mood: 'refuses', line: `${npcName} thinks you're getting the better end of this deal.`, tone: 'bad' };
  if (balance < 0) return { mood: 'reluctant', line: `"I'll put the rest on your tab. Don't make me regret it."`, tone: 'warn' };
  if (balance > 0) return { mood: 'pleased', line: `"That's generous. I'll remember it."`, tone: 'good' };
  return { mood: 'fair', line: `"Fair's fair."`, tone: 'good' };
}
