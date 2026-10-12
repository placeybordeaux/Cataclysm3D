import { describe, expect, it } from 'vitest';
import { ActivityManager } from '../src/game/activity';

// Playtest: "I try to start a fire in a fireplace and it just says I stopped" — W still held
// from walking up cancelled the activity on its first tick.
describe('activities vs movement keys', () => {
  const host = () => {
    const held = new Set<string>();
    const msgs: string[] = [];
    const game = {
      input: { held, captured: false },
      clock: { warp: 1 },
      message: (m: string) => msgs.push(m),
    } as any;
    return { game, held, msgs, acts: new ActivityManager(game) };
  };
  it('a key held when the activity starts does not cancel it; a fresh press does', () => {
    const { game, held, msgs, acts } = host();
    held.add('KeyW');
    let done = false;
    acts.start({ name: 'lighting a fire', duration: 10, onComplete: () => (done = true) });
    acts.update(game, 0.1, 1);
    expect(acts.current).not.toBe(null);
    held.delete('KeyW');
    acts.update(game, 0.1, 1);
    held.add('KeyW');
    acts.update(game, 0.1, 1);
    expect(acts.current).toBe(null);
    expect(done).toBe(false);
    expect(msgs.at(-1)).toMatch(/You stop lighting a fire/);
  });
  it('completes when you stand still', () => {
    const { game, acts } = host();
    let done = false;
    acts.start({ name: 'lighting a fire', duration: 3, onComplete: () => (done = true) });
    for (let i = 0; i < 5; i++) acts.update(game, 0.1, 1);
    expect(done).toBe(true);
  });
  it('notifies menus synchronously once work and its clock warp are ready', () => {
    const { game, acts } = host();
    let starts = 0;
    acts.startHooks.push((a) => {
      expect(acts.current).toBe(a);
      expect(game.clock.warp).toBe(20);
      starts++;
    });
    expect(acts.start({ name: 'disassembling', duration: 60, warp: 20, onComplete: () => {} })).toBe(true);
    expect(starts).toBe(1);
    acts.update(game, 0.1, 1);
    expect(starts).toBe(1);
  });
  it('leaves menus alone when danger prevents starting work', () => {
    const { acts } = host();
    let starts = 0;
    acts.startHooks.push(() => starts++);
    acts.dangerChecks.push(() => 'You see a zombie!');
    expect(acts.start({ name: 'reading', duration: 60, onComplete: () => {} })).toBe(false);
    expect(acts.current).toBeNull();
    expect(starts).toBe(0);
  });
});
