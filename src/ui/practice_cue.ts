import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import { DrivingPractice } from '../game/driving_practice';
import { ambient, practiceListeners, practiceSettings } from '../game/practice';
import { skillHints } from '../game/skill_hints';
import { attachTooltip, h, toast, ui2Layers } from '../ui2';
import { registerOption } from './options';
import { PracticeFeed, rowText, type CueCard } from './practice_feed';
import './practice_cue.css';

// Skill practice on the HUD (docs/ADAPTATION.md "Seeing skill practice"): whenever something
// trains a skill — or a task the player chose trains nothing — a small card says so near the
// needs ("Disassembling the toaster · Electronics: no practice, too simple to learn from";
// "Crafting a stone knife · Fabrication +8% · 34% to level 2"), and a level-up is a toast.
//
// Options > "Practice feedback": Card (default, by the needs) · Line (one line under the
// crosshair) · Off. ?pcue=card|line|off overrides for a session.
// Options > "Practice from simple tasks": the adaptation switch in src/game/practice.ts (off = BN).

export type CueMode = 'card' | 'line' | 'off';
const MODES: CueMode[] = ['card', 'line', 'off'];
const KEY = 'cdda3d.practice';

interface Stored {
  cue?: CueMode;
  simpleTasks?: boolean;
}

function load(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}
function save(s: Stored): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...load(), ...s }));
  } catch {
    // storage blocked: settings last the session
  }
}

let mode: CueMode = 'card';

export function cueMode(): CueMode {
  return mode;
}

export function installPractice(game: Game, api?: DebugApi): { feed: PracticeFeed } {
  const stored = load();
  const q = new URLSearchParams(location.search).get('pcue');
  if (q !== null && !(MODES as string[]).includes(q)) throw new Error(`?pcue=${q}: expected one of ${MODES.join(', ')}`);
  mode = (q as CueMode | null) ?? (stored.cue && MODES.includes(stored.cue) ? stored.cue : 'card');
  practiceSettings.simpleTasks = stored.simpleTasks === true;

  // What's teaching when no caller named it: the running activity ("Butchering the zombie").
  ambient.source = () => game.activities.current?.spec.name ?? null;
  game.systems.push(new DrivingPractice());

  const feed = new PracticeFeed();
  practiceListeners.push((e) => {
    if (e.who !== game.player) return;
    feed.push(e, performance.now(), (s) => game.player.skillName(s));
    if (e.levelUp && mode !== 'off')
      toast({ category: 'achievement', title: `${game.player.skillName(e.skill)} is now level ${e.level}`, body: e.source ? `From ${e.source.charAt(0).toLowerCase()}${e.source.slice(1)}.` : undefined, key: `lvl:${e.skill}:${e.level}` });
  });

  registerOption({
    category: 'Interface',
    name: 'Practice feedback',
    desc: 'When doing something trains a skill (or teaches nothing, and why). Card: a small card by your needs. Line: one line under the crosshair. Off: only the log and level-ups.',
    value: () => ({ card: 'Card', line: 'Line', off: 'Off' })[mode],
    change: (dir) => {
      mode = MODES[(MODES.indexOf(mode) + dir + MODES.length) % MODES.length];
      save({ cue: mode });
    },
  });
  registerOption({
    category: 'Gameplay',
    name: 'Practice from simple tasks',
    desc: 'Adaptation. Off (Bright Nights): taking apart a difficulty-0 item (a toaster) teaches nothing. On: it teaches a little, up to level 1, so early progress shows.',
    value: () => (practiceSettings.simpleTasks ? 'On' : 'Off (BN)'),
    change: () => {
      practiceSettings.simpleTasks = !practiceSettings.simpleTasks;
      save({ simpleTasks: practiceSettings.simpleTasks });
    },
  });

  // --- drawing
  let host: HTMLElement | null = null;
  let drawn = -1;
  let drawnMode: CueMode | null = null;
  const root = h('div', { class: 'pcue', attrs: { 'data-testid': 'practice-cue' } });
  const place = () => {
    // By the needs (hud_modern's left column) when it's showing; else a corner of its own.
    const col = document.querySelector<HTMLElement>('#ui2 .hud2-vcol');
    const target = mode === 'card' && col && col.offsetParent ? col : ui2Layers().hud;
    if (host !== target || root.parentElement !== target) {
      host = target;
      root.classList.toggle('pcue-float', target !== col);
      target.prepend(root);
    }
    root.classList.toggle('pcue-line', mode === 'line');
  };
  const frame = () => {
    const now = performance.now();
    feed.tick(now);
    if (mode === 'off' || game.player.dead) {
      if (root.childElementCount) root.replaceChildren();
      drawn = -1;
    } else if (feed.version !== drawn || drawnMode !== mode) {
      drawn = feed.version;
      drawnMode = mode;
      place();
      root.replaceChildren(...(mode === 'line' ? feed.cards.slice(0, 1).map(lineEl) : feed.cards.map((c) => cardEl(game, c))));
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  if (api)
    api.practice = {
      /** The cue as text: [title, ...rows] per card. */
      cue: () => feed.cards.map((c) => [c.title, ...c.rows.map(rowText)]),
      mode: () => mode,
      /** Setup for screenshots (players use Options > Practice feedback). */
      setMode: (m: CueMode) => {
        if (!MODES.includes(m)) throw new Error(`practice.setMode(${m}): expected one of ${MODES.join(', ')}`);
        mode = m;
      },
      hints: (skill: string) => skillHints(game, skill).map((x) => x.text),
      settings: () => ({ ...practiceSettings }),
    };
  return { feed };
}

function cardEl(game: Game, c: CueCard): HTMLElement {
  return h(
    'div',
    { class: 'pcue-card hud2-plate' },
    h('div', { class: 'pcue-title', text: c.title }),
    ...c.rows.map((r) => {
      const row = h(
        'div',
        { class: `pcue-row${r.blocked ? ' blocked' : ''}${r.levelUp ? ' up' : ''}`, data: { skill: r.skill } },
        h('span', { class: 'pcue-arrow' }),
        h('span', { class: 'pcue-text', text: rowText(r) }),
        r.blocked ? null : h('span', { class: 'pcue-pip' }, h('span', { class: 'pcue-pip-fill', style: { width: `${Math.round(r.progress * 100)}%` } })),
      );
      // Hover (cursor free): how to get this skill to the next level.
      attachTooltip(row, () => hintsTip(game, r.skill));
      return row;
    }),
  );
}

function lineEl(c: CueCard): HTMLElement {
  const r = c.rows.find((x) => !x.blocked) ?? c.rows[0];
  return h('div', { class: `pcue-lineel${r?.blocked ? ' blocked' : ''}` }, h('span', { class: 'pcue-title', text: `${c.title}: ` }), h('span', { text: r ? rowText(r) : '' }));
}

/** The "How to reach level N+1" tooltip (also used by the character sheet). */
export function hintsTip(game: Game, skill: string, nested = false): HTMLElement {
  const p = game.player;
  const lvl = p.getSkill(skill);
  const hints = skillHints(game, skill);
  return h(
    'div',
    { class: nested ? 'pcue-tip nested' : 'hud2-tip pcue-tip' },
    h('div', { class: 'tone-accent', text: lvl >= 10 ? `${p.skillName(skill)} ${lvl}` : `How to reach ${p.skillName(skill)} ${lvl + 1}` }),
    ...hints.map((x) => h('div', { class: `ui2-small pcue-hint ${x.kind}`, text: x.text })),
  );
}
