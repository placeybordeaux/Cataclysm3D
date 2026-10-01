// Real-input reading-minigame scenarios (src/game/readquiz/, src/ui/readquiz.ts,
// docs/ADAPTATION.md "Reading: field notes"), run from tools/realinput.ts:
//   --only readquiz     R opens the read menu, pick a cookbook: a field-notes question comes up
//                       by the crosshair; the right number key jumps the chapter forward, a
//                       wrong one marks the right answer and holds the next question ~5 s; a
//                       left click frees the cursor and an answer is clicked with the mouse
//                       (mouse-look comes back after); a zombie walks into view → reading stops,
//                       the card goes away
//   --only readskim     Options > Reading = Skim: catch a key term in the lens with 1
//   --only readknown    a cookbook you've outgrown: "Skim it?" → 1 → done at once, no skill
//
// Keys and mouse are OS-level input; cdda.* only sets the hour, clears/spawns monsters, gives
// books, sets skills, switches the Reading option and reads state.

import type { XInput } from './lib/realinput';

export interface ReadQuizCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];
interface RqState {
  mode: string;
  phase: string | null;
  frozen: string | null;
  question: { prompt: string; options: string[]; answer: number; template: string } | null;
  picked: number;
  totals: { right: number; wrong: number; hits: number; misses: number; skippedS: number; skims: number };
  lastReward: { skippedS: number; practice: number } | null;
  engaged: boolean;
  visible: boolean;
  skim: { off: number; inLens: string | null; inLensKey: boolean; cooldownMs: number } | null;
}

export function readquizScenarios(c: ReadQuizCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const rq = () => js<RqState>('cdda.readquiz.state()');
  const book = () => js<{ id: string; fraction: number; elapsed: number; duration: number } | null>('cdda.readquiz.book()');
  const logTail = (n = 4) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  const until = async (f: (s: RqState) => boolean, ms = 8000) => {
    const t0 = Date.now();
    let s = await rq();
    while (!f(s) && Date.now() - t0 < ms) {
      await sleep(80);
      s = await rq();
    }
    return s;
  };
  // Noon in an open field (a zombie 15 tiles away is in plain view), nothing hostile around.
  const safeSpot = () => js(`(() => { const f = cdda.findOmt('field', 40); if (!f) throw new Error('no field near the start');
    cdda.teleportOmt(f.x, f.y, 0); cdda.setHour(12); cdda.clearMonsters(200); cdda.godMode(false); cdda.step(0.3); })()`);
  const setGame = (g: string) => js(`localStorage.setItem('cdda3d.reading', ${JSON.stringify(g)})`);

  /** R, then the menu letter of the entry whose label starts with `label`. */
  const readBook = async (label: string) => {
    await c.x().key('R');
    await sleep(400);
    const letter = await js<string | null>(`(() => {
      for (const row of document.querySelectorAll('.cdda-window .menu-entry[data-i]')) {
        const k = row.querySelector('.hotkey');
        if (k && (row.textContent || '').slice(k.textContent.length).trim().startsWith(${JSON.stringify(label)})) return k.textContent;
      }
      return null;
    })()`);
    check(`the read menu lists "${label}"`, !!letter, await js(`[...document.querySelectorAll('.cdda-window')].map((w) => w.textContent).join(' | ').slice(0, 300)`));
    await c.x().key(letter ?? 'Return');
    await sleep(300);
  };
  const cardBox = () => js<{ x: number; y: number; w: number; h: number } | null>(`(() => { const e = document.querySelector('[data-testid="readquiz"]'); if (!e || e.style.display === 'none') return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);

  return [
    ['readquiz', 'cookbook: a question by the crosshair; right key → chapter jumps, wrong key → answer shown + ~5 s cooldown, click-to-engage mouse answer, a zombie stops it all', async () => {
      await toGameplay();
      await safeSpot();
      await setGame('quiz');
      await js(`(() => { cdda.game.player.setSkill('cooking', 0); return cdda.giveItem('cookbook'); })()`);
      await js('cdda.clearMonsters(200)');
      await readBook('Cooking on a Budget');
      let s = await until((t) => t.phase === 'ask');
      check('a field-notes question comes up while reading', s.phase === 'ask' && !!s.question, s);
      check('…on a visible card', s.visible && !!(await cardBox()), await cardBox());
      if (s.phase !== 'ask' || !s.question) return;
      await shot('readquiz_1_question');

      // Right answer with its number key.
      const b0 = (await book())!;
      await c.x().key(String(s.question.answer + 1));
      await sleep(120);
      const b1 = await book();
      s = await rq();
      check('the right number key: "Right!"', s.phase === 'right' && s.totals.right === 1, s);
      const natural = 0.4 * (b0.duration / 4); // generous: progress in ~0.4 s of a 2–8 s chapter
      check('…and the chapter jumped forward', !!s.lastReward && s.lastReward.skippedS > 0 && (!b1 || b1.id !== b0.id || b1.elapsed - b0.elapsed > Math.min(natural, s.lastReward.skippedS * 0.8) || b1.elapsed < b0.elapsed), { b0, b1, reward: s.lastReward });
      check('the hotbar did not take the key (no weapon switch message)', !(await logTail(2)).some((l) => /You (wield|put away)/.test(l)), await logTail(2));
      await shot('readquiz_2_right');

      // Wrong answer: the right one is marked, and the next question waits.
      s = await until((t) => t.phase === 'ask');
      check('the next question follows', s.phase === 'ask', s);
      if (!s.question) return;
      const wrong = (s.question.answer + 1) % s.question.options.length;
      const e0 = (await book())?.elapsed ?? 0;
      await c.x().key(String(wrong + 1));
      await sleep(150);
      s = await rq();
      check('a wrong key: "Not quite", the right answer marked', s.phase === 'wrong' && s.picked === wrong && s.totals.wrong === 1, s);
      const marked = await js<{ right: string | null; wrong: string | null }>(`({ right: document.querySelector('.rq-opt.rq-right .rq-opt-text')?.textContent ?? null, wrong: document.querySelector('.rq-opt.rq-wrong .rq-opt-text')?.textContent ?? null })`);
      check('…the card shows both (green right, struck-out pick)', marked.right === s.question!.options[s.question!.answer] && marked.wrong === s.question!.options[wrong], marked);
      const e1 = (await book())?.elapsed ?? 0;
      check('…no jump for a wrong answer', e1 - e0 < natural, { e0, e1 });
      await shot('readquiz_3_wrong');
      const t0 = Date.now();
      await sleep(3800);
      s = await rq();
      check('no new question during the cooldown (~4 s later)', s.phase !== 'ask', s);
      s = await until((t) => t.phase === 'ask', 4000);
      const cooldown = (Date.now() - t0) / 1000;
      check('the next question comes after ~5 s', s.phase === 'ask' && cooldown > 4.2 && cooldown < 7, { cooldown, s });
      if (!s.question) return;

      // The mouse: a left click frees the cursor (no attack), then click the right answer.
      const lockedBefore = await js<boolean>('cdda.game.input.locked');
      check('mouse-look is on while the question is up', lockedBefore, lockedBefore);
      await c.x().clickHere(1);
      await sleep(250);
      s = await rq();
      const freed = await js<boolean>('!cdda.game.input.locked');
      check('a left click engages the card: cursor free, reading goes on', s.engaged && freed && (await book()) !== null, { s, freed });
      const btn = await js<{ x: number; y: number } | null>(`(() => { const e = document.querySelectorAll('.rq-opt')[${s.question?.answer ?? 0}]; if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
      check('the answer button is on screen', !!btn, btn);
      if (btn) {
        await c.x().moveTo(btn.x, btn.y, 6);
        await shot('readquiz_4_mouse');
        await c.x().click(btn.x, btn.y);
        await sleep(300);
        s = await rq();
        check('clicking the right answer: "Right!"', s.totals.right === 2, s);
        const relocked = await until(() => true, 10).then(() => js<boolean>('cdda.game.input.locked'));
        check('…and mouse-look is back (no extra click needed)', !s.engaged && relocked, { s, relocked });
      }

      // A zombie walks into view: the reading stops, the card goes.
      await until((t) => t.phase === 'ask', 4000);
      await js(`cdda.spawnMonster('mon_zombie', 0, -15)`);
      let stopped = false;
      for (let i = 0; i < 40 && !stopped; i++) {
        await sleep(100);
        stopped = (await book()) === null;
      }
      s = await rq();
      check('a zombie in view stops the reading', stopped, await logTail(3));
      check('…and the field-notes card is gone', !s.visible && s.phase === null, s);
      await shot('readquiz_5_zombie');
      await js('cdda.clearMonsters(200)');
    }],

    ['readskim', 'Options > Reading = Skim: the strip drifts, 1 catches a key term in the lens and jumps the chapter', async () => {
      await toGameplay();
      await safeSpot();
      await setGame('skim');
      await js(`(() => { cdda.game.player.setSkill('cooking', 0); return cdda.giveItem('cookbook'); })()`);
      await js('cdda.clearMonsters(200)');
      await readBook('Cooking on a Budget');
      let s = await until((t) => t.phase === 'skim' && !!t.skim);
      check('the skim strip is up', s.mode === 'skim' && !!s.skim && s.visible, s);
      s = await until((t) => !!t.skim?.inLensKey, 15000);
      check('a key term drifts into the lens', !!s.skim?.inLensKey, s.skim);
      await shot('readskim_1_strip');
      await c.x().key('1');
      await sleep(150);
      s = await rq();
      check('1 catches it: a hit, the chapter jumps', s.totals.hits === 1 && (s.lastReward?.skippedS ?? 0) > 0, s);
      await shot('readskim_2_hit');
      s = await until((t) => !!t.skim && !t.skim.inLensKey && !!t.skim.inLens, 15000);
      await c.x().key('1');
      await sleep(150);
      s = await rq();
      check('1 on filler: you lose your place for a moment', s.totals.misses === 1 && (s.skim?.cooldownMs ?? 0) > 0, s);
      await shot('readskim_3_miss');
      await c.x().hold('w', 350);
      await sleep(200);
      check('walking stops the reading', (await book()) === null, await logTail(2));
      await setGame('quiz');
    }],

    ['readknown', 'a cookbook you have outgrown: "Skim it?" → 1 → done at once, recipes kept, no skill', async () => {
      await toGameplay();
      await safeSpot();
      await setGame('quiz');
      await js(`(() => { cdda.game.player.setSkill('cooking', 3); return cdda.giveItem('cookbook'); })()`);
      await js('cdda.clearMonsters(200)');
      await readBook('Cooking on a Budget');
      let s = await until((t) => t.phase === 'offer');
      check('"You know everything … teaches. Skim it?"', s.phase === 'offer' && s.visible, s);
      await shot('readknown_1_offer');
      const t0 = Date.now();
      await c.x().key('1');
      let done = false;
      for (let i = 0; i < 30 && !done; i++) {
        await sleep(100);
        done = (await book()) === null;
      }
      const took = (Date.now() - t0) / 1000;
      const log = await logTail(6);
      check('1 skims it: finished almost at once', done && took < 1.5, { took, log });
      check('…"You finish reading."', log.some((l) => /You finish reading/.test(l)), log);
      check('…no skill gained', (await js<number>(`cdda.game.player.getSkill('cooking')`)) === 3, await js(`cdda.game.player.getSkill('cooking')`));
      s = await rq();
      check('…the card is gone', !s.visible, s);
    }],
  ];
}
