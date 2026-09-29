import { describe, expect, it } from 'vitest';
import {
  bearing, dangerLevel, feedAlpha, lightLabel, messageTone, needStates, partTone, relativeAngle, stripPos, type NeedSource,
} from '../src/ui/hud_logic';
import { BODY_MAP, bodyPartAt, PART_BOX } from '../src/ui/pixelart';

const survivor = (o: Partial<{ hunger: string; thirst: string; sleep: string; temp: string; pain: number; morale: number; carried: number; cap: number }> = {}): NeedSource => ({
  hungerState: () => o.hunger ?? 'Sated',
  thirstDescription: () => o.thirst ?? '',
  sleepinessDescription: () => o.sleep ?? '',
  bodyTempDescription: () => o.temp ?? 'Comfortable',
  perceivedPain: () => o.pain ?? 0,
  painDescription: () => ((o.pain ?? 0) > 0 ? 'Moderate pain' : 'No pain'),
  morale: { level: () => o.morale ?? 0 },
  inv: { weightCarried: () => o.carried ?? 5000, weightCapacity: () => o.cap ?? 40000 },
});
const keys = (id: string) => ({ eat: 'E', sleep: '$', wear: 'O', drop: 'q' })[id] ?? '?';
const need = (s: NeedSource, id: string) => needStates(s, keys).find((n) => n.id === id)!;

describe('HUD needs', () => {
  it('a healthy survivor has nothing lit', () => {
    const all = needStates(survivor(), keys);
    expect(all.map((n) => n.id)).toEqual(['hunger', 'thirst', 'fatigue', 'temperature', 'pain', 'morale', 'weight']);
    expect(all.every((n) => n.level === 0 && n.label === '')).toBe(true);
  });

  it('escalates with the BN descriptions and says what to do with the player\'s keys', () => {
    expect(need(survivor({ thirst: 'Thirsty' }), 'thirst')).toMatchObject({ level: 1, label: 'Thirsty' });
    const parched = need(survivor({ thirst: 'Parched' }), 'thirst');
    expect(parched.level).toBe(3);
    expect(parched.advice).toContain('[E]');
    expect(need(survivor({ hunger: 'Famished' }), 'hunger').level).toBe(3);
    expect(need(survivor({ hunger: 'Very Hungry' }), 'hunger').level).toBe(2);
    expect(need(survivor({ sleep: 'Dead Tired' }), 'fatigue')).toMatchObject({ level: 2, label: 'Dead Tired' });
    expect(need(survivor({ sleep: 'Exhausted' }), 'fatigue').advice).toContain('[$]');
  });

  it('temperature: cold advice mentions clothes, heat advice does not', () => {
    const cold = need(survivor({ temp: 'Freezing!' }), 'temperature');
    expect(cold.level).toBe(3);
    expect(cold.label).toBe('Freezing');
    expect(cold.advice).toContain('[O]');
    const hot = need(survivor({ temp: 'Warm' }), 'temperature');
    expect(hot.level).toBe(1);
    expect(hot.advice).not.toContain('[O]');
    // An unknown description still shows up rather than vanishing.
    expect(need(survivor({ temp: 'Weird' }), 'temperature').level).toBe(1);
  });

  it('pain, morale and weight thresholds', () => {
    expect(need(survivor({ pain: 10 }), 'pain').level).toBe(1);
    expect(need(survivor({ pain: 45 }), 'pain').level).toBe(2);
    expect(need(survivor({ pain: 80 }), 'pain').level).toBe(3);
    expect(need(survivor({ morale: -20 }), 'morale').level).toBe(1);
    expect(need(survivor({ morale: -120 }), 'morale').level).toBe(3);
    expect(need(survivor({ morale: 30 }), 'morale')).toMatchObject({ level: 0, good: true });
    expect(need(survivor({ carried: 41000 }), 'weight').level).toBe(1);
    expect(need(survivor({ carried: 70000 }), 'weight').level).toBe(3);
    expect(need(survivor({ carried: 40000 }), 'weight').level).toBe(0);
  });
});

describe('HUD body + compass + feed', () => {
  it('part tones', () => {
    expect(partTone(60, 60, false)).toBe('good');
    expect(partTone(45, 60, false)).toBe('ok');
    expect(partTone(25, 60, false)).toBe('warn');
    expect(partTone(10, 60, false)).toBe('bad');
    expect(partTone(0, 60, false)).toBe('broken');
    expect(partTone(50, 60, true)).toBe('broken');
  });

  it('silhouette: every main part is present and hit-testable', () => {
    for (const part of ['head', 'torso', 'arm_l', 'arm_r', 'leg_l', 'leg_r'] as const) {
      const b = PART_BOX[part];
      expect(b, part).toBeDefined();
      // Some pixel inside its box belongs to it.
      let found = false;
      for (let y = b.y0; y <= b.y1 && !found; y++) for (let x = b.x0; x <= b.x1; x++) if (bodyPartAt(x, y) === part) found = true;
      expect(found, part).toBe(true);
    }
    // Front view: the survivor's right arm is on the viewer's left.
    expect(PART_BOX.arm_r.x1).toBeLessThan(PART_BOX.torso.x0);
    expect(PART_BOX.arm_l.x0).toBeGreaterThan(PART_BOX.torso.x1);
    expect(new Set(BODY_MAP.map((r) => r.length)).size).toBe(1);
  });

  it('bearing: 0 north, clockwise; relative angle wraps', () => {
    expect(bearing(0, 0, 0, -5)).toBeCloseTo(0);
    expect(bearing(0, 0, 5, 0)).toBeCloseTo(Math.PI / 2);
    expect(bearing(0, 0, 0, 5)).toBeCloseTo(Math.PI);
    expect(bearing(0, 0, -5, 0)).toBeCloseTo((3 * Math.PI) / 2);
    expect(relativeAngle(0.1, 2 * Math.PI - 0.1)).toBeCloseTo(0.2);
    expect(relativeAngle(Math.PI / 2, 0)).toBeCloseTo(Math.PI / 2);
    expect(relativeAngle((3 * Math.PI) / 2, 0)).toBeCloseTo(-Math.PI / 2);
  });

  it('strip position clamps to the nearer edge', () => {
    expect(stripPos(0, Math.PI)).toEqual({ x: 0.5, clamped: false });
    expect(stripPos(Math.PI / 2, Math.PI).x).toBeCloseTo(1);
    expect(stripPos(3, Math.PI)).toEqual({ x: 1, clamped: true });
    expect(stripPos(-3, Math.PI)).toEqual({ x: 0, clamped: true });
  });

  it('danger level', () => {
    expect(dangerLevel([], false)).toBe('safe');
    expect(dangerLevel([20], false)).toBe('aware');
    expect(dangerLevel([4, 20], false)).toBe('near');
    expect(dangerLevel([], true)).toBe('grabbed');
  });

  it('message tones and fading', () => {
    expect(messageTone('c_red')).toBe('bad');
    expect(messageTone('c_light_red')).toBe('bad');
    expect(messageTone('c_light_green')).toBe('good');
    expect(messageTone('c_yellow')).toBe('warn');
    expect(messageTone('c_light_cyan')).toBe('info');
    expect(messageTone('c_dark_gray')).toBe('dim');
    expect(messageTone(undefined)).toBe('text');
    expect(feedAlpha(0)).toBe(1);
    expect(feedAlpha(8)).toBe(1);
    expect(feedAlpha(11)).toBeCloseTo(0.5);
    expect(feedAlpha(30)).toBe(0);
  });

  it('light labels follow CDDA light units', () => {
    expect(lightLabel(120).label).toBe('Bright');
    expect(lightLabel(12).label).toBe('Lit');
    expect(lightLabel(6).label).toBe('Dim');
    expect(lightLabel(3.5).bars).toBe(0);
  });
});
