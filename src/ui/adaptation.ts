// Switches for the "TV adaptation" choices that live in game rules rather than UI
// (docs/ADAPTATION.md). Each keeps the previous behaviour one option away.
//
//   Options > Climate: "Mid-spring (BN start)" (default) or "Early spring (old)"
//   ?climate=bn|old overrides for a session.

import type { Game } from '../game/game';
import { BN_START_CLIMATE_OFFSET_DAYS, refreshWeather, setClimateOffsetDays, weatherMessages } from '../game/weather';
import { registerOption } from './options';
import { registerMapAtlasOption } from './overmap_ui';
import { adaptationRules } from '../game/adaptation_rules';
import { installBoilWater } from '../game/boil';

type Climate = 'bn' | 'old';
const KEY = 'cdda3d.climate';

function climate(): Climate {
  const q = new URLSearchParams(location.search).get('climate');
  if (q !== null) {
    if (q !== 'bn' && q !== 'old') throw new Error(`?climate=${q}: expected bn or old`);
    return q;
  }
  try {
    return localStorage.getItem(KEY) === 'old' ? 'old' : 'bn';
  } catch {
    return 'bn';
  }
}

function apply(game: Game): void {
  setClimateOffsetDays(climate() === 'bn' ? BN_START_CLIMATE_OFFSET_DAYS : 0);
  if (game.weather) refreshWeather(game);
}

export function installAdaptation(game: Game): void {
  apply(game);
  registerMapAtlasOption();
  installBoilWater(game);
  // Rule switches (src/game/adaptation_rules.ts): adapted by default, BN one click away.
  const ruleOption = (key: keyof typeof adaptationRules, name: string, on: string, off: string, desc: string) => {
    const storeKey = `cdda3d.rule.${key}`;
    try {
      const v = localStorage.getItem(storeKey);
      if (v === 'off') adaptationRules[key] = false;
      else if (v === 'on') adaptationRules[key] = true;
    } catch {
      // storage blocked: defaults
    }
    registerOption({
      category: 'Gameplay',
      name,
      value: () => (adaptationRules[key] ? on : off),
      change: () => {
        adaptationRules[key] = !adaptationRules[key];
        try {
          localStorage.setItem(storeKey, adaptationRules[key] ? 'on' : 'off');
        } catch {
          // not persisted
        }
      },
      desc,
    });
  };
  ruleOption('easyBeds', 'First beds', 'No skill needed (slower)', 'Fabrication 1–2 (BN)',
    'A straw bed or a makeshift bed can be built without Fabrication skill; it takes 1.5× as long. Bright Nights asks for Fabrication 1–2, which a new survivor does not have.');
  ruleOption('fireWarning', 'Fire safety', 'Warn outside a fire ring', 'No warning (BN)',
    'Lighting a fire outside a fire ring, brazier or fireplace, next to something that burns (or indoors), first says so; use the lighter again to go ahead.');
  const WM_KEY = 'cdda3d.weatherMessages';
  const wmAll = () => {
    try {
      return localStorage.getItem(WM_KEY) === 'all';
    } catch {
      return false;
    }
  };
  weatherMessages.all = wmAll();
  registerOption({
    category: 'Interface',
    name: 'Weather messages',
    value: () => (weatherMessages.all ? 'Every change (CDDA)' : 'Changes you notice'),
    change: () => {
      weatherMessages.all = !weatherMessages.all;
      try {
        localStorage.setItem(WM_KEY, weatherMessages.all ? 'all' : 'notice');
      } catch {
        // not persisted
      }
    },
    desc: 'Changes you notice: a message when it starts or stops raining or snowing, not for every shade of drizzle, and none while waiting or sleeping. Every change: like Cataclysm.',
  });
  registerOption({
    category: 'Gameplay',
    name: 'Climate',
    value: () => (climate() === 'bn' ? 'Mid-spring start (BN)' : 'Early spring (old)'),
    change: () => {
      try {
        localStorage.setItem(KEY, climate() === 'bn' ? 'old' : 'bn');
      } catch {
        // not persisted
      }
      apply(game);
    },
    desc: 'Mid-spring: the weather starts where Bright Nights starts a new world (about 8 °C, rain more likely than snow), matching the green spring you see. Early spring: the weather of the last days of winter (frost and snow on day one).',
  });
}
