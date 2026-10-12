// Real-input deferred tool-use gesture scenarios, run from tools/realinput.ts:
//   --only toolgesture      u → the "Use item" picker → a wielded lens lights a patch of
//                           underbrush (an activity, not an instant action, ~3.5 real s
//                           warped with no fuel item — the longest-running firestarter tool,
//                           for the most cancel-timing room this still gets): no gesture
//                           while it's running; walking away cancels it with no gesture
//                           either; letting it finish raises/turns the tool for ~1.2 s, then
//                           restores the normal held pose (src/game/inventory.ts
//                           presentDeferredUse, src/game/fire.ts useFirestarter,
//                           docs/CHARACTERS.md). Switches on the 3D first-person hands
//                           (cdda.chars({ viewmodel: 'model' }); sprites are the default and
//                           never animate) and restores the setting after.
//   --only toolgestureaxe   u → the picker → a wielded axe's "Use" submenu (ui2/bn/install.ts
//                           applyPickerChoice) → Chop tree → starts and completes the chop,
//                           gesturing at completion. Regression coverage for the submenu bug
//                           fixed alongside this package (see below).
//
// Keys and mouse are OS-level input; cdda.* only sets up a flat clearing with flammable
// underbrush or a tree and the tool, clears monsters, and reads activity/terrain/field state.

import { onFoot, settleWorld, type XInput } from './lib/realinput';

export interface ToolGestureCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function toolGestureScenarios(c: ToolGestureCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  /**
   * Flatten a clearing, put flammable underbrush just north, and hand over a high-quality
   * lens. No fuel item on the tile (the slow case) and no carried firewood: of the
   * firestarter tools, the lens's moves_slow (30000) gives the longest real-time window —
   * ActivityManager's warp caps every activity at ~8 real s regardless of game-time duration
   * (src/game/activity.ts defaultWarp), and no firestarter tool's slow case reaches the
   * game-time duration that cap needs, so ~3.5 s is the practical ceiling here. That's still
   * tight against round-trip latency under load, which is why the cancel step below has no
   * slack to spare (noon + outdoors satisfies the lens's need_sunlight).
   */
  const clearingWithFuel = (dx: number, dy: number) => js<{ x: number; y: number; z: number }>(`(() => {
    cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(Infinity);
    const p = cdda.game.player, m = cdda.game.map;
    p.x += ${dx}; p.y += ${dy};
    const x = Math.floor(p.x), y = Math.floor(p.y), z = p.z;
    for (let ddx = -2; ddx <= 2; ddx++) for (let ddy = -2; ddy <= 2; ddy++) m.setTer(x + ddx, y + ddy, z, 't_dirt');
    m.setTer(x, y - 1, z, 't_underbrush');
    cdda.giveItem('lens', { wield: true });
    // Face the target tile: the facing is whatever the last scenario left (getting out of a
    // car faces you away from it), and the tool acts on what the crosshair is on.
    cdda.faceTile(x, y - 1);
    return { x, y, z };
  })()`);
  const fieldsAt = (x: number, y: number, z: number) => js<string[]>(`cdda.game.map.fieldsAt(${x}, ${y}, ${z}).map((f) => f.type)`);
  /** The load gate (src/loadgate) holds the game and swallows keys right after a teleport
   * while the new surroundings build: wait it out, as a player would (toGameplay does the
   * same right after a title-screen start; a mid-scenario teleport needs its own wait). */
  const waitLoadGate = async () => {
    const w = await settleWorld(js);
    if (!w.ok) check('the surroundings finished loading (load gate open, chunks built)', false, w);
  };
  const activityName = () => js<string | null>('cdda.game.activities.current?.spec.name ?? null');
  const lastMessage = () => js<string>('cdda.ui.log().slice(-1)[0] ?? \'\'');
  /** Find a row by its visible text in `u`'s quick picker (`.bn-pick-row`, like `E`'s eat
   * picker) and click it. */
  const clickMenuRow = async (re: string, shotName?: string): Promise<boolean> => {
    const row = await js<{ x: number; y: number } | null>(`(() => {
      const e = [...document.querySelectorAll('#ui2 .bn-pick-row')].find((r) => new RegExp(${JSON.stringify(re)}, 'i').test(r.textContent || ''));
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    if (shotName) await shot(shotName);
    if (!check(`a picker row matches /${re}/i`, !!row, await js(`[...document.querySelectorAll('#ui2 .bn-pick-row')].map((e) => e.textContent)`))) return false;
    await c.x().click(row!.x, row!.y);
    return true;
  };
  /**
   * `u`, pick the wielded lens. It has exactly one use_action (firestarter), so the picker's
   * `run` takes its direct-action branch (ui2/bn/install.ts's `applyPickerChoice`) rather
   * than opening an actions submenu — this scenario is about the cancel/completion timing,
   * not the submenu itself, so the simpler single-action tool keeps it focused (the
   * `toolgestureaxe` scenario below covers the submenu path, for a multi-use_action tool like
   * an axe).
   *
   * The first attempt on a tile with something flammable nearby may only warn ("Fires
   * spread… Use the lighter again to light it anyway") without starting anything — a real
   * player reads that and tries again, so this does too. Trailing waits are kept short: the
   * activity's own real-time window is only ~3.5 s (see clearingWithFuel), so every
   * millisecond spent here before the cancel step below is margin the test can't get back.
   */
  const applyFirestarter = async (shotName: string): Promise<void> => {
    await c.x().key('u');
    await sleep(400);
    await clickMenuRow('lens', shotName);
    await sleep(150);
    if (!(await activityName()) && /Use the lighter again/.test(await lastMessage())) {
      await c.x().key('u');
      await sleep(400);
      await clickMenuRow('lens');
      await sleep(150);
    }
  };
  const seenGesture = () => js<boolean>(`cdda.fpView?.gesture?.action?.kind === 'use'`);
  /**
   * Watch, every frame in the page, for the activity's result (`doneExpr`, page code) and for
   * the 'use' gesture. Polling both from here (250 ms steps, then a screenshot) could miss the
   * ~1.2 s gesture entirely on a slow frame; this records when each first happened.
   */
  const watchGesture = (doneExpr: string) => js(`(() => {
    const w = window.__gw = { doneAt: 0, gestureAt: 0, stop: false };
    const tick = () => {
      const now = performance.now();
      if (!w.doneAt && (${doneExpr})) w.doneAt = now;
      if (!w.gestureAt && cdda.fpView?.gesture?.action?.kind === 'use') w.gestureAt = now;
      if (!w.stop && now - (w.doneAt || now) < 3000) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  /** What watchGesture saw: the gesture came with the result (not before it, within 1.5 s after). */
  const gestureWithResult = () => js<{ ok: boolean; doneAt: number; gestureAt: number }>(`(() => { const w = window.__gw; w.stop = true; return { ok: !!w.doneAt && !!w.gestureAt && w.gestureAt >= w.doneAt - 50 && w.gestureAt - w.doneAt < 1500, doneAt: w.doneAt, gestureAt: w.gestureAt }; })()`);
  /**
   * Poll a condition instead of a fixed sleep-then-check: under SwiftShader + the 3D
   * viewmodel, frame delivery (and so ItemGesture's own per-frame elapsed-time tick, and the
   * ActivityManager's per-tick movement-cancel check) can stretch well past what looks like
   * generous real time on a lightly-loaded machine. A single immediate check after a fixed
   * wait races that; polling up to a real timeout doesn't, while still failing loudly if the
   * state genuinely never arrives (a real bug, not just slow).
   */
  const waitUntil = async (cond: () => Promise<boolean>, ms = 5000, step = 150): Promise<boolean> => {
    const end = Date.now() + ms;
    let ok = await cond();
    while (!ok && Date.now() < end) {
      await sleep(step);
      ok = await cond();
    }
    return ok;
  };
  /** Poll for the "lighting the fire" activity to actually be under way: applyFirestarter's
   * own internal retry (the indoor fire-spread warning) can still be settling when it
   * returns, so a single immediate check races it. */
  const waitForLighting = async (ms = 3000): Promise<string | null> => {
    const end = Date.now() + ms;
    let name = await activityName();
    while (!name && Date.now() < end) {
      await sleep(100);
      name = await activityName();
    }
    return name;
  };
  /** Any pending gesture (this scenario's own, or — in a combined run — a just-finished
   * earlier scenario's not-yet-decayed one) actually clear before asserting against it. */
  const waitNoGesture = (ms = 5000) => waitUntil(async () => !(await seenGesture()), ms);

  /** Flatten a clearing and put a tree just north, for the axe scenario. */
  const clearingWithTree = (dx: number, dy: number) => js<{ x: number; y: number; z: number }>(`(() => {
    cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(Infinity);
    const p = cdda.game.player, m = cdda.game.map;
    p.x += ${dx}; p.y += ${dy};
    const x = Math.floor(p.x), y = Math.floor(p.y), z = p.z;
    for (let ddx = -2; ddx <= 2; ddx++) for (let ddy = -2; ddy <= 2; ddy++) m.setTer(x + ddx, y + ddy, z, 't_grass');
    m.setTer(x, y - 1, z, 't_tree');
    cdda.giveItem('ax', { wield: true });
    // Face the target tile: the facing is whatever the last scenario left (getting out of a
    // car faces you away from it), and the tool acts on what the crosshair is on.
    cdda.faceTile(x, y - 1);
    return { x, y, z };
  })()`);
  /** Find a row by its visible text in a ui2 context menu (`.ui2-menu-row`, the "Use" submenu
   * opened by ui2/bn/install.ts's applyPickerChoice) and click it. */
  const clickSubmenuRow = async (re: string, shotName?: string): Promise<boolean> => {
    const row = await js<{ x: number; y: number } | null>(`(() => {
      const e = [...document.querySelectorAll('.ui2-menu-row')].find((r) => new RegExp(${JSON.stringify(re)}, 'i').test(r.textContent || ''));
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    if (shotName) await shot(shotName);
    if (!check(`a submenu row matches /${re}/i`, !!row, await js(`[...document.querySelectorAll('.ui2-menu-row')].map((e) => e.textContent)`))) return false;
    await c.x().click(row!.x, row!.y);
    return true;
  };
  const terAt = (x: number, y: number, z: number) => js<string>(`cdda.game.map.terAt(${x}, ${y}, ${z}).id`);

  const scenarios: Scenario[] = [
    ['toolgesture', "`u`pplying a lens to light underbrush: no gesture while the activity runs, none if cancelled, the tool raises/turns for ~1.2 s only once the fire actually catches, then returns to its normal held pose", async () => {
      await toGameplay();
      // (the loadgate scenario ends in a car: the clearing teleport would keep you seated)
      await onFoot(js);
      // In a combined run this scenario may follow another that just finished its own
      // gesture: let any of that decay before this scenario's own assertions start.
      await waitNoGesture();
      // Well clear of the evac shelter's own roof (isOutside), so lighting a fire never needs
      // the indoor fire-spread warning's "try again within 30s" exemption.
      const spot = await clearingWithFuel(30, 30);
      await waitLoadGate();

      await applyFirestarter('toolgesture_1_apply_picker');
      const lighting = await waitForLighting();
      check('lighting the fire is running as an activity (not finished yet)', /lighting the fire/.test(lighting ?? ''), lighting);
      check('no gesture while it only runs (never on open)', !(await seenGesture()), lighting);

      // --- cancel immediately: walking away stops it, and it must never have animated. The
      // activity's own real-time window is only ~3.5 s (see clearingWithFuel), so nothing —
      // not even a screenshot — comes between confirming it's running and interrupting it.
      // "No longer running" alone is ambiguous (cancelled vs. it simply finished in the
      // meantime under load), so this reads the actual outcome message instead of guessing
      // from timing: BN's cancel message for this activity is "You stop lighting the fire."
      // (ActivityManager.cancel, named from the activity's own spec.name), distinct from
      // "You successfully light a fire." on completion (src/game/fire.ts's light()).
      await c.x().hold('w', 300);
      await waitUntil(async () => /You (stop lighting|successfully light)/.test(await lastMessage()));
      const outcome = await lastMessage();
      const cancelled = /You stop lighting the fire/.test(outcome);
      check('walking away cancels the activity', cancelled, outcome);
      check('nothing caught (no fd_fire field)', !(await fieldsAt(spot.x, spot.y - 1, spot.z)).includes('fd_fire'));
      check('cancelling never shows the gesture', !(await seenGesture()));
      await shot('toolgesture_2_cancelled_no_gesture');

      // --- a fresh clearing, let it actually finish this time.
      const spot2 = await clearingWithFuel(40, 40);
      await waitLoadGate();
      await watchGesture(`cdda.game.map.fieldsAt(${spot2.x}, ${spot2.y - 1}, ${spot2.z}).some((f) => f.type === 'fd_fire')`);
      await applyFirestarter('toolgesture_3_apply_picker_again');
      const end = Date.now() + 15000;
      let done = false;
      while (Date.now() < end && !done) {
        await sleep(250);
        done = (await fieldsAt(spot2.x, spot2.y - 1, spot2.z)).includes('fd_fire');
      }
      check('letting it run catches the fire (within 15 real s)', done, { spot2, act: await activityName(), log: await js('cdda.ui.log().slice(-5)') });
      await shot('toolgesture_4_gesture_on_completion');
      const g1 = await gestureWithResult();
      check('the real tool (lens) is what is shown, raised/turned, right after completion', g1.ok, g1);
      // The gesture's own 1.2 real s, plus slow-rendering margin: poll rather than one check
      // after a fixed sleep.
      const restored = await waitNoGesture(10000);
      await shot('toolgesture_5_restored');
      check('it restores to the normal held pose once the gesture ends', restored);
    }],

    ['toolgestureaxe', '`u`pplying an axe: the "Use" submenu lists its real tool actions (regression — it used to always build empty) and choosing Chop tree starts and finishes the chop, gesturing only at completion', async () => {
      await toGameplay();
      await onFoot(js);
      // In a combined run this scenario may follow another that just finished its own
      // gesture: let any of that decay before asserting "no gesture while running" below —
      // otherwise a slow-to-clear previous gesture reads as a false "gesture fired early"
      // here, not a real bug in this scenario's own chop.
      await waitNoGesture();
      const spot = await clearingWithTree(30, 30);
      await waitLoadGate();

      await c.x().key('u');
      await sleep(400);
      if (!(await clickMenuRow('wood axe', 'toolgestureaxe_1_apply_picker'))) return;
      await sleep(400);
      await shot('toolgestureaxe_2_use_submenu');
      // BN's own item_actions.json name for CHOP_TREE ("Chop down a tree"), not the raw id.
      await watchGesture(`cdda.game.map.terAt(${spot.x}, ${spot.y - 1}, ${spot.z}).id === 't_stump'`);
      if (!(await clickSubmenuRow('chop down a tree'))) return;

      const chopping = await waitForLighting(); // same "poll until activities.current" wait, any name
      check('choosing Chop tree starts the activity', /chopping down/.test(chopping ?? ''), chopping);
      check('no gesture while it only runs', !(await seenGesture()), chopping);
      await shot('toolgestureaxe_3_chopping_no_gesture');

      // Chopping is capped at ~8 real s by the warp, but SwiftShader + the 3D viewmodel can
      // render slowly enough to stretch that wall-clock-wise; give it real room.
      const end = Date.now() + 45000;
      let done = false;
      while (Date.now() < end && !done) {
        await sleep(250);
        done = (await terAt(spot.x, spot.y - 1, spot.z)) === 't_stump';
      }
      check('the tree actually falls (within 45 real s)', done, { spot });
      await shot('toolgestureaxe_4_gesture_on_completion');
      const g2 = await gestureWithResult();
      check('the real tool (axe) is what is shown, raised/turned, right after completion', g2.ok, g2);
      // The gesture's own 1.2 real s, plus the same slow-rendering margin as above.
      const restored = await waitNoGesture(10000);
      check('it restores to the normal held pose once the gesture ends', restored);
      await shot('toolgestureaxe_5_restored');
    }],
  ];
  // The gesture is drawn by the 3D first-person hands only (sprites are the default and never
  // animate: fpView.ts clears the gesture while inactive), so each scenario switches them on
  // and puts back the player's setting after, however it ends.
  return scenarios.map(([name, what, run]): Scenario => [name, what, async () => {
    const before = await js<string>(`cdda.chars().viewmodel`);
    await js(`cdda.chars({ viewmodel: 'model' })`);
    try {
      await run();
    } finally {
      await js(`cdda.chars({ viewmodel: ${JSON.stringify(before)} })`);
    }
  }]);
}
