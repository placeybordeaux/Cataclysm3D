import type { Game } from '../game/game';
import type { AchievementDef } from '../game/achievements';
import type { AchievementsHandle } from '../achievements';

// The `)` scores screen and the unlock toast. Both live in src/screens/achievements.ts (ui2,
// styled like the Survival Journal); they're loaded on first use so this module stays free of
// DOM work at import time (src/achievements.ts is imported by headless tests).

export function installAchievementsUi(game: Game, handle: () => AchievementsHandle) {
  const open = () => void import('../screens/achievements').then((m) => m.openAchievements(game, handle()));
  game.keys.register('achievements', 'View achievements, scores, and kills', open);
  return {
    open,
    toast: (a: AchievementDef) => {
      if (typeof document === 'undefined') return;
      void import('../screens/achievements').then((m) => m.showAchievementToast(a));
    },
  };
}
