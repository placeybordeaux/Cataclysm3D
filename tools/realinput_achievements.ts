// Real-input achievements scenario (docs/ACHIEVEMENTS.md), run from tools/realinput.ts:
//   --only achievements
// Verifies the achievement/scores system (src/game/achievements.ts, src/achievements.ts)
// tracks real play, not scripted unlocks: a real melee kill (LMB swings) completes
// "One Down, Billions to Go…" through the game's own creatureDied → character_kills_monster
// path, and real walking (held W) advances the 1000-mile travel achievement's progress bar
// through the real avatar_moves path. Both then show correctly in the `)` achievements screen.
//
// cdda.* only sets the scene (spawns one zombie with low hp so a few real swings finish it,
// gives a bat, faces it for the first swing — the same "setup, not input" convention as every
// other combat scenario here) and reads state; the kill and the walk are OS-level mouse/
// keyboard input through xdotool. Two things this scenario works around, neither specific to
// achievements:
//  - The Evacuee start is a zombie-dense area, so the scene is pinned to our spawned zombie's
//    uid throughout (`window.__zid`): a lookup by type id alone can pick a different,
//    out-of-reach zombie already nearby and every swing would whiff at it.
//  - Run alone (`--only achievements`), real mouse-button input takes a real-time while to
//    "arm" right after quickStart's own click into the title screen (every other isolated
//    combat scenario here shows the same warm-up), so the swing loop runs well past what one
//    swing ought to take and a `cdda.step()` nudge after the teleport/face (as tools/
//    realinput_curtains.ts does before its own real swings) is part of getting there.

import { onFoot, type XInput } from './lib/realinput';

export interface AchievementsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** Exact-id lookup (api.achievements filters by substring, which "achievement_kill_zombie"
 *  would also match inside "achievement_kill_zombie_50"). */
const FIND = (id: string) => `cdda.achievements().find((a) => a.id === ${JSON.stringify(id)})`;

export function achievementsScenarios(c: AchievementsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const x = () => c.x();

  return [
    [
      'achievements',
      'a real melee kill completes the zombie-kill achievement through creatureDied; real walking advances the 1000-mile travel achievement through avatar_moves; both show in the ) screen',
      async () => {
        await toGameplay();
        // Setup: on foot (an earlier scenario can leave you in a car seat, where W hops seats
        // instead of walking).
        await onFoot(js);
        // toGameplay() only re-clicks the window centre when the lock was lost; coming straight
        // from quickStart's title-screen click, the real OS cursor can be left off the canvas,
        // so mousedown (bound to the canvas, not window) never reaches the page. Centre it once.
        const mid = await js<{ w: number; h: number }>(`({ w: innerWidth, h: innerHeight })`);
        await x().click(mid.w / 2, mid.h / 2);
        await sleep(200);
        const before = await js<{ status: string; miles: number }>(
          `(() => ({ status: ${FIND('achievement_kill_zombie')}.status, miles: cdda.achievementStat('num_moves_walked') }))()`,
        );
        check('the zombie-kill achievement starts pending (not pre-completed)', before.status === 'pending', before);

        // --- a real melee kill: spawn (and pin by uid) a weak, adjacent zombie, face it, then real LMB swings
        await js(`(() => {
          cdda.giveItem('bat', { wield: true });
          window.__zid = cdda.spawnMonster('mon_zombie', 0, -1); // adjacent: melee reach is 1.2 m
          const m = cdda.game.monsters.all.find((z) => z.uid === window.__zid);
          m.hp = 10; // a few real swings, not forty
          cdda.faceTile(Math.floor(m.x), Math.floor(m.y));
          cdda.game.player.pitch = 0;
          cdda.step(0.05);
        })()`);
        const FACE_ZOMBIE = `(() => { const m = cdda.game.monsters.all.find((z) => z.uid === window.__zid && !z.dead); if (m) { cdda.faceTile(Math.floor(m.x), Math.floor(m.y)); cdda.game.player.pitch = 0; } return !!m; })()`;
        await sleep(300);
        let dead = false;
        // Re-face right before each swing: residual mouse deltas from the xdotool clicks
        // themselves drift the yaw a real player's held gaze wouldn't. The real-input "arming"
        // warm-up (see header) varied between ~13 s and over ~14 s across runs, so this budgets
        // generously past the worst case seen rather than a fixed small retry count.
        for (let i = 0; i < 35 && !dead; i++) {
          await js(FACE_ZOMBIE);
          await x().clickHere();
          await sleep(800);
          dead = await js<boolean>(`!cdda.game.monsters.all.some((m) => m.uid === window.__zid && !m.dead)`);
        }
        check('the zombie dies to real LMB swings', dead);
        await sleep(200);
        await toGameplay(); // nearby chunks may still be building (the load gate): wait it out, like a player would
        const afterKill = await js<string>(`${FIND('achievement_kill_zombie')}.status`);
        check('achievement_kill_zombie completes through the real creatureDied path', afterKill === 'completed', afterKill);

        // --- real walking (held W) advances the long-distance travel achievement
        await js(`cdda.clearMonsters(30)`); // the start area is zombie-dense; a bite mid-walk shouldn't derail the check
        await x().hold('w', 2500);
        await sleep(200);
        await toGameplay(); // the walk may have crossed into unbuilt chunks (the load gate): wait it out
        const miles = await js<number>(`cdda.achievementStat('num_moves_walked')`);
        check('real walking advances num_moves_walked', miles > before.miles, { before: before.miles, miles });
        const walkLine = await js<string | undefined>(`${FIND('achievement_walk_1000_miles')}.progress[0]`);
        check('the 1000-mile achievement shows real, un-completed progress', /^\[ \] \d+\/1609340/.test(walkLine ?? ''), walkLine);

        // --- the ) screen shows both
        const achKey = await js<string>(`cdda.game.keys.keyFor('achievements')`);
        await x().key(achKey);
        await sleep(600);
        const ui = await js<{ killClass: string; killDone: boolean; walkText: string }>(`(() => {
          const k = document.querySelector('[data-ach="achievement_kill_zombie"]');
          const w = document.querySelector('[data-ach="achievement_walk_1000_miles"]');
          return { killClass: k?.className ?? '', killDone: /✓/.test(k?.querySelector('.pg-entry-title')?.textContent ?? ''), walkText: w?.textContent ?? '' };
        })()`);
        check('the ) screen shows the zombie-kill achievement completed (green "got" card)', /\bgot\b/.test(ui.killClass) && ui.killDone, ui);
        check('the ) screen shows the travel achievement in progress', new RegExp(`${miles}/1609340`).test(ui.walkText), ui);
        await shot('achievements_screen');
        await x().key(achKey);
      },
    ],
  ];
}
