import { describe, expect, it } from 'vitest';
import { applyHaze, applyWeatherSky, haze, HAZES, HAZE_NAMES, setHaze, weatherNow, weatherTargets, type HazeTarget } from '../src/render/atmosphere';
import { SkyState } from '../src/render/lights';

const target = (): HazeTarget => ({ fogNear: 0, fogFar: 120, fogMax: 0, skylineFog: 0, atmosMode: 0, hazeDist: 0, hazeMax: 0, hazeDesat: 0, detailFade: 0, edgeLevel: 0, farEnd: 0, farMax: 0 });
const clearWeather = { id: 'clear', lightModifier: 0, sightPenalty: 1, forced: null };

describe('distance haze presets', () => {
  it('default is the readable sky-matched preset', () => {
    expect(haze.name).toBe('clear');
    expect(HAZES.clear.mode).toBe(1);
  });

  it('clear keeps far contrast: fade starts late and never reaches the old fog wall', () => {
    setHaze('clear');
    weatherNow.overcast = weatherNow.thick = 0;
    const po = target();
    applyHaze(po);
    expect(po.fogNear).toBeGreaterThanOrEqual(0.5 * po.fogFar);
    expect(po.edgeLevel).toBeLessThan(0.5);
    expect(po.farMax).toBeLessThan(1);
    expect(po.farEnd).toBeGreaterThan(po.fogFar);
  });

  it('legacy reproduces the v2 fog (35% start, opaque at the draw distance)', () => {
    setHaze('legacy');
    const po = target();
    applyHaze(po);
    expect(po.atmosMode).toBe(0);
    expect(po.fogNear).toBeCloseTo(0.35 * 120);
    expect(po.edgeLevel).toBe(1);
    setHaze('clear');
  });

  it('presets get hazier in order clear < light < legacy', () => {
    const [a, b, c] = HAZE_NAMES.map((n) => HAZES[n]);
    expect(a.edgeLevel).toBeLessThan(b.edgeLevel);
    expect(b.edgeLevel).toBeLessThan(c.edgeLevel);
    expect(a.edgeStart).toBeGreaterThan(c.edgeStart);
  });

  it('unknown preset names fail loudly', () => {
    expect(() => setHaze('foggy' as never)).toThrow(/unknown haze/);
  });
});

describe('weather atmosphere', () => {
  it('maps BN light_modifier/sight_penalty to overcast/thickness', () => {
    expect(weatherTargets(clearWeather)).toEqual({ overcast: 0, thick: 0 });
    const t = weatherTargets({ id: 'thunder', lightModifier: -40, sightPenalty: 1.2, forced: null });
    expect(t.overcast).toBe(1);
    expect(t.thick).toBeGreaterThan(0.5);
  });

  it('overcast dims and hides the sun and greys the sky', () => {
    const sky = new SkyState();
    sky.update(12);
    const sunI = sky.sunIntensity;
    const zen = sky.zenith.clone();
    applyWeatherSky(sky, { id: 'rain', lightModifier: -30, sightPenalty: 1.1, forced: 'rain' }, 0.016, true);
    expect(sky.sunIntensity).toBeLessThan(sunI * 0.6);
    expect(sky.sunVisible).toBe(0);
    // less saturated: blue no longer dominates red by as much
    expect(sky.zenith.b - sky.zenith.r).toBeLessThan(zen.b - zen.r);
    applyWeatherSky(new SkyState(), clearWeather, 0.016, true);
    expect(weatherNow.overcast).toBe(0);
  });

  it('thick weather brings the haze closer but never makes it opaque', () => {
    setHaze('clear');
    weatherNow.thick = 1;
    const po = target();
    applyHaze(po);
    expect(po.hazeDist).toBeLessThan(HAZES.clear.hazeDist);
    expect(po.hazeMax).toBeLessThan(0.9);
    weatherNow.thick = 0;
  });
});
