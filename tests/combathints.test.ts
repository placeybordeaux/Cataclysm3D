import { describe, expect, it } from 'vitest';
import { HintRules, MAX_SHOWS } from '../src/ui/combatHints';
import { NUDGES } from '../src/progression/discovery';

// First-fight onboarding (src/ui/combatHints.ts): short crosshair lines, a few times only.

describe('combat hint rules', () => {
  it('a hint shows at most MAX_SHOWS times, never twice within the gap, one at a time', () => {
    const saved: unknown[] = [];
    const r = new HintRules(undefined, (s) => saved.push(JSON.parse(JSON.stringify(s))));
    expect(r.show('aim_sway', 0)).toBe(true);
    expect(r.text(1)?.text).toMatch(/sways/);
    expect(r.show('melee_guard', 1)).toBe(false); // one at a time
    expect(r.text(4)).toBeNull();
    expect(r.show('aim_sway', 10)).toBe(false); // the gap
    expect(r.show('aim_sway', 30)).toBe(true);
    expect(r.show('aim_sway', 60)).toBe(true);
    expect(r.show('aim_sway', 90)).toBe(false); // MAX_SHOWS
    expect(r.state.shown.aim_sway).toBe(MAX_SHOWS);
    expect(saved.length).toBe(MAX_SHOWS);
  });

  it('once learned it never shows again, and a showing one goes away', () => {
    const r = new HintRules();
    expect(r.show('aim_headshot', 0)).toBe(true);
    r.learn('aim_headshot');
    expect(r.text(0.5)).toBeNull();
    expect(r.show('aim_headshot', 100)).toBe(false);
  });

  it('the journal has the longer text for each lesson', () => {
    for (const id of ['aim_sway', 'aim_headshot', 'melee_guard']) expect(NUDGES[id]?.journal.length).toBeGreaterThan(40);
  });
});
