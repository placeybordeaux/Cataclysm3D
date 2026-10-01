// Real-input skills-feedback scenario, run from tools/realinput.ts:
//   --only skills   open the inventory, right-click a toaster, Disassemble: the inventory closes, the
//                   mouse is captured and the activity runs at once; the practice cue says the toaster
//                   taught Electronics nothing and why. Then a curling iron (difficulty 1): the cue
//                   shows the gain. Then '@' → Skills: focus, "Recently trained", and hovering
//                   Electronics shows how to reach level 1 (src/ui/practice_cue.ts, docs/ADAPTATION.md).
//
// Keys and mouse are OS-level input; cdda.* only hands out the items, sets noon, clears monsters
// and reads state.

import type { XInput } from './lib/realinput';

export interface SkillsCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function skillsScenarios(c: SkillsCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const x = () => c.x();
  const state = () =>
    js<{ panels: string[]; lock: boolean; act: string | null; kind: string | null; elapsed: number; cue: string[][] }>(`(() => {
      const g = cdda.game, a = g.activities.current;
      return { panels: [...document.querySelectorAll('#ui2 .ui2-win')].map((w) => w.dataset.id ?? ''), lock: !!document.pointerLockElement,
        act: a ? a.spec.name : null, kind: a ? a.spec.kind ?? null : null, elapsed: a ? a.elapsed : 0, cue: cdda.practice.cue() };
    })()`);
  const until = async (f: (s: Awaited<ReturnType<typeof state>>) => boolean, ms: number) => {
    const end = Date.now() + ms;
    let s = await state();
    while (!f(s) && Date.now() < end) {
      await sleep(100);
      s = await state();
    }
    return s;
  };
  /** Centre of the inventory row showing `typeId` (the bn screen's rows carry the item's id). */
  const rowOf = (typeId: string) => js<{ x: number; y: number } | null>(`cdda.inv2.rectOf(${JSON.stringify(typeId)}, '#ui2')`);
  const menuRow = (re: string) =>
    js<{ x: number; y: number; note: string } | null>(`(() => {
      const e = [...document.querySelectorAll('#ui2 .ui2-menu-row')].find((r) => new RegExp(${JSON.stringify(re)}).test(r.querySelector('.ui2-menu-label > span')?.textContent ?? ''));
      if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left + Math.min(60, b.width / 2)), y: Math.round(b.top + b.height / 2), note: e.querySelector('.ui2-menu-note')?.textContent ?? '' };
    })()`);

  /** i → right-click the item → "Disassemble (…)" → back in the game with the work running. */
  const disassembleFromInventory = async (typeId: string, label: string) => {
    await x().key(await js<string>(`cdda.game.keys.keysFor('inventory2')[0]`));
    await sleep(800);
    const r = await rowOf(typeId);
    check(`${label}: the ${typeId} is in the inventory`, !!r, r);
    if (!r) return null;
    await x().click(r.x, r.y, 3);
    await sleep(400);
    const m = await menuRow('^Disassemble \\(');
    check(`${label}: its menu offers Disassemble`, !!m, m);
    if (!m) return null;
    await shot(`skills_${label}_menu`);
    await x().click(m.x, m.y);
    // Started at once: windows gone, mouse captured, the activity's clock moving.
    const s = await until((t) => !t.panels.length && t.lock && t.elapsed > 0, 2500);
    check(`${label}: the inventory closes and the mouse is captured again`, !s.panels.length && s.lock, s);
    check(`${label}: the disassembly is running right away`, s.kind === 'disassemble' && s.elapsed > 0, s);
    await sleep(600);
    await shot(`skills_${label}_running`);
    return m.note;
  };

  return [
    ['skills', 'disassemble from the inventory starts at once; the practice cue says what it trained (or why not); @ shows focus, recent practice and how to reach the next level', async () => {
      await toGameplay();
      await js(`(() => {
        cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60);
        cdda.giveItem('backpack', { wear: true });
        cdda.giveItem('screwdriver'); cdda.giveItem('toaster'); cdda.giveItem('curling_iron');
        cdda.game.player.setSkill('electronics', 0);
      })()`);
      // Look at the floor so the crosshair isn't on something with its own card.
      const d = await js<{ dp: number; sens: number }>(`({ dp: -0.9 - cdda.game.player.pitch, sens: cdda.game.mouseSensitivity })`);
      await x().move(0, -d.dp / d.sens, 6);
      await sleep(300);

      const note1 = await disassembleFromInventory('toaster', 'toaster');
      check('the toaster menu says it is too simple to train Electronics', note1 === 'Too simple to train Electronics (difficulty 0)', note1);
      let s = await until((t) => !t.act && t.cue.some((card) => card[0] === 'Disassembling the toaster'), 15000);
      check('the toaster comes apart', !s.act, s);
      const toasterCard = s.cue.find((card) => card[0] === 'Disassembling the toaster');
      check('the cue: Electronics, no practice, too simple', !!toasterCard && toasterCard.includes('Electronics: no practice, too simple to learn from'), s.cue);
      await shot('skills_toaster_cue');

      const note2 = await disassembleFromInventory('curling_iron', 'curling_iron');
      check('the curling iron menu says it trains Electronics', /^Trains Electronics up to level 2/.test(note2 ?? ''), note2);
      s = await until((t) => !t.act && t.cue.some((card) => card[0] === 'Disassembling the curling iron'), 15000);
      const ironCard = s.cue.find((card) => card[0] === 'Disassembling the curling iron');
      check('the cue shows the Electronics gain', !!ironCard && ironCard.some((r) => /^Electronics \+\d+% · \d+% to level 1$/.test(r)), s.cue);
      check('Electronics exercise went up', await js<boolean>(`(cdda.game.player.skills.electronics?.exercise ?? 0) > 0`));
      await shot('skills_curling_iron_cue');

      // '@' → Skills tab: focus, recently trained, hover Electronics for the how-to.
      await x().key('@');
      await sleep(700);
      for (let i = 0; i < 4; i++) {
        if (await js<boolean>(`!!document.querySelector('#ui2 .cs-skills')`)) break;
        await x().key('Right');
        await sleep(300);
      }
      const sheet = await js<string>(`document.querySelector('#ui2 .cs-skills')?.textContent ?? ''`);
      check('@ Skills shows focus and what trained Electronics recently', /Focus/.test(sheet) && /Recently trained: Electronics \(disassembling the curling iron\)/.test(sheet), sheet.slice(0, 300));
      const row = await js<{ x: number; y: number } | null>(`(() => { const e = document.querySelector('#ui2 .cs-skill[data-skill="electronics"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) }; })()`);
      check('the Electronics row is there', !!row, row);
      if (row) {
        await x().moveTo(row.x, row.y, 6);
        await sleep(1200);
        const tip = await js<string>(`[...document.querySelectorAll('.pcue-tip')].map((t) => t.textContent).join(' | ')`);
        check('hovering it says how to reach Electronics 1', /How to reach Electronics 1/.test(tip), tip);
        await shot('skills_charsheet_hint');
      }
      await toGameplay();

      // A level-up: Electronics a hair short of level 1, another curling iron → toast + cue row.
      await js(`(() => { cdda.giveItem('curling_iron'); cdda.game.player.skills.electronics.exercise = 9950; })()`);
      await disassembleFromInventory('curling_iron', 'levelup');
      s = await until((t) => !t.act, 15000);
      await sleep(300);
      const toasts = await js<string[]>(`[...document.querySelectorAll('#ui2 .ui2-toast-title')].map((t) => t.textContent)`);
      check('a level-up toast: Electronics is now level 1', toasts.includes('Electronics is now level 1'), toasts);
      check('…and the cue row says so', s.cue.some((card) => card.includes('Electronics reached level 1!')), s.cue);
      await shot('skills_levelup');

      // The one-line variant (Options > Practice feedback: Line), under the crosshair.
      await js(`(() => { cdda.practice.setMode('line'); cdda.giveItem('curling_iron'); })()`);
      await disassembleFromInventory('curling_iron', 'line');
      s = await until((t) => !t.act, 15000);
      await sleep(300);
      const line = await js<string>(`document.querySelector('#ui2 .pcue.pcue-line')?.textContent ?? ''`);
      check('the line variant shows one line under the crosshair', /^Disassembling the curling iron: Electronics \+(<1|\d+)% · (<1|\d+)% to level 2$/.test(line), line);
      await shot('skills_line_variant');
      await js(`cdda.practice.setMode('card')`);
    }],
  ];
}
