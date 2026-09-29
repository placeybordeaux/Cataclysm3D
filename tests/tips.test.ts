import { describe, expect, it } from 'vitest';
import { startHints } from '../src/ui/tips';

describe('start-of-game hints', () => {
  it('cover the onboarding points and only name real key bindings', () => {
    const text = startHints().join(' ').replace(/<[^>]+>/g, '');
    expect(text).toMatch(/Search the lockers/);
    expect(text).toMatch(/Zombies hear you/);
    expect(text).toMatch(/outrun/);
    // A key() for an unbound action renders '?'; the only one allowed is the help key.
    expect(text.match(/\?/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });
});
