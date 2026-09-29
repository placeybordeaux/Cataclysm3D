// The new-game flow (docs/DESIGN_V2.md decision 6): no up-front character creator.
//
//   Title "Start"    → Quick start: a named Evacuee (one name field, dice for another name),
//                      difficulty (Accessible default), Enter to play.
//   Title "New Game" → Start picker: cards for every start in the unlock ladder (profession +
//                      scenario, sprite, one-line pitch, kit preview, trade-off). Locked cards
//                      show what earns them and how far along you are. The old full character
//                      creator is the "Custom survivor" card, once unlocked.
//
// Both resolve with a StartChoice; applyStart() turns it into the survivor (chargen's
// applyBuild), places them for the scenario, and records the run for the journal.

import {
  attachTooltip, button, h, iconEl, openPanel, viewport, type Panel,
} from '../ui2';
import type { UiContext } from '../ui/context';
import { applyBuild, openCharGen } from '../ui/chargen';
import { randomName } from '../ui/format';
import { profName, scenName } from '../ui/chargen_logic';
import { defaultDensity } from '../game/density';
import { INITIAL_VISIBILITY, revealAround } from '../ui/overmap_ui';
import { CHUNK } from '../world/coords';
import { DIFFICULTIES, preferredDifficulty, setPreferredDifficulty, type Difficulty } from './difficulty';
import { findStart, moveSurvivor, SCENARIO_PLACEMENT } from './placement';
import { buildFor, cardTitle, kitPreview, scenarioOptions, startCards, type StartCard, type StartChoice } from './starts';
import { progressLines, unlockMet, type UnlockDef } from './unlocks';
import type { ProgressionHandle } from './install';
import { itemIcon, withKeys } from './ui';

// ------------------------------------------------------------------ shared form

interface Identity {
  name: string;
  male: boolean;
  difficulty: Difficulty;
  title: string;
}

function newIdentity(ctx: UiContext, prog: ProgressionHandle): Identity {
  const male = Math.random() < 0.5;
  const title = prog.profile.data.title;
  const titles = availableTitles(prog);
  return { name: randomName(ctx.data.names, male), male, difficulty: preferredDifficulty(), title: titles.includes(title) ? title : '' };
}

function availableTitles(prog: ProgressionHandle): string[] {
  return prog.catalogue.unlocks.filter((u) => u.kind === 'cosmetic' && prog.isAvailable(u)).map((u) => u.grants.title!);
}

/** A segmented control: one button per option, the chosen one highlighted. */
function segmented<T extends string>(opts: { id: T; label: string; disabled?: string }[], value: () => T, set: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'pg-seg' });
  const draw = () =>
    el.replaceChildren(
      ...opts.map((o) => {
        const b = button(o.label, () => (set(o.id), draw()), { small: true, disabled: o.disabled });
        if (o.id === value()) b.classList.add('on');
        b.dataset.value = o.id;
        return b;
      }),
    );
  draw();
  return el;
}

/**
 * Name (+ dice), gender, difficulty, title. `onEnter` fires on Enter inside the name field
 * (the game's Input ignores keys typed into fields, so the field handles its own Enter/Esc).
 */
function identityForm(ctx: UiContext, prog: ProgressionHandle, id: Identity, onEnter: () => void, onEscape: () => void): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { class: 'pg-input', attrs: { type: 'text', maxlength: '40', spellcheck: 'false', 'aria-label': 'Name', 'data-testid': 'name' } });
  input.value = id.name;
  input.addEventListener('input', () => (id.name = input.value));
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') onEnter();
    else if (e.key === 'Escape') onEscape();
  });
  const reroll = () => {
    id.name = randomName(ctx.data.names, id.male);
    input.value = id.name;
  };
  const dice = button('Random', reroll, { small: true, title: 'Another name' });
  const gender = segmented<'m' | 'f'>([{ id: 'm', label: 'Male' }, { id: 'f', label: 'Female' }], () => (id.male ? 'm' : 'f'), (v) => {
    const was = id.male;
    id.male = v === 'm';
    // A generated name follows the change; a typed one is the player's and stays.
    if (was !== id.male && prog && /^\S+ \S+$/.test(id.name)) reroll();
  });
  const desc = h('div', { class: 'pg-desc' });
  const drawDesc = () => (desc.textContent = DIFFICULTIES.find((d) => d.id === id.difficulty)!.desc);
  const diff = segmented<Difficulty>(DIFFICULTIES.map((d) => ({ id: d.id, label: d.name, disabled: d.unavailable })), () => id.difficulty, (v) => ((id.difficulty = v), drawDesc()));
  drawDesc();
  const titles = availableTitles(prog);
  const rows: (HTMLElement | string)[] = [
    h('span', { class: 'pg-label', text: 'Name' }), h('div', { class: 'pg-row' }, input, dice),
    h('span', { class: 'pg-label', text: 'Body' }), gender,
    h('span', { class: 'pg-label', text: 'Difficulty' }), h('div', { class: 'pg-row' }, diff),
    h('span', {}), desc,
  ];
  if (titles.length)
    rows.push(h('span', { class: 'pg-label', text: 'Title' }), segmented<string>([{ id: '', label: 'None' }, ...titles.map((t) => ({ id: t, label: t }))], () => id.title, (v) => (id.title = v)));
  return { el: h('div', { class: 'pg-form' }, ...rows), input };
}

function center(panel: Panel): void {
  requestAnimationFrame(() => {
    const r = panel.el.getBoundingClientRect();
    const v = viewport();
    panel.moveTo((v.w - r.width) / 2, Math.max(8, (v.h - r.height) / 2.4));
  });
}

// ------------------------------------------------------------------ quick start

/** The quick start panel. Resolves with the choice, or null (Esc / Back). */
export function openQuickStart(ctx: UiContext, prog: ProgressionHandle): Promise<StartChoice | null> {
  return new Promise((resolve) => {
    const evac = prog.catalogue.unlocks.find((u) => u.kind === 'start' && !u.requirement.length)!;
    const id = newIdentity(ctx, prog);
    let done = false;
    const finish = (c: StartChoice | null) => {
      if (done) return;
      if (c && !c.name.trim()) {
        form.input.focus();
        form.input.classList.add('shake');
        setTimeout(() => form.input.classList.remove('shake'), 300);
        return;
      }
      done = true;
      panel.close();
      resolve(c);
    };
    const choose = () =>
      finish({ unlockId: evac.id, profession: evac.grants.profession!, scenario: evac.grants.scenario ?? 'evacuee', name: id.name.trim(), male: id.male, difficulty: id.difficulty, title: id.title });
    const panel = openPanel({
      id: 'pg.quickstart',
      title: 'Start',
      width: 'min(calc(var(--fs) * 34), 94vw)',
      closable: true,
      onKey: (e) => {
        if (e.key === 'Enter' && !e.repeat) return choose(), true;
        return false;
      },
      onClose: () => finish(null),
    });
    const form = identityForm(ctx, prog, id, choose, () => finish(null));
    const more = prog.catalogue.unlocks.filter((u) => (u.kind === 'profession' || u.kind === 'scenario') && prog.isAvailable(u)).length;
    panel.body.append(
      h('div', { class: 'pg-card-head' }, iconEl(itemIcon(ctx.game.data, evac.icon ?? 'mbag'), 'grid'), h('div', {}, h('div', { class: 'pg-detail-title', text: evac.name }), h('div', { class: 'pg-card-pitch', text: evac.pitch ?? '' }))),
      form.el,
      ...(more ? [h('div', { class: 'pg-new', text: `${more} more start${more === 1 ? '' : 's'} unlocked: choose one from New Game.` })] : []),
      h('div', { class: 'pg-actions' },
        button('Back', () => finish(null), { key: 'Esc' }),
        button('Start', choose, { tone: 'accent', key: 'Enter' }),
      ),
    );
    center(panel);
    setTimeout(() => form.input.focus(), 0);
  });
}

// ------------------------------------------------------------------ start picker

const VIEW_KEY = 'cdda3d.newgame.view';
type PickerView = 'cards' | 'list';
function loadView(): PickerView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards';
  } catch {
    return 'cards';
  }
}

export type PickerResult = StartChoice | { custom: true; difficulty: Difficulty; title: string } | null;

/** The start picker. Resolves with a choice, `{custom}` for the full creator, or null. */
export function openStartPicker(ctx: UiContext, prog: ProgressionHandle): Promise<PickerResult> {
  return new Promise((resolve) => {
    const { game } = ctx;
    const data = game.data;
    const recorded = (i: string) => prog.profile.isUnlocked(i);
    const classic = prog.profile.data.options.classic;
    const cards = startCards(data, prog.catalogue, recorded, classic);
    const creator = prog.catalogue.unlocks.find((u) => u.kind === 'creator');
    // Available first (ladder order), then locked ones closest to earning.
    const order: (StartCard | 'creator')[] = [...cards.filter((c) => c.available), ...(creator && prog.isAvailable(creator) ? ['creator' as const] : []),
      ...cards.filter((c) => !c.available), ...(creator && !prog.isAvailable(creator) ? ['creator' as const] : [])];
    const fresh = new Set(prog.run.unlocked.concat(Object.entries(prog.profile.data.unlocked).filter(([, r]) => Date.now() - r.at < 36e5 * 24).map(([k]) => k)));
    const id = newIdentity(ctx, prog);
    let sel = 0;
    let scen = '';
    let view: PickerView = loadView();
    let done = false;

    const finish = (r: PickerResult) => {
      if (done) return;
      done = true;
      panel.close();
      resolve(r);
    };
    const current = () => order[sel];
    const unlockOf = (c: StartCard | 'creator'): UnlockDef => (c === 'creator' ? creator! : c.unlock);
    const isOpen = (c: StartCard | 'creator') => (c === 'creator' ? prog.isAvailable(creator!) : c.available);
    const start = () => {
      const c = current();
      if (!isOpen(c)) return;
      if (!id.name.trim()) return void form.input.focus();
      setPreferredDifficulty(id.difficulty);
      if (c === 'creator') return finish({ custom: true, difficulty: id.difficulty, title: id.title });
      finish({ unlockId: c.unlock.id, profession: c.profession.id, scenario: scen || c.scenario.id, name: id.name.trim(), male: id.male, difficulty: id.difficulty, title: id.title });
    };

    const viewBtn = h('button', { class: 'ui2-iconbtn', title: 'Cards / list view', attrs: { 'aria-label': 'Toggle view' } });
    const panel = openPanel({
      id: 'pg.newgame',
      title: 'New Game',
      width: 'min(calc(var(--fs) * 64), 96vw)',
      height: 'min(88vh, calc(var(--fs) * 40))',
      titleExtras: [viewBtn],
      onKey: (e) => {
        const k = e.key;
        const cols = columns();
        if (k === 'ArrowRight') move(1);
        else if (k === 'ArrowLeft') move(-1);
        else if (k === 'ArrowDown') move(cols);
        else if (k === 'ArrowUp') move(-cols);
        else if (k === 'Home') move(-order.length);
        else if (k === 'End') move(order.length);
        else if (k === 'Enter' && !e.repeat) start();
        else return false;
        return true;
      },
      onClose: () => finish(null),
    });
    const cardsEl = h('div', { class: 'pg-cards' });
    const detail = h('div', { class: 'pg-detail' });
    panel.body.append(h('div', { class: 'pg-picker' }, cardsEl, detail));
    const form = identityForm(ctx, prog, id, start, () => finish(null));
    const columns = () => {
      const first = cardsEl.firstElementChild as HTMLElement | null;
      if (!first) return 1;
      return Math.max(1, Math.round(cardsEl.clientWidth / (first.offsetWidth + 4)));
    };
    const move = (d: number) => {
      sel = Math.max(0, Math.min(order.length - 1, sel + d));
      scen = '';
      drawCards();
      drawDetail();
      cardsEl.children[sel]?.scrollIntoView({ block: 'nearest' });
    };
    const setView = (v: PickerView) => {
      view = v;
      cardsEl.classList.toggle('list', v === 'list');
      viewBtn.textContent = v === 'list' ? '▦' : '☰';
      drawCards();
      try {
        localStorage.setItem(VIEW_KEY, v);
      } catch {
        // not persisted
      }
    };
    viewBtn.addEventListener('click', () => setView(view === 'list' ? 'cards' : 'list'));
    setView(view);

    function drawCards(): void {
      cardsEl.replaceChildren(
        ...order.map((c, i) => {
          const u = unlockOf(c);
          const open = isOpen(c);
          const name = c === 'creator' ? u.name : cardTitle(c, id.male);
          const scenLine = c === 'creator' ? 'Any scenario' : scenName(c.scenario, id.male);
          const lock = open ? null : progressLines(u, prog.env, prog.achName).find((l) => !l.done);
          const el = h('button', { class: `pg-card${i === sel ? ' selected' : ''}${open ? '' : ' locked'}`, data: { unlock: u.id } },
            h('div', { class: 'pg-card-head' }, iconEl(itemIcon(ctx.game.data, u.icon ?? 'mbag'), view === 'list' ? 'row' : 'grid'),
              h('div', {}, h('div', { class: 'pg-card-name', text: open ? name : `${name}` }), h('div', { class: 'pg-card-scen', text: scenLine }))),
            open ? h('div', { class: 'pg-card-pitch', text: u.pitch ?? '' }) : h('div', { class: 'pg-card-lock', text: `Locked: ${lock?.text ?? 'keep playing'}${lock?.count ? ` (${lock.count})` : ''}` }),
            open && fresh.has(u.id) ? h('div', { class: 'pg-new', text: 'New!' }) : null,
          );
          el.addEventListener('click', () => {
            if (sel === i) return;
            sel = i;
            scen = '';
            drawCards();
            drawDetail();
          });
          el.addEventListener('dblclick', start);
          return el;
        }),
      );
    }

    function drawDetail(): void {
      const c = current();
      const u = unlockOf(c);
      const open = isOpen(c);
      const parts: (HTMLElement | null)[] = [];
      if (c === 'creator') {
        parts.push(h('div', { class: 'pg-detail-title', text: u.name }), h('div', { class: 'pg-card-pitch', text: u.pitch ?? '' }), u.tradeoff ? h('div', { class: 'pg-trade', text: u.tradeoff }) : null);
      } else {
        const prof = c.profession;
        parts.push(
          h('div', { class: 'pg-detail-title', text: cardTitle(c, id.male) }),
          h('div', { class: 'pg-card-pitch', text: u.pitch ?? '' }),
          h('div', { class: 'pg-entry-body', text: descText(prof.description, id.male) }),
        );
        const skills = (prof.skills ?? []).map((s) => `${game.player.skillName?.(s.name) ?? s.name} ${s.level}`);
        if (skills.length) parts.push(h('div', { class: 'pg-skills', text: `Skills: ${skills.join(', ')}` }));
        const kit = kitPreview(data, prof, id.male);
        const kitEl = h('div', { class: 'pg-kit' });
        for (const k of kit) {
          const cell = h('span', {}, iconEl(itemIcon(ctx.game.data, k.id), 'row'), k.count > 1 ? h('span', { class: 'pg-count', text: String(k.count) }) : null);
          attachTooltip(cell, () => (k.count > 1 ? `${k.name} ×${k.count}` : k.name));
          kitEl.append(cell);
        }
        parts.push(h('div', { class: 'ui2-section', text: 'Starting kit' }), kitEl);
        if (u.tradeoff) parts.push(h('div', { class: 'pg-trade', text: `Trade-off: ${u.tradeoff}` }));
        if (open) {
          const opts = scenarioOptions(data, prog.catalogue, c, recorded, classic);
          if (!scen) scen = c.scenario.id;
          parts.push(h('div', { class: 'ui2-section', text: 'Scenario' }));
          parts.push(opts.length > 1
            ? segmented<string>(opts.map((s) => ({ id: s.id, label: scenName(s, id.male) })), () => scen, (v) => ((scen = v), drawScen()))
            : h('div', { class: 'pg-card-scen', text: scenName(c.scenario, id.male) }));
          parts.push(scenDesc);
          drawScen();
        }
      }
      if (!open) {
        parts.push(h('div', { class: 'ui2-section', text: 'How to unlock' }));
        for (const l of progressLines(u, prog.env, prog.achName)) parts.push(progressRow(l.text, l.done, l.fraction, l.count));
      } else parts.push(h('div', { class: 'ui2-section', text: 'Survivor' }), form.el);
      const startBtn = button(c === 'creator' ? 'Create…' : 'Start', start, { tone: 'accent', key: 'Enter', disabled: open ? undefined : 'Locked' });
      // Actions stay pinned under the scrolling details: Start must never scroll out of view.
      detail.replaceChildren(
        h('div', { class: 'pg-detail-scroll' }, ...parts.filter((x): x is HTMLElement => !!x)),
        h('div', { class: 'pg-actions' }, button('Back', () => finish(null), { key: 'Esc' }), startBtn),
      );
      panel.setFooter(classic ? 'Classic mode: everything is unlocked (Options).' : `${cards.filter((x) => x.available).length} of ${cards.length} starts unlocked.  Unlocks are choices, never bonuses.`);
    }
    const scenDesc = h('div', { class: 'pg-desc' });
    const drawScen = () => {
      const s = data.misc?.scenario?.[scen] as { description?: string; start_name?: string } | undefined;
      const place = SCENARIO_PLACEMENT[scen];
      scenDesc.textContent = `${s?.description ?? ''}${place ? `  Start: ${s?.start_name ?? place}.` : ''}`;
    };
    drawCards();
    drawDetail();
    center(panel);
  });
}

function descText(v: unknown, male: boolean): string {
  if (typeof v === 'string') return v;
  const o = v as { male?: string; female?: string; str?: string } | undefined;
  return (male ? o?.male : o?.female) ?? o?.str ?? o?.male ?? '';
}

/** "Kill 10 zombies  4/10" with a bar (journal, picker, death screen). */
export function progressRow(text: string, done: boolean, fraction?: number, count?: string): HTMLElement {
  return h('div', { class: `pg-prog${done ? ' done' : ''}` },
    h('span', { text: `${done ? '✓ ' : ''}${text}` }),
    h('span', { class: 'ui2-dim', text: done ? 'done' : count ?? '' }),
    fraction !== undefined || done ? h('div', { class: 'pg-prog-bar' }, h('div', { style: { width: `${Math.round((done ? 1 : fraction ?? 0) * 100)}%` } })) : null,
  );
}

// ------------------------------------------------------------------ applying a start

/** Make the survivor for a choice and put them where the scenario starts. */
export function applyStart(ctx: UiContext, prog: ProgressionHandle, worldgen: { overmap: import('../world/overmap/overmap').Overmap } | null, choice: StartChoice): string {
  const { game } = ctx;
  const p = game.player;
  // Placement first: the kit that doesn't fit is dropped where you stand.
  let where = 'the evac shelter';
  const placement = SCENARIO_PLACEMENT[choice.scenario];
  if (!placement) throw new Error(`progression: no placement for scenario ${choice.scenario}`);
  if (placement !== 'shelter') {
    if (!worldgen) throw new Error('progression: scenario starts need the world generator');
    try {
      const spot = findStart({ map: game.map, overmap: worldgen.overmap }, placement, { x: Math.floor(p.x / CHUNK), y: Math.floor(p.y / CHUNK) });
      if (spot) {
        moveSurvivor(game, spot);
        where = spot.where;
        // The map shouldn't know the shelter you never saw.
        game.overmapSeen.clear();
        revealAround(game, INITIAL_VISIBILITY, 0);
        revealAround(game);
      }
    } catch (e) {
      // Loud but not fatal: the log says why you're in the shelter instead.
      console.warn('progression: scenario placement failed', e);
      game.message(`(Couldn't find a start for ${choice.scenario}: ${(e as Error).message}.  Starting in the evac shelter.)`, 'c_light_red');
    }
  }
  applyBuild(ctx, buildFor(game.data, choice, defaultDensity()));
  prog.newRun({ startId: choice.unlockId, difficulty: choice.difficulty, title: choice.title });
  setPreferredDifficulty(choice.difficulty);
  if (choice.title !== prog.profile.data.title) prog.profile.setTitle(choice.title);
  return where;
}

/** Title "Start": quick start. true = a game is starting. */
export async function runQuickStart(ctx: UiContext, prog: ProgressionHandle, worldgen: Parameters<typeof applyStart>[2]): Promise<boolean> {
  const c = await openQuickStart(ctx, prog);
  if (!c) return false;
  const where = applyStart(ctx, prog, worldgen, c);
  ctx.game.message(withKeys(ctx.game, `${c.name}, you wake up in ${where}.  Press <keybind:journal> for your survival journal, <keybind:help> for help.`), 'c_light_gray');
  return true;
}

/** Title "New Game": the picker (or the full creator). true = a game is starting. */
export async function runNewGame(ctx: UiContext, prog: ProgressionHandle, worldgen: Parameters<typeof applyStart>[2]): Promise<boolean> {
  for (;;) {
    const r = await openStartPicker(ctx, prog);
    if (!r) return false;
    if ('custom' in r) {
      const build = await openCharGen(ctx);
      if (!build) continue; // back to the picker
      applyBuild(ctx, build);
      prog.newRun({ startId: 'creator', difficulty: r.difficulty, title: r.title });
      ctx.game.message(withKeys(ctx.game, `${build.name}, you wake up in the evac shelter.  Press <keybind:journal> for your survival journal.`), 'c_light_gray');
      return true;
    }
    const where = applyStart(ctx, prog, worldgen, r);
    const prof = ctx.game.data.misc?.profession?.[r.profession];
    ctx.game.message(withKeys(ctx.game, `${r.name}${prof ? `, ${profName(prof as never, r.male).toLowerCase()},` : ','} you wake up in ${where}.  Press <keybind:journal> for your survival journal.`), 'c_light_gray');
    return true;
  }
}

export { unlockMet };
