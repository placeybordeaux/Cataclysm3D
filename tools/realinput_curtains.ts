// Real-input curtains and smash-sound scenarios, run from tools/realinput.ts:
//   --only curtains     a curtained window from inside: `e` shows the curtain/window menu, close
//                       the curtains (the room darkens, outside can't see in), open them, open and
//                       shut the window, peek, save/load keeps them drawn; from outside only
//                       examine/pry (docs/FURNITURE.md "Curtains")
//   --only smashsound   smash a door with X and with melee swings, smash a window: every blow
//                       that logs a sound ("whump!") played a real sample at the door
//                       (cdda.audio.history outcome 'playing'); a zombie bashing a door is heard
//
// Keys and clicks are OS-level input; cdda.* only teleports, sets the hour, hands out a bat and
// reads state. Seed 1: the evac shelter's curtained windows and doors.

import { settleWorld, type XInput } from './lib/realinput';

export interface CurtainsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];
interface Spot { w: [number, number]; inside: [number, number]; outside: [number, number] }
interface Heard { id: string; variant: string; outcome: string; x: number; y: number }

/** A curtained window with a walkable indoor tile on one side and an outdoor one on the other. */
const FIND_WINDOW = `(() => {
  const g = cdda.game, m = g.map, p = g.player;
  const roof = (x, y) => m.hasFloor(x, y, 1);
  let best = null, bd = 1e9;
  for (let dy = -40; dy <= 40; dy++) for (let dx = -40; dx <= 40; dx++) {
    const x = p.tileX + dx, y = p.tileY + dy;
    if (m.terAt(x, y, 0).id !== 't_window_domestic') continue;
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ix = x + ex, iy = y + ey, ox = x - ex, oy = y - ey;
      if (m.furnAt(ix, iy, 0).id !== 'f_null') continue;
      if (!(roof(ix, iy) && m.passable(ix, iy, 0) && !roof(ox, oy) && m.passable(ox, oy, 0))) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { w: [x, y], inside: [ix, iy], outside: [ox, oy] }; }
    }
  }
  return best;
})()`;

/** A closed wooden door with a walkable tile beside it (the side to stand on). */
const FIND_DOOR = (skip: string) => `(() => {
  const g = cdda.game, m = g.map, p = g.player, skip = ${skip};
  let best = null, bd = 1e9;
  for (let dy = -40; dy <= 40; dy++) for (let dx = -40; dx <= 40; dx++) {
    const x = p.tileX + dx, y = p.tileY + dy;
    if (m.terAt(x, y, 0).id !== 't_door_c' || skip.some(([a, b]) => a === x && b === y)) continue;
    for (const [ex, ey] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const sx = x + ex, sy = y + ey;
      if (!m.passable(sx, sy, 0) || m.furnAt(sx, sy, 0).id !== 'f_null') continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = { door: [x, y], stand: [sx, sy] }; }
    }
  }
  return best;
})()`;

export function curtainsScenarios(c: CurtainsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const ter = (x: number, y: number) => js<string>(`cdda.game.map.terAt(${x}, ${y}, 0).id`);
  /** Stand on (sx, sy) looking level at (tx, ty) (setup only). */
  const stand = async (sx: number, sy: number, tx: number, ty: number) => {
    await js(`(() => { cdda.teleport(${sx} + 0.5, ${sy} + 0.5, 0); cdda.faceTile(${tx}, ${ty}); cdda.game.player.pitch = 0; cdda.step(0.05); })()`);
    // A teleport into town closes the load gate, which swallows `e` under its loading screen:
    // wait for the surroundings rather than a fixed pause.
    const w = await settleWorld(js);
    if (!w.ok) check('the surroundings finished loading (load gate open, chunks built)', false, w);
  };
  const menuText = () => js<string>(`[...document.querySelectorAll('.cdda-window')].map((w) => w.textContent).join(' | ')`);
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  /** Press `e`, then the menu letter of the entry labelled `label`. */
  const choose = async (label: string) => {
    await c.x().key('e');
    await sleep(300);
    const text = await menuText();
    const letter = await js<string | null>(`(() => {
      for (const row of document.querySelectorAll('.cdda-window .menu-entry[data-i]')) {
        const k = row.querySelector('.hotkey');
        if (k && (row.textContent || '').slice(k.textContent.length).trim().startsWith(${JSON.stringify(label)})) return k.textContent;
      }
      return null;
    })()`);
    check(`the \`e\` menu has "${label}"`, !!letter, text);
    await c.x().key(letter ?? 'Return');
    await sleep(400);
    return { text, letter };
  };

  // The finders search 40 tiles round the survivor, so start each scenario at the start town's
  // nearest house rather than wherever an earlier scenario left us (failed in a mixed batch).
  const toTown = () =>
    js(`(() => { const s = cdda.startLocation();
      const town = cdda.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
      cdda.teleportOmt(town.x, town.y); const h = cdda.findOmt('house', 40); cdda.teleportOmt(h.x, h.y, 0, 12, -1); cdda.step(0.2); })()`);

  return [
    ['curtains', 'a curtained window: e offers curtains and window apart; drawn curtains darken the room and hide it from outside; peek; save/load; outside only examine/pry', async () => {
      await toGameplay();
      await toTown();
      const s = await js<Spot | null>(FIND_WINDOW);
      check('found a curtained house window near the start', !!s, s);
      if (!s) return;
      const [wx, wy] = s.w;
      await js(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60); cdda.game.map.setTer(${wx}, ${wy}, 0, 't_window_domestic'); })()`);
      await stand(s.inside[0], s.inside[1], wx, wy);
      check('the prompt names the curtains, not the window', /Close the curtains/.test((await js<string>('cdda.prompt()')) ?? ''), await js('cdda.prompt()'));
      await shot('curtains_1_open_inside');
      const light0 = await js<number>(`cdda.lightAt(${s.inside[0]}, ${s.inside[1]}, 0)`);
      const h0 = await js<number>('cdda.audio.playSeq');

      // --- draw the curtains through the `e` menu
      const m1 = await choose('Close the curtains');
      check('`e` opens a menu with the curtains, the window and tear-down', /Close the curtains/.test(m1.text) && /Open the window/.test(m1.text) && /Tear down/.test(m1.text), m1);
      check('choosing "Close the curtains" draws them (t_curtains)', (await ter(wx, wy)) === 't_curtains', await ter(wx, wy));
      const light1 = await js<number>(`cdda.lightAt(${s.inside[0]}, ${s.inside[1]}, 0)`);
      check('the room is darker at once with the curtains drawn', light1 < light0, { light0, light1 });
      const swish = await js<Heard[]>(`cdda.audio.history.filter((e) => e.seq > ${h0}).map((e) => ({ id: e.id, variant: e.variant, outcome: e.outcome }))`);
      check('drawing the curtains swishes (synth_curtain played)', swish.some((e) => e.id === 'synth_curtain' && e.variant === 'close'), swish);
      await sleep(600);
      await shot('curtains_2_closed_inside');

      // --- outside: can't see in, can't work them
      await stand(s.outside[0], s.outside[1], wx, wy);
      check('from outside you can\'t see into the room', !(await js<boolean>(`cdda.canSee(${s.inside[0]}, ${s.inside[1]}, 0)`)));
      await shot('curtains_3_closed_outside');
      await c.x().key('e');
      await sleep(300);
      check('from outside `e` only examines: the curtains are drawn on the inside', /curtains are drawn/.test((await logTail(2)).join(' ')), await logTail(2));
      check('the window is untouched', (await ter(wx, wy)) === 't_curtains');

      // --- save / load keeps them drawn
      await js('cdda.save.save()');
      await js(`cdda.game.map.setTer(${wx}, ${wy}, 0, 't_window_domestic')`);
      await js('cdda.save.load()');
      await sleep(1500);
      check('a saved game keeps the curtains drawn', (await ter(wx, wy)) === 't_curtains', await ter(wx, wy));

      // --- back inside: peek, then open
      await stand(s.inside[0], s.inside[1], wx, wy);
      await choose('Peek through the curtains');
      const during = await ter(wx, wy);
      await sleep(7500);
      const after = await ter(wx, wy);
      check('peeking parts the curtains for a moment, then they fall back', during === 't_window_domestic' && after === 't_curtains', { during, after });
      await choose('Open the curtains');
      check('"Open the curtains" opens them', (await ter(wx, wy)) === 't_window_domestic');
      const light2 = await js<number>(`cdda.lightAt(${s.inside[0]}, ${s.inside[1]}, 0)`);
      check('daylight is back', light2 > light1, { light1, light2 });

      // --- the window itself
      await choose('Open the window');
      check('"Open the window" opens the window (t_window_open)', (await ter(wx, wy)) === 't_window_open');
      await sleep(600);
      await shot('curtains_4_window_open');
      await choose('Close the window');
      check('"Close the window" shuts it again', (await ter(wx, wy)) === 't_window_domestic');

      // --- from outside with the curtains open you see in
      await stand(s.outside[0], s.outside[1], wx, wy);
      check('with the curtains open, outside sees in', await js<boolean>(`cdda.canSee(${s.inside[0]}, ${s.inside[1]}, 0)`));
      await js('cdda.godMode(false)');
    }],

    ['smashsound', 'smash a door (X, melee swings) and a window: every logged "whump!" played a sample at the door; a zombie bashing a door is heard', async () => {
      await toGameplay();
      await toTown();
      await js(`(() => { cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60); cdda.giveItem('bat', { wield: true }); })()`);
      const smashes = async (x: number, y: number, since: number) =>
        js<Heard[]>(`cdda.audio.history.filter((e) => e.seq > ${since} && /^smash/.test(e.id) && e.pos && Math.floor(e.pos.x) === ${x} && Math.floor(e.pos.y) === ${y}).map((e) => ({ id: e.id, variant: e.variant, outcome: e.outcome, x: e.pos.x, y: e.pos.y }))`);

      // --- X (the smash key) on a door until it breaks
      const d1 = await js<{ door: [number, number]; stand: [number, number] } | null>(FIND_DOOR('[]'));
      check('found a closed wooden door', !!d1, d1);
      if (!d1) return;
      await stand(d1.stand[0], d1.stand[1], d1.door[0], d1.door[1]);
      await js('window.__smashLog = []; cdda.game.events.on("message", (m) => window.__smashLog.push(m.text))');
      let h0 = await js<number>('cdda.audio.playSeq');
      for (let i = 0; i < 20 && (await ter(d1.door[0], d1.door[1])) === 't_door_c'; i++) {
        await c.x().key('X');
        await sleep(1100);
      }
      let msgs = await js<string[]>('window.__smashLog');
      let heard = await smashes(d1.door[0], d1.door[1], h0);
      const whumps = msgs.filter((m) => /^whump!/.test(m)).length;
      check('X smashed the door open', (await ter(d1.door[0], d1.door[1])) !== 't_door_c', { msgs });
      check('every "whump!" in the log played a door knock (smash_fail/t_door_c, started)', whumps > 0 && heard.filter((h) => h.id === 'smash_fail' && h.variant === 't_door_c' && h.outcome === 'playing').length >= whumps, { whumps, heard });
      check('the blow that broke it played the door breaking', heard.some((h) => h.id === 'smash_success' && h.outcome === 'playing'), heard);
      await shot('smash_1_door_broken');

      // --- melee swings (LMB) on another door
      const d2 = await js<{ door: [number, number]; stand: [number, number] } | null>(FIND_DOOR(JSON.stringify([d1.door])));
      if (d2) {
        await stand(d2.stand[0], d2.stand[1], d2.door[0], d2.door[1]);
        await js('window.__smashLog = []');
        h0 = await js<number>('cdda.audio.playSeq');
        for (let i = 0; i < 4; i++) {
          await c.x().clickHere();
          await sleep(1300);
        }
        msgs = await js<string[]>('window.__smashLog');
        heard = await smashes(d2.door[0], d2.door[1], h0);
        const n = msgs.filter((m) => /^whump!|You smash/.test(m)).length;
        check('swinging a bat at a door: every blow is heard at the door', n > 0 && heard.filter((h) => h.outcome === 'playing').length >= n, { msgs, heard });
      } else check('found a second door for melee swings', false);

      // --- a window: glass breaking
      const s = await js<Spot | null>(FIND_WINDOW);
      if (s) {
        await js(`cdda.game.map.setTer(${s.w[0]}, ${s.w[1]}, 0, 't_window_domestic')`);
        await stand(s.inside[0], s.inside[1], s.w[0], s.w[1]);
        h0 = await js<number>('cdda.audio.playSeq');
        for (let i = 0; i < 8 && (await ter(s.w[0], s.w[1])) === 't_window_domestic'; i++) {
          await c.x().key('X');
          await sleep(1100);
        }
        heard = await smashes(s.w[0], s.w[1], h0);
        check('smashing a window plays the window breaking', heard.some((h) => h.id === 'smash_success' && h.variant === 't_window_domestic' && h.outcome === 'playing'), heard);
        await shot('smash_2_window_broken');
      }

      // --- a zombie bashing a door is heard at the door
      const d3 = await js<{ door: [number, number]; stand: [number, number] } | null>(FIND_DOOR(JSON.stringify([d1.door, d2?.door ?? [0, 0]])));
      if (d3) {
        h0 = await js<number>('cdda.audio.playSeq');
        await js(`(() => { const [dx, dy] = [${d3.door[0]}, ${d3.door[1]}], [sx, sy] = [${d3.stand[0]}, ${d3.stand[1]}];
          // you stand on the far side; the zombie on the near side, door between
          const ox = 2 * dx - sx, oy = 2 * dy - sy;
          cdda.teleport(ox + 0.5, oy + 0.5, 0);
          const p = cdda.game.player;
          const id = cdda.spawnMonster('mon_zombie', sx - ox, sy - oy);
          const m = cdda.game.monsters.all.find((z) => z.uid === id); if (m) m.anger = 100;
        })()`);
        let zh: Heard[] = [];
        for (let i = 0; i < 40 && !zh.length; i++) {
          // a shout now and then so it knows where you are behind the door
          if (i % 4 === 0) await js(`(() => { const p = cdda.game.player; cdda.emitSound(p.tileX, p.tileY, 0, 40, 'a shout'); })()`);
          await sleep(500);
          zh = await smashes(d3.door[0], d3.door[1], h0);
        }
        const where = await js(`cdda.game.monsters.all.filter((m) => !m.dead).map((m) => [m.type.id, Math.floor(m.x), Math.floor(m.y)]).slice(0, 3)`);
        check('a zombie bashing the door is heard at the door', zh.some((h) => h.outcome === 'playing'), { zh, where, door: d3.door, ter: await ter(d3.door[0], d3.door[1]) });
        await js('cdda.clearMonsters(60)');
      }
      await js('cdda.godMode(false)');
    }],
  ];
}
