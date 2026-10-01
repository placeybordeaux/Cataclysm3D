// The reading minigame's card (src/game/readquiz/, docs/ADAPTATION.md "Reading: field notes"):
// a compact panel to the right of the crosshair while you read.
//
// Options > Reading: Field notes (default) · Skim · Off.  ?reading=quiz|skim|off for a session.
//
// Input, without stealing mouse-look:
//  * number keys 1–4 answer (skim: 1 grabs what's in the lens). They only mean that while a
//    question is up and no menu is open; otherwise they do what they always do (the hotbar).
//  * the mouse: reading is a stand-still job, so mouse-look stays on until you *engage*: a left
//    click while a question is up frees the cursor (it never attacks) and the card takes the
//    clicks. Answering, clicking off the card or pressing a movement key gives mouse-look back.
//    Without pointer lock (free-cursor menus, automation) the buttons are simply clickable.
//  * moving still stops reading, engaged or not; interrupts close the card with the activity.

import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { DebugApi } from '../debug';
import { loadVehicleData } from '../game/vehicle_data';
import { ReadQuizController } from '../game/readquiz/controller';
import { setQuizVehicles } from '../game/readquiz/questions';
import { READING_GAMES, TUNING, type ReadingGame } from '../game/readquiz/session';
import { bookData } from '../game/reading';
import { cddaText } from '../game/units';
import { h, ui2Layers } from '../ui2';
import { fmtDuration } from '../ui2/logic/items';
import { surfacesOpen } from '../ui2/host';
import { registerOption } from './options';
import './readquiz.css';

const KEY = 'cdda3d.reading';
const LABEL: Record<ReadingGame, string> = { quiz: 'Field notes', skim: 'Skim', off: 'Off' };

export function readingGame(): ReadingGame {
  const q = new URLSearchParams(location.search).get('reading');
  if (q !== null) {
    if (!(READING_GAMES as string[]).includes(q)) throw new Error(`?reading=${q}: expected one of ${READING_GAMES.join(', ')}`);
    return q as ReadingGame;
  }
  try {
    const s = localStorage.getItem(KEY);
    if (s && (READING_GAMES as string[]).includes(s)) return s as ReadingGame;
  } catch {
    // storage blocked: default
  }
  return 'quiz';
}

const DIGITS: Record<string, number> = { Digit1: 0, Digit2: 1, Digit3: 2, Digit4: 3, Numpad1: 0, Numpad2: 1, Numpad3: 2, Numpad4: 3 };
const MOVE = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD']);

let registered = false;

/** Width of one character of the strip's font, px (measured once per font size). */
const glyphCache = new Map<string, number>();
function glyphWidth(strip: HTMLElement): number {
  const fs = getComputedStyle(strip).fontSize;
  let w = glyphCache.get(fs);
  if (w === undefined) {
    const probe = h('span', { class: 'rq-word', text: 'x'.repeat(20) });
    probe.style.visibility = 'hidden';
    strip.appendChild(probe);
    w = probe.getBoundingClientRect().width / 20 || 8;
    probe.remove();
    if (w > 0) glyphCache.set(fs, w);
  }
  return w;
}

export function installReadQuiz(game: Game, renderer?: Renderer, api?: DebugApi): ReadQuizController {
  if (!registered) {
    registered = true;
    registerOption({
      name: 'Reading',
      value: () => LABEL[readingGame()],
      change: (d) => {
        const i = READING_GAMES.indexOf(readingGame());
        try {
          localStorage.setItem(KEY, READING_GAMES[(i + (d ?? 1) + READING_GAMES.length) % READING_GAMES.length]);
        } catch {
          // not persisted
        }
      },
      desc: 'While you read a skill book. Field notes: questions about what the book teaches pop up by the crosshair; a right answer (1–4 or click) skips some reading, a wrong one shows the answer. Skim: catch the book\'s key terms as they drift through the lens. Off: just read. Ignoring them never slows you down.',
    });
  }
  // The vehicle questions (what an engine runs on, what a car needs) need vehicles.json.
  void loadVehicleData().then((v) => setQuizVehicles(game.data, v)).catch((e) => console.warn('[readquiz] no vehicle data:', e));

  const qc = new ReadQuizController(game, readingGame);
  const card = h('div', { class: 'rq-card', data: { testid: 'readquiz' } });
  card.style.display = 'none';
  ui2Layers().hud.appendChild(card);

  // ---- engaging the mouse
  let release: (() => void) | null = null;
  const engaged = () => !!release;
  const disengage = (relock: boolean) => {
    if (!release) return;
    release();
    release = null;
    card.classList.remove('engaged');
    // Only inside a user gesture (a click, a key): otherwise the "click to resume" hint covers it.
    if (relock) game.input.tryLock();
  };
  const choose = (i: number) => {
    if (qc.skim && qc.quiz?.phase !== 'offer') qc.press();
    else qc.answer(i);
    render(true);
  };
  const engage = () => {
    if (release) return;
    game.input.releaseForMenu();
    // timeFlows: reading goes on (no pause) while the card has the keyboard.
    release = game.input.capture((e) => {
      if (e.code in DIGITS && qc.live()) {
        choose(DIGITS[e.code]);
        disengage(true);
        return true;
      }
      if (MOVE.has(e.code)) {
        // A captured keyboard hides movement from the activity: stop reading as walking would.
        disengage(true);
        const a = game.activities.current;
        if (a?.spec.kind === 'read') game.activities.cancel(`You stop ${a.spec.name}.`);
        return true;
      }
      disengage(true);
      return e.key === 'Escape' ? true : false;
    }, { timeFlows: true });
    card.classList.add('engaged');
  };
  // Capture phase on window: runs before the canvas's own mousedown (which would attack).
  window.addEventListener(
    'mousedown',
    (e) => {
      if (engaged()) {
        if (!card.contains(e.target as Node)) {
          e.preventDefault();
          e.stopImmediatePropagation();
          disengage(true);
        }
        return;
      }
      if (e.button !== 0 || !game.input.locked || game.input.captured || !qc.live() || card.style.display === 'none') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      engage();
    },
    true,
  );
  game.input.onPriorityPress((e) => {
    if (game.input.captured || !(e.code in DIGITS) || e.repeat || !qc.live() || card.style.display === 'none') return false;
    choose(DIGITS[e.code]);
    return true;
  });

  // ---- drawing
  let last = performance.now();
  let lastKey = '';
  const visible = () => {
    const p = game.player;
    return !p.dead && !p.isAsleep() && (surfacesOpen() === 0 || engaged()) && (!game.input.captured || engaged());
  };
  const paused = () => game.paused || game.tacticalPause || game.lockPaused || (game.input.captured && !game.input.captureTimeFlows);

  const option = (i: number, text: string, cls: string) =>
    h('button', { class: `rq-opt ${cls}`, data: { i: String(i) }, on: { click: () => (choose(i), disengage(true)) } }, h('span', { class: 'rq-key', text: String(i + 1) }), h('span', { class: 'rq-opt-text', text }));

  const render = (force = false) => {
    const q = qc.quiz;
    const s = qc.skim;
    if ((!q && !s) || !visible()) {
      card.style.display = 'none';
      lastKey = '';
      if (engaged() && !qc.quiz && !qc.skim) disengage(false);
      return;
    }
    card.style.display = '';
    const book = game.activities.current?.spec.target as { def?: { name?: unknown } } | undefined;
    const title = cddaText(book?.def?.name);
    const reward = qc.lastReward && qc.now - qc.lastReward.at < 1600 ? qc.lastReward : null;
    const gain = reward ? `+${fmtDuration(reward.skippedS)} of reading${reward.practice ? ' · +practice' : ''}` : '';
    const head = (right: string) => h('div', { class: 'rq-head' }, h('span', { class: 'rq-label', text: s ? 'Skimming' : 'Field notes' }), h('span', { class: 'rq-hint', text: right }));

    if (q?.phase === 'offer') {
      const key = `offer|${title}`;
      if (key === lastKey && !force) return;
      lastKey = key;
      card.dataset.phase = 'offer';
      card.replaceChildren(
        head(''),
        h('div', { class: 'rq-prompt', text: `You know everything ${title} teaches. Skim it?` }),
        h('div', { class: 'rq-opts' }, option(0, 'Skim it (done in a moment)', 'rq-pick'), option(1, 'Read it anyway', '')),
        h('div', { class: 'rq-foot', text: 'Skimming still memorises its recipes.' }),
      );
      return;
    }
    if (qc.frozen === 'fast') {
      const key = 'fast';
      if (key === lastKey && !force) return;
      lastKey = key;
      card.dataset.phase = 'fast';
      card.replaceChildren(head(''), h('div', { class: 'rq-foot', text: `${s ? 'Skimming' : 'Field notes'} wait while time runs fast.` }));
      return;
    }
    if (s) return renderSkim(head, gain);
    if (!q) return;
    const ph = q.phase;
    const qq = q.question;
    const next = Math.ceil(q.nextInMs() / 1000);
    const key = `${ph}|${qq?.prompt}|${q.picked}|${ph === 'wait' || ph === 'wrong' ? next : ''}|${gain}|${engaged()}`;
    if (key === lastKey && !force) return;
    lastKey = key;
    card.dataset.phase = ph;
    if (ph === 'wait' || ph === 'done' || !qq) {
      // Between questions: one quiet line (nothing at all during the first lead-in).
      if (ph === 'done' || (qc.totals.right + qc.totals.wrong === 0 && !gain)) {
        card.style.display = 'none';
        return;
      }
      const parts = [head(''), gain ? h('div', { class: 'rq-gain', text: gain }) : null, h('div', { class: 'rq-foot', text: next > 0 ? `Next note in ${next} s` : 'Next note…' })];
      card.replaceChildren(...(parts.filter(Boolean) as HTMLElement[]));
      return;
    }
    const opts = qq.options.map((o, i) => {
      let cls = '';
      if (ph === 'right' && i === q.picked) cls = 'rq-right';
      if (ph === 'wrong') cls = i === qq.answer ? 'rq-right' : i === q.picked ? 'rq-wrong' : 'rq-dim';
      if (ph === 'right' && i !== q.picked) cls = 'rq-dim';
      return option(i, o, cls);
    });
    const hint = ph === 'ask' ? (engaged() ? 'click an answer' : game.input.locked ? `1–${qq.options.length} · click to use the mouse` : `1–${qq.options.length} or click`) : '';
    const verdict = ph === 'right' ? h('div', { class: 'rq-gain', text: `Right! ${gain}` }) : ph === 'wrong' ? h('div', { class: 'rq-miss', text: `Not quite. Next note in ${next} s` }) : null;
    const explain = ph === 'right' || ph === 'wrong' ? h('div', { class: 'rq-explain', text: qq.explain }) : null;
    card.replaceChildren(...([head(hint), h('div', { class: 'rq-prompt', text: qq.prompt }), h('div', { class: 'rq-opts' }, ...opts), verdict, explain].filter(Boolean) as HTMLElement[]));
  };

  // ---- skim strip
  let strip: HTMLElement | null = null;
  let stripWords = new Map<object, HTMLElement>();
  const renderSkim = (head: (r: string) => HTMLElement, gain: string) => {
    const s = qc.skim!;
    if (card.dataset.phase !== 'skim' || !strip) {
      card.dataset.phase = 'skim';
      strip = h('div', { class: 'rq-strip' }, h('div', { class: 'rq-lens' }));
      stripWords = new Map();
      card.replaceChildren(
        head(game.input.locked ? '1 grabs · click to use the mouse' : '1 or click a key term'),
        strip,
        h('div', { class: 'rq-gain rq-skim-gain' }),
        h('div', { class: 'rq-foot', text: 'Catch the highlighted terms as they pass the lens. Filler loses your place.' }),
      );
      lastKey = 'skim';
    }
    // Positions are in characters; the pixel font is monospaced, so one measured glyph sizes
    // the strip (how many characters it shows) and the lens.
    const charW = glyphWidth(strip);
    const fit = Math.max(20, Math.floor(strip.clientWidth / charW));
    if (fit !== s.width) s.width = fit;
    const lens = strip.querySelector<HTMLElement>('.rq-lens')!;
    lens.style.width = `${Math.round(2 * TUNING.skimLens * charW)}px`;
    lens.style.left = `${Math.round((s.width / 2 - TUNING.skimLens) * charW)}px`;
    const seen = new Set<object>();
    s.words.forEach((w, i) => {
      seen.add(w);
      let el = stripWords.get(w);
      if (!el) {
        el = h('span', { class: `rq-word${w.key ? ' rq-term' : ''}`, text: w.text, on: { click: () => (qc.clickWord(qc.skim!.words.indexOf(w)), disengage(true)) } });
        strip!.appendChild(el);
        stripWords.set(w, el);
      }
      el.dataset.i = String(i);
      el.style.transform = `translateX(${Math.round((w.x - s.off) * charW)}px)`;
      el.classList.toggle('rq-hit', w.hit);
      el.classList.toggle('rq-wrong', w.wrong);
    });
    for (const [w, el] of stripWords) if (!seen.has(w)) el.remove(), stripWords.delete(w);
    strip.classList.toggle('rq-cool', s.cooldownMs > 0);
    const g = card.querySelector<HTMLElement>('.rq-skim-gain')!;
    const text = s.cooldownMs > 0 ? `Lost your place… ${Math.ceil(s.cooldownMs / 1000)} s` : gain;
    if (g.textContent !== text) g.textContent = text;
    g.classList.toggle('rq-miss', s.cooldownMs > 0);
  };

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    const dt = Math.min(250, now - last);
    last = now;
    qc.update(dt, paused() || !visible());
    render();
    if (engaged() && !qc.live() && qc.quiz?.phase !== 'offer') disengage(false);
  };
  requestAnimationFrame(frame);

  if (api) {
    /** The reading minigame (setup/inspection only: QA answers with real keys and clicks). */
    api.readquiz = {
      state: () => ({
        mode: readingGame(),
        phase: qc.quiz?.phase ?? (qc.skim ? 'skim' : null),
        frozen: qc.frozen,
        question: qc.quiz?.question ? { prompt: qc.quiz.question.prompt, options: qc.quiz.question.options, answer: qc.quiz.question.answer, template: qc.quiz.question.template } : null,
        picked: qc.quiz?.picked ?? -1,
        totals: { ...qc.totals },
        lastReward: qc.lastReward,
        engaged: engaged(),
        visible: card.style.display !== 'none',
        skim: qc.skim ? { off: qc.skim.off, inLens: qc.skim.inLens()?.text ?? null, inLensKey: !!qc.skim.inLens()?.key, cooldownMs: qc.skim.cooldownMs } : null,
      }),
      book: () => {
        const a = game.activities.current;
        const it = a?.spec.kind === 'read' ? (a.spec.target as Parameters<typeof bookData>[0]) : null;
        return it ? { id: it.typeId, fraction: a!.fraction, elapsed: a!.elapsed, duration: a!.spec.duration } : null;
      },
    };
  }
  return qc;
}
