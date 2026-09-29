// The conversation panel (replaces the curses dialogue window): who you're talking to (portrait
// composited from the NPC's sprite, name, job, faction, how they feel about you), what's been
// said (scrollable history; the newest line types itself out, any key or click completes it)
// and numbered response buttons. Trials show their odds and what the roll uses; unavailable
// responses say why; hidden ones can be revealed with `?`. A job offer shows as a card.
//
// Two layouts, switched from the title bar (remembered): "scene" docks low and wide so the
// NPC stays visible in the world above it; "book" is a tall window with the history beside the
// answers. Talking is an inventory-type surface: it pauses time when the ui2 pause setting is
// on (the Accessible preset), like BN where talking takes no time.

import type { Dialogue } from '../game/talk';
import type { Npc } from '../game/npc';
import type { NpcSystem } from '../game/npcai';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import { attachTooltip, button, flashNote, h, openPanel, rememberedPosition, settings, type Panel, type Tone } from '../ui2';
import { chip, markup, plain, portrait } from './common';
import { keyToResponse, opinionWord, responseRow, trialOutcome, type ResponseRow } from './logic/dialogue';
import { revealSchedule, TEXT_SPEED_CPS, visibleCount, type TextSpeed } from './logic/typewriter';
import { factionName } from '../ui/npc_ui';
import { valueText } from './logic/missions';

export interface TalkCtx {
  game: Game;
  renderer: Renderer | null;
  sys: NpcSystem;
}

export type DialogueLayout = 'scene' | 'book';
const LAYOUT_KEY = 'cdda3d.ui2.dialogueLayout';
const SPEED_KEY = 'cdda3d.ui2.textSpeed';

function stored<T extends string>(key: string, allowed: readonly T[], dflt: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : dflt;
  } catch {
    return dflt;
  }
}
function store(key: string, v: string): void {
  try {
    localStorage.setItem(key, v);
  } catch {
    // not persisted
  }
}

export const dialoguePrefs = {
  get layout(): DialogueLayout {
    return stored<DialogueLayout>(LAYOUT_KEY, ['scene', 'book'], 'scene');
  },
  set layout(v: DialogueLayout) {
    store(LAYOUT_KEY, v);
  },
  get speed(): TextSpeed {
    return stored<TextSpeed>(SPEED_KEY, ['instant', 'fast', 'normal', 'slow'], 'normal');
  },
  set speed(v: TextSpeed) {
    store(SPEED_KEY, v);
  },
};

const ACTION_CHIP: Record<NonNullable<ResponseRow['action']>, [string, Tone]> = {
  trade: ['Trade', 'info'], hostile: ['Attack', 'bad'], mission: ['Job', 'accent'], follow: ['Orders', 'good'],
  leave: ['Leave', 'dim'], give: ['Items', 'warn'], action: ['Action', 'good'],
};

const MISSION_TOPICS = new Set(['TALK_MISSION_OFFER', 'TALK_MISSION_DESCRIBE', 'TALK_MISSION_DESCRIBE_URGENT']);

export interface DialogueHandle {
  panel: Panel;
  /** Pick a response by its position in the list (0-based), as a click would. */
  pick(i: number): void;
  /** Finish the typewriter now. */
  skip(): void;
  readonly typing: boolean;
}

export function openDialoguePanel(ctx: TalkCtx, d: Dialogue, onClose?: () => void): DialogueHandle {
  const { game, sys } = ctx;
  const n = d.npc;
  let layout = dialoguePrefs.layout;
  let sel = -1;
  let closedByUs = false;
  // Tones for the outcome lines we add to the shared log (trial results), by log index.
  const tones = new Map<number, Tone>();

  const layoutBtn = h('button', { class: 'ui2-iconbtn ix-layout-btn', title: '', text: '⇅' });
  attachTooltip(layoutBtn, () => `Layout: ${layout === 'scene' ? 'Scene (docked low, the world stays visible)' : 'Book (tall window, history beside the answers)'}. Click to switch.`);
  const pauseNote = h('span', { class: 'ix-pause-note' });
  const panel = openPanel({
    id: 'talk',
    title: `${n.displayName()}`,
    group: 'talk',
    pauses: true,
    titleExtras: [layoutBtn],
    footer: h('div', { class: 'ix-footer' }, h('span', { text: '1–9 answer · ↑↓ Enter · Space skip · ? unavailable answers · Esc leave' }), pauseNote),
    onKey,
    onClose: () => {
      stopTyping();
      if (!closedByUs) runAfter();
      onClose?.();
    },
  });
  panel.el.classList.add('ix-dlg-win');

  const who = h('div', { class: 'ix-dlg-who' });
  const history = h('div', { class: 'ix-dlg-history', attrs: { 'data-testid': 'dialogue-history' } });
  const card = h('div', { class: 'ix-dlg-card' });
  const answers = h('div', { class: 'ix-dlg-answers', attrs: { role: 'listbox', 'data-testid': 'dialogue-answers' } });
  const main = h('div', { class: 'ix-dlg-main' }, history, card, answers);
  const root = h('div', { class: 'ix-dlg' }, who, main);
  panel.body.append(root);
  panel.body.classList.add('ix-dlg-body');
  history.addEventListener('click', () => skip());

  layoutBtn.addEventListener('click', () => {
    layout = layout === 'scene' ? 'book' : 'scene';
    dialoguePrefs.layout = layout;
    applyLayout(true);
  });

  function applyLayout(recentre: boolean): void {
    root.classList.toggle('layout-scene', layout === 'scene');
    root.classList.toggle('layout-book', layout === 'book');
    panel.el.classList.toggle('ix-dlg-scene', layout === 'scene');
    panel.el.classList.toggle('ix-dlg-book', layout === 'book');
    // Default spots: the scene docks above the hotbar, the book sits centred.
    if (!recentre && rememberedPosition('talk')) return;
    requestAnimationFrame(() => {
      const r = panel.el.getBoundingClientRect();
      const x = (window.innerWidth - r.width) / 2;
      const y = layout === 'scene' ? window.innerHeight - r.height - Math.round(window.innerHeight * 0.04) : (window.innerHeight - r.height) / 2;
      panel.moveTo(x, y);
    });
  }

  // ---------------------------------------------------------------- who
  function renderWho(): void {
    const job = sys.nd.classes[n.classId]?.name;
    const op = opinionWord(n.op, n.isEnemy(), n.isAlly());
    const opChip = chip(op.word, op.tone);
    attachTooltip(opChip, () => `How ${n.name} feels about you.  Trust ${n.op.trust} · Fear ${n.op.fear} · Value ${n.op.value} · Anger ${n.op.anger}${n.op.owed ? ` · Owes you $${(n.op.owed / 100).toFixed(2)}` : ''}`);
    const w = n.inv.wielded;
    who.replaceChildren(
      portrait(game, ctx.renderer, n),
      h(
        'div',
        { class: 'ix-dlg-id' },
        h('div', { class: 'ix-dlg-name', text: n.name }),
        job ? h('div', { class: 'ix-dlg-job', text: job }) : null,
        h('div', { class: 'ix-dlg-tags' }, chip(factionName(sys, n), 'info'), opChip),
        h('div', { class: 'ix-dlg-wield' }, h('span', { class: 'ui2-dim', text: 'Holding ' }), h('span', { text: w ? plain(w.name()) : 'nothing' })),
      ),
    );
  }

  // ---------------------------------------------------------------- history + typewriter
  let animatedTo = 0;
  let typing: { nodes: Text[]; full: string[]; sched: number[]; start: number; raf: number; el: HTMLElement } | null = null;

  function renderHistory(): void {
    stopTyping();
    const log = d.log;
    const els: HTMLElement[] = [];
    let lastNpc = -1;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].who === 'npc') (lastNpc = i), (i = -1);
    log.forEach((l, i) => {
      if (l.who === 'npc') {
        const speech = l.text.startsWith('"');
        els.push(h('div', { class: `ix-line npc${speech ? '' : ' narration'}${i === lastNpc ? ' current' : ''}`, data: { i: String(i) } },
          speech ? h('span', { class: 'ix-speaker', text: n.name }) : null,
          h('span', { class: 'ix-said' }, markup(speech ? l.text.slice(1, l.text.endsWith('"') ? -1 : undefined) : l.text))));
      } else if (l.who === 'u') {
        els.push(h('div', { class: 'ix-line you' }, h('span', { class: 'ix-speaker', text: 'You' }), h('span', { class: 'ix-said' }, markup(l.text))));
      } else {
        els.push(h('div', { class: `ix-line info tone-${tones.get(i) ?? 'info'}` }, h('span', { text: l.text })));
      }
    });
    history.replaceChildren(...els);
    history.scrollTop = history.scrollHeight;
    // The newest NPC line types itself out once.
    if (lastNpc >= animatedTo) {
      animatedTo = log.length;
      const el = els[lastNpc]?.querySelector('.ix-said') as HTMLElement | null;
      if (el) startTyping(el);
    }
    animatedTo = Math.max(animatedTo, log.length);
  }

  function startTyping(el: HTMLElement): void {
    const cps = TEXT_SPEED_CPS[dialoguePrefs.speed];
    if (cps === Infinity) return;
    const nodes: Text[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) nodes.push(t as Text);
    const full = nodes.map((t) => t.data);
    const sched = revealSchedule(full.join(''), cps);
    for (const t of nodes) t.data = '';
    el.classList.add('typing');
    typing = { nodes, full, sched, start: performance.now(), raf: 0, el };
    const tick = () => {
      if (!typing) return;
      let left = visibleCount(typing.sched, performance.now() - typing.start);
      typing.nodes.forEach((t, i) => {
        const take = Math.min(left, typing!.full[i].length);
        if (t.data.length !== take) t.data = typing!.full[i].slice(0, take);
        left -= take;
      });
      // Follow the text as it grows (a long line would otherwise type below the fold).
      history.scrollTop = history.scrollHeight;
      if (left > 0 || visibleCount(typing.sched, performance.now() - typing.start) >= typing.sched.length) return stopTyping();
      typing.raf = requestAnimationFrame(tick);
    };
    typing.raf = requestAnimationFrame(tick);
  }

  function stopTyping(): void {
    if (!typing) return;
    cancelAnimationFrame(typing.raf);
    typing.nodes.forEach((t, i) => (t.data = typing!.full[i]));
    typing.el.classList.remove('typing');
    typing = null;
  }

  function skip(): void {
    stopTyping();
  }

  // ---------------------------------------------------------------- mission card
  function renderCard(): void {
    const m = MISSION_TOPICS.has(d.current) ? d.selectedMission() : undefined;
    const def = m ? sys.missions.def(m) : undefined;
    if (!m || !def) {
      card.replaceChildren();
      card.style.display = 'none';
      return;
    }
    card.style.display = '';
    card.replaceChildren(
      h('div', { class: 'ix-card-head' }, h('span', { class: 'ix-card-kind', text: def.urgent ? 'URGENT JOB' : 'JOB OFFER' }), h('span', { class: 'ix-card-name', text: def.name })),
      h('div', { class: 'ix-card-goal', text: sys.missions.goalText(m).replace(/ \(have \d+\)$/, '').replace(/ \(0 so far\)$/, '') }),
      h('div', { class: 'ix-card-facts' },
        chip(`Worth ${valueText(def.value ?? 0)}`, 'accent', 'What the job is worth to them (BN mission value)'),
        def.difficulty ? chip(`Difficulty ${def.difficulty}`, def.difficulty >= 5 ? 'bad' : def.difficulty >= 3 ? 'warn' : 'good') : null,
        def.deadline !== undefined ? chip('Has a deadline', 'warn') : null,
      ),
      h('div', { class: 'ix-card-hint', text: 'Accepted jobs go to your mission log (' + game.keys.keyFor('missions') + ').' }),
    );
  }

  // ---------------------------------------------------------------- answers
  let rows: ResponseRow[] = [];
  function renderAnswers(): void {
    const v = d.view();
    rows = v.responses.map(responseRow);
    if (sel >= rows.length) sel = rows.length - 1;
    answers.replaceChildren(
      ...rows.map((r, i) => {
        const act = r.action ? ACTION_CHIP[r.action] : null;
        const b = h(
          'button',
          { class: `ix-resp${r.unavailable ? ' unavailable' : ''}${r.hidden ? ' hidden-opt' : ''}${i === sel ? ' sel' : ''}${r.tone ? ` tone-${r.tone}` : ''}`, data: { i: String(i) }, attrs: { role: 'option' } },
          h('kbd', { class: 'ix-resp-key', text: r.key ?? '·' }),
          h('span', { class: 'ix-resp-text' }, markup(r.text), r.unavailable ? h('span', { class: 'ix-resp-why', text: r.unavailable }) : null),
          h('span', { class: 'ix-resp-chips' }, r.chip ? chip(r.chip.label, r.chip.tone) : null, act ? chip(act[0], act[1]) : null),
        );
        if (r.chip) attachTooltip(b, () => r.chip!.detail);
        else if (r.unavailable) attachTooltip(b, () => r.unavailable!);
        b.addEventListener('click', (e) => pick(i, e));
        b.addEventListener('pointermove', () => {
          if (sel !== i) {
            sel = i;
            answers.querySelectorAll('.ix-resp').forEach((el, j) => el.classList.toggle('sel', j === sel));
          }
        });
        return b;
      }),
    );
  }

  function render(): void {
    renderWho();
    renderAnswers(); // first: view() may add the NPC's new line to the log
    renderHistory();
    renderCard();
    pauseNote.textContent = settings.pauseInInventory ? '⏸ Time is paused' : '▶ Time keeps running';
  }

  // ---------------------------------------------------------------- choosing
  function runAfter(): void {
    const after = [...d.after];
    d.after.length = 0;
    for (const f of after) f();
  }

  function finish(): void {
    closedByUs = true;
    panel.close();
    // Effects that open their own windows (trade) run once the dialogue is gone.
    runAfter();
  }

  function pick(i: number, e?: MouseEvent): void {
    const r = rows[i];
    const view = d.view().responses[i];
    if (!r || !view) return;
    if (r.unavailable) {
      const b = answers.children[i] as HTMLElement | undefined;
      const at = e ? { x: e.clientX, y: e.clientY } : b ? { x: b.getBoundingClientRect().left + 80, y: b.getBoundingClientRect().top } : { x: 0, y: 0 };
      flashNote(at.x, at.y, r.unavailable, 'bad');
      b?.classList.add('shake');
      setTimeout(() => b?.classList.remove('shake'), 260);
      return;
    }
    stopTyping();
    const res = d.choose(view.index);
    if (res.trial) {
      const o = trialOutcome(res.trial.kind, res.trial.chance, res.trial.success);
      d.log.push({ who: 'info', text: o.text });
      tones.set(d.log.length - 1, o.tone);
    }
    sel = -1;
    if (d.done) {
      const line = d.view().line;
      if (line && d.current === 'TALK_DONE') game.message(`${n.name}: ${plain(line)}`, 'c_white');
      finish();
      return;
    }
    // Mid-conversation trades (start_trade that returns to a topic) open over the dialogue.
    runAfter();
    if (!panel.closed) render();
  }

  function onKey(e: KeyboardEvent): boolean {
    if (e.repeat) return true;
    const i = keyToResponse(e.key, rows.length);
    if (i >= 0) return pick(i), true;
    if (e.key === ' ') return skip(), true;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sel = rows.length ? (sel + (e.key === 'ArrowDown' ? 1 : rows.length - 1) + (sel < 0 && e.key === 'ArrowUp' ? 1 : 0)) % rows.length : -1;
      answers.querySelectorAll('.ix-resp').forEach((el, j) => el.classList.toggle('sel', j === sel));
      (answers.children[sel] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (e.key === 'Enter') {
      if (typing) return skip(), true;
      if (sel >= 0) pick(sel);
      return true;
    }
    if (e.key === '?') {
      d.showHidden = !d.showHidden;
      d.refresh();
      render();
      return true;
    }
    // Esc always leaves (a second press to "really" leave would feel broken).
    if (e.key === 'Escape' || e.key === 'Backspace') return finish(), true;
    // Everything else is swallowed: letters must not reach gameplay mid-conversation.
    return true;
  }

  applyLayout(false);
  render();
  return {
    panel,
    pick: (i) => pick(i),
    skip,
    get typing() {
      return !!typing;
    },
  };
}

export type { Npc };
