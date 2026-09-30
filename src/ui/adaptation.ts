// Switches for the "TV adaptation" choices that live in game rules rather than UI
// (docs/ADAPTATION.md). Each keeps the previous behaviour one option away.
//
//   Options > Climate: "Mid-spring (BN start)" (default) or "Early spring (old)"
//   ?climate=bn|old overrides for a session.

import type { Game } from '../game/game';
import { BN_START_CLIMATE_OFFSET_DAYS, refreshWeather, setClimateOffsetDays } from '../game/weather';
import { registerOption } from './options';
import { registerMapAtlasOption } from './overmap_ui';

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
  registerOption({
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
