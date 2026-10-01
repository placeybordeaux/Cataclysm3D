import { ALL_PARTS, BODY_PARTS, MAIN_PARTS, type BodyPartId, type MainPartId } from '../game/bodyparts';
import { cddaText } from '../game/units';
import { attachTooltip, h, palette, tabs, type Panel } from '../ui2';
import { colorize } from './framework';
import { moraleFace } from './format';
import type { UiContext } from './context';
import { openScreen, meter } from './screen2';
import { partTone } from './hud_logic';
import { paintBody, PART_BOX, BODY_W, BODY_H, type BodyKey } from './pixelart';
import { partNotes } from './hud_modern';
import { effectiveFocus, recentPractice } from '../game/practice';
import { hintsTip } from './practice_cue';

// The '@' character screen on ui2: a paper doll with HP / armour / encumbrance / warmth per
// body part (hover a row or the figure), stats with what they do, skills with progress bars
// and what they affect, traits and mutations with their descriptions, effects, and whatever
// other systems add (bionics: `charsheetSections`). Tabs; ←/→ switch them, '@' closes.

/** Extra boxes (e.g. BIONICS from src/ui/mutbio_ui.ts) shown on the "More" tab. Body is CDDA-tagged HTML. */
export const charsheetSections: ((ctx: UiContext) => { title: string; body: string } | null)[] = [];

type Tab = 'body' | 'stats' | 'skills' | 'traits' | 'effects' | 'more';
let lastTab: Tab = 'body';

const STAT_INFO: Record<string, { name: string; does: string }> = {
  str: { name: 'Strength', does: 'Melee damage, how much you can carry, throwing distance, and bashing through doors. Also raises your hit points.' },
  dex: { name: 'Dexterity', does: 'Hitting what you swing at, dodging, throwing accuracy, and some crafting.' },
  int: { name: 'Intelligence', does: 'How fast you learn skills and read books, and your crafting success chance.' },
  per: { name: 'Perception', does: 'Ranged accuracy, spotting traps and hidden things, and how well you see at a distance.' },
};

/** What each skill is for, in a line (BN descriptions are long; these are the gist). */
const SKILL_USE: Record<string, string> = {
  melee: 'Hit chance and blocking with any melee weapon.', bashing: 'Damage with clubs, bats, pipes.', cutting: 'Damage with blades and axes.',
  stabbing: 'Damage with knives and spears.', unarmed: 'Fighting with fists and martial arts.', dodge: 'Avoiding blows.',
  gun: 'Aiming any firearm.', pistol: 'Handguns.', rifle: 'Rifles.', shotgun: 'Shotguns.', smg: 'Submachine guns.', archery: 'Bows.',
  throw: 'Throwing things accurately.', launcher: 'Grenade and rocket launchers.', fabrication: 'Crafting tools, weapons, furniture.',
  cooking: 'Cooking and chemistry recipes.', tailor: 'Making and repairing clothes.', mechanics: 'Cars and machines.',
  electronics: 'Electronics and bionics.', firstaid: 'Healing with bandages and kits, and surgery.', survival: 'Foraging, butchering, traps, fires.',
  swimming: 'Stamina and swimming (athletics).', driving: 'Handling vehicles.', computer: 'Hacking terminals.', traps: 'Setting and disarming traps.',
  speech: 'Persuading, lying to and intimidating people.', barter: 'Better prices when trading.',
};

export function openCharacterSheet(ctx: UiContext): Panel {
  const { game } = ctx;
  const p = game.player;
  const order: Tab[] = ['body', 'stats', 'skills', 'traits', 'effects', 'more'];
  const extras = () => charsheetSections.map((f) => f(ctx)).filter((x): x is { title: string; body: string } => !!x);
  const panel = openScreen(game, {
    id: 'scr.character',
    title: `${p.name}`,
    group: 'scr.character',
    action: 'character',
    pauses: true,
    width: 'min(calc(var(--fs) * 50), 96vw)',
    height: 'min(calc(var(--fs) * 34), 92vh)',
    legend: [['← →', 'tabs'], ['hover', 'details']],
    onKey: (e) => {
      const i = order.indexOf(t.active as Tab);
      if (e.key === 'ArrowRight' || e.key === 'Tab') return t.set(order[(i + 1) % order.length]), true;
      if (e.key === 'ArrowLeft') return t.set(order[(i + order.length - 1) % order.length]), true;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') return (content.scrollTop += e.key === 'PageDown' ? content.clientHeight : 40), true;
      if (e.key === 'ArrowUp' || e.key === 'PageUp') return (content.scrollTop -= e.key === 'PageUp' ? content.clientHeight : 40), true;
      return false;
    },
  });
  const skillsKnown = Object.values(p.skills).filter((s) => s.level > 0).length;
  const t = tabs(
    [
      { id: 'body', label: 'Body' },
      { id: 'stats', label: 'Stats' },
      { id: 'skills', label: 'Skills', badge: skillsKnown ? String(skillsKnown) : undefined },
      { id: 'traits', label: 'Traits', badge: String([...p.traits].filter((id) => p.traitDef(id)?.player_display !== false).length) },
      { id: 'effects', label: 'Effects', badge: String(p.effects.all().filter((e) => e.name()).length) },
      { id: 'more', label: 'More' },
    ],
    lastTab,
    (id) => {
      lastTab = id as Tab;
      draw();
    },
  );
  const who = ctx.build ? `${ctx.build.profession} · ${ctx.build.scenario}` : '';
  const head = h('div', { class: 'cs-head' },
    h('span', { class: 'cs-name', text: p.name }),
    h('span', { class: 'ui2-dim', text: [p.male ? 'Male' : 'Female', who].filter(Boolean).join(' · ') }),
    h('span', { class: 'cs-mood', html: `Mood ${colorize(moraleFace(p.morale.level(), ctx.data.moodFaces))}` }),
  );
  const content = h('div', { class: 'cs-content', attrs: { 'data-testid': 'charsheet-content' } });
  panel.body.append(head, t.el, content);
  panel.body.classList.add('cs-body');

  function draw(): void {
    const tab = t.active as Tab;
    content.replaceChildren(
      tab === 'body' ? bodyTab() : tab === 'stats' ? statsTab() : tab === 'skills' ? skillsTab() : tab === 'traits' ? traitsTab() : tab === 'effects' ? effectsTab() : moreTab(),
    );
    content.scrollTop = 0;
  }

  // ---------------------------------------------------------------- body
  function bodyTab(): HTMLElement {
    const canvas = h('canvas', { class: 'cs-doll' });
    const fillFor = (hl: BodyKey | null) => {
      const fill = {} as Record<BodyKey, string>;
      const flags = { bleeding: {} as Partial<Record<BodyKey, boolean>>, bandaged: {} as Partial<Record<BodyKey, boolean>>, broken: {} as Partial<Record<BodyKey, boolean>>, infected: {} as Partial<Record<BodyKey, boolean>> };
      for (const bp of MAIN_PARTS) {
        const hp = p.hp[bp];
        const tone = partTone(hp.cur, hp.max, p.isLimbBroken(bp));
        fill[bp] = bp === hl ? palette.accent : ({ good: palette.good, ok: '#a9b86a', warn: palette.warn, bad: palette.danger, broken: '#3a2a2a' })[tone];
        flags.broken[bp] = tone === 'broken';
        flags.bleeding[bp] = p.effects.has('bleed', bp);
        flags.bandaged[bp] = p.effects.has('bandaged', bp);
        flags.infected[bp] = p.effects.has('infected', bp) || p.effects.has('bite', bp);
      }
      paintBody(canvas, { fill, ...flags, phase: 0 });
    };
    fillFor(null);
    const rows = h('div', { class: 'cs-parts' });
    rows.append(h('div', { class: 'cs-prow cs-phead' }, ...['Part', 'Health', 'Armor', 'Encumb.', 'Warmth'].map((x) => h('span', { text: x }))));
    const rowFor: Partial<Record<MainPartId, HTMLElement>> = {};
    for (const bp of MAIN_PARTS) {
      const subs = ALL_PARTS.filter((s) => s !== bp && BODY_PARTS[s].main === bp);
      const row = partRow(bp, true);
      rowFor[bp] = row;
      rows.append(row, ...subs.map((s) => partRow(s, false)));
      row.addEventListener('pointerenter', () => fillFor(bp));
      row.addEventListener('pointerleave', () => fillFor(null));
    }
    const inner = h('div', { class: 'cs-dollinner' }, canvas);
    const doll = h('div', { class: 'cs-dollwrap' }, inner);
    // Hover a part of the figure: highlight its row.
    for (const [part, b] of Object.entries(PART_BOX) as [BodyKey, (typeof PART_BOX)[BodyKey]][]) {
      const hit = h('div', { class: 'cs-doll-hit' });
      Object.assign(hit.style, {
        left: `${((b.x0 + 1) / BODY_W) * 100}%`, top: `${((b.y0 + 1) / BODY_H) * 100}%`,
        width: `${((b.x1 - b.x0 + 1) / BODY_W) * 100}%`, height: `${((b.y1 - b.y0 + 1) / BODY_H) * 100}%`,
      });
      hit.addEventListener('pointerenter', () => (fillFor(part), rowFor[part]?.classList.add('hl')));
      hit.addEventListener('pointerleave', () => (fillFor(null), rowFor[part]?.classList.remove('hl')));
      attachTooltip(hit, () => partTip(part));
      inner.append(hit);
    }
    const pain = p.perceivedPain();
    const summary = h('div', { class: 'cs-bodysum' },
      kv('Pain', p.painDescription(), pain >= 40 ? 'bad' : pain > 0 ? 'warn' : 'dim'),
      kv('Stamina', `${Math.round((p.stamina / p.staminaMax()) * 100)}%`, p.stamina < p.staminaMax() * 0.35 ? 'warn' : 'good'),
      kv('Carrying', `${(p.inv.weightCarried() / 1000).toFixed(1)} / ${(p.inv.weightCapacity() / 1000).toFixed(1)} kg`, p.inv.weightCarried() > p.inv.weightCapacity() ? 'bad' : 'text'),
      kv('Body temperature', p.bodyTempDescription(), p.bodyTempDescription() === 'Comfortable' ? 'good' : 'warn'),
    );
    return h('div', { class: 'cs-bodytab' }, h('div', { class: 'cs-left' }, doll, summary), h('div', { class: 'cs-right' }, rows,
      h('div', { class: 'ui2-small ui2-dim cs-note', text: 'Encumbrance above a part\'s threshold slows what that part does (arms: attacks, legs: moving, eyes: aiming, mouth: stamina). Warmth: 0 = bare; more keeps you warm (and hot in summer). Armor: bash / cut protection of what you wear there.' }),
    ));
  }

  function partRow(bp: BodyPartId, main: boolean): HTMLElement {
    const enc = p.inv.encumbrance(bp);
    const thr = BODY_PARTS[bp].encumbrance_threshold;
    const encTone = enc === 0 ? 'dim' : enc <= thr ? 'text' : enc <= thr + 10 ? 'warn' : 'bad';
    const warm = p.inv.warmth(bp);
    let bash = 0, cut = 0;
    for (const it of p.inv.wornCovering(bp)) (bash += p.inv.armorResist(it, bp, 'bash')), (cut += p.inv.armorResist(it, bp, 'cut'));
    const name = BODY_PARTS[bp].name.replace(/^./, (c) => c.toUpperCase());
    const cells: HTMLElement[] = [h('span', { class: main ? 'cs-pname' : 'cs-pname sub', text: name })];
    if (main) {
      const m = bp as MainPartId;
      const hp = p.hp[m];
      const tone = partTone(hp.cur, hp.max, p.isLimbBroken(m));
      const t2 = tone === 'good' || tone === 'ok' ? 'good' : tone === 'warn' ? 'warn' : 'bad';
      cells.push(meter(hp.cur / hp.max, t2, tone === 'broken' ? 'BROKEN' : `${hp.cur}/${hp.max}`));
    } else cells.push(h('span'));
    cells.push(
      h('span', { class: bash + cut ? '' : 'ui2-dim', text: `${bash} / ${cut}` }),
      h('span', { class: `tone-${encTone}`, text: String(enc) }),
      h('span', { class: warm ? '' : 'ui2-dim', text: String(warm) }),
    );
    const row = h('div', { class: `cs-prow${main ? '' : ' sub'}` }, ...cells);
    attachTooltip(row, () => {
      const worn = p.inv.wornCovering(bp).map((it) => it.name());
      const notes = main ? partNotes(p, bp as MainPartId) : [];
      return h('div', { class: 'hud2-tip' },
        h('div', { class: 'tone-accent', text: name }),
        ...notes.map((n) => h('div', { class: 'ui2-small', text: n })),
        h('div', { class: 'ui2-small', text: worn.length ? `Worn: ${worn.join(', ')}` : 'Nothing worn here.' }),
        h('div', { class: 'ui2-small ui2-dim', text: `Encumbrance ${enc} (threshold ${thr}), warmth ${warm}, armor bash ${bash} / cut ${cut}` }),
      );
    });
    return row;
  }

  function partTip(part: BodyKey): HTMLElement {
    const hp = p.hp[part];
    return h('div', { class: 'hud2-tip' },
      h('div', { class: 'tone-accent', text: `${BODY_PARTS[part].name.replace(/^./, (c) => c.toUpperCase())}: ${hp.cur} / ${hp.max}` }),
      ...partNotes(p, part).map((n) => h('div', { class: 'ui2-small', text: n })),
    );
  }

  // ---------------------------------------------------------------- stats
  function statsTab(): HTMLElement {
    const out = h('div', { class: 'cs-stats' });
    const pp = p.painPenalty();
    for (const [id, cur, base] of [['str', p.str, p.str_base], ['dex', p.dex, p.dex_base], ['int', p.int, p.int_base], ['per', p.per, p.per_base]] as [string, number, number][]) {
      const info = STAT_INFO[id];
      const tone = cur < base ? 'bad' : cur > base ? 'good' : 'accent';
      const why = cur < base ? `Lowered from ${base}${(pp as Record<string, number>)[id] ? ` (pain −${(pp as Record<string, number>)[id]})` : ''}.` : cur > base ? `Raised from ${base}.` : '';
      out.append(h('div', { class: 'cs-stat' },
        h('div', { class: 'cs-stat-head' }, h('span', { class: 'cs-stat-name', text: info.name }), h('span', { class: `cs-stat-val tone-${tone}`, text: String(cur) })),
        meter(cur / 20, tone === 'accent' ? 'accent' : tone),
        h('div', { class: 'ui2-small ui2-dim', text: `${info.does}${why ? ' ' + why : ''}` }),
      ));
    }
    const speedMods = [...p.speedModifiers.reduce((m, [n, v]) => m.set(n, (m.get(n) ?? 0) + v), new Map<string, number>())];
    if (!speedMods.length && pp.speed) speedMods.push(['Pain', -pp.speed]);
    out.append(h('div', { class: 'ui2-section', text: 'Speed' }),
      h('div', { class: 'cs-kvs' },
        kv('Current speed', String(p.speed), p.speed < 100 ? 'bad' : p.speed > 100 ? 'good' : 'text'),
        ...speedMods.map(([n, v]) => kv(n, `${v > 0 ? '+' : ''}${v}`, v < 0 ? 'bad' : 'good')),
        kv('Dodge', p.dodge().toFixed(1), 'text'),
        kv('Focus', String(Math.round(p.focus)), p.focus < 60 ? 'warn' : 'text'),
        kv('Morale', String(p.morale.level()), p.morale.level() < -10 ? 'bad' : p.morale.level() > 10 ? 'good' : 'text'),
      ),
      h('div', { class: 'ui2-small ui2-dim', text: '100 is normal speed. Focus is how well you learn right now: it drifts toward a level set by your morale.' }),
    );
    return out;
  }

  // ---------------------------------------------------------------- skills
  function skillsTab(): HTMLElement {
    const misc = game.data.misc ?? {};
    const defs = Object.values(misc.skill ?? {}) as { id: string; name: unknown; description?: unknown; display_category?: string; sort_rank?: number }[];
    const cats = new Map<string, typeof defs>();
    for (const d of defs.filter((x) => !/none$/.test(x.display_category ?? 'none'))) cats.set(d.display_category ?? 'other', [...(cats.get(d.display_category ?? 'other') ?? []), d]);
    const out = h('div', { class: 'cs-skills' });
    const catName = (c: string) => c.replace(/^display_/, '').replace(/^./, (x) => x.toUpperCase());
    // Focus scales every practice (BN adjust_for_focus); say what it means right now, and what
    // trained what lately, so "is this upskilling me?" has an answer without hovering.
    const focus = Math.round(effectiveFocus(p));
    const recentAll = defs
      .flatMap((d) => recentPractice(p, d.id).slice(0, 1).map((r) => ({ name: cddaText(d.name as string) || d.id, ...r })))
      .sort((a, b) => b.turn - a.turn)
      .slice(0, 3);
    out.append(
      h('div', { class: 'cs-kvs' },
        kv('Focus', `${Math.round(p.focus)} · learning at ${Math.max(0, focus)}% speed`, focus < 60 ? 'warn' : focus >= 100 ? 'good' : 'text'),
      ),
      recentAll.length
        ? h('div', { class: 'ui2-small ui2-dim', text: `Recently trained: ${recentAll.map((r) => `${r.name} (${r.source.charAt(0).toLowerCase()}${r.source.slice(1)})`).join(', ')}` })
        : h('div', { class: 'ui2-small ui2-dim', text: 'Doing things trains skills: crafting, taking things apart, building, reading, fighting. Hover a skill to see how to raise it.' }),
    );
    for (const [cat, list] of [...cats].sort((a, b) => a[0].localeCompare(b[0]))) {
      out.append(h('div', { class: 'ui2-section', text: catName(cat) }));
      const grid = h('div', { class: 'cs-skillgrid' });
      for (const s of list.sort((a, b) => (a.sort_rank ?? 0) - (b.sort_rank ?? 0) || String(a.id).localeCompare(b.id))) {
        const sk = p.skills[s.id];
        const lvl = sk?.level ?? 0;
        const frac = sk ? sk.exercise / (10000 * (lvl + 1) ** 2) : 0;
        const name = cddaText(s.name as string) || s.id;
        const recent = recentPractice(p, s.id);
        const row = h('div', { class: `cs-skill${lvl ? '' : ' zero'}${recent.length ? ' recent' : ''}`, data: { skill: s.id } },
          h('span', { class: 'cs-skill-name', text: name }),
          h('span', { class: 'cs-skill-lvl', text: String(lvl) }),
          meter(frac, lvl ? 'good' : 'accent', `${Math.floor(frac * 100)}%`),
        );
        attachTooltip(row, () => h('div', { class: 'hud2-tip' },
          h('div', { class: 'tone-accent', text: `${name} ${lvl}` }),
          SKILL_USE[s.id] ? h('div', { class: 'ui2-small', text: SKILL_USE[s.id] }) : null,
          s.description ? h('div', { class: 'ui2-small ui2-dim', text: cddaText(s.description as string) }) : null,
          h('div', { class: 'ui2-small ui2-dim', text: `${Math.floor(frac * 100)}% of the way to level ${lvl + 1}.` }),
          recent.length ? h('div', { class: 'ui2-small', text: `Recently trained by: ${recent.map((r) => r.source).join(', ')}` }) : null,
          hintsTip(game, s.id, true),
        ));
        grid.append(row);
      }
      out.append(grid);
    }
    return out;
  }

  // ---------------------------------------------------------------- traits
  function traitsTab(): HTMLElement {
    const ids = [...p.traits].filter((id) => p.traitDef(id)?.player_display !== false);
    if (!ids.length) return h('div', { class: 'ui2-empty', text: 'No traits or mutations.' });
    const out = h('div', { class: 'cs-list' });
    for (const id of ids.sort((a, b) => p.traitName(a).localeCompare(p.traitName(b)))) {
      const d = p.traitDef(id);
      const pts = d?.points ?? 0;
      const tone = pts > 0 ? 'good' : pts < 0 ? 'bad' : 'warn';
      out.append(h('div', { class: `cs-card tone-border-${tone}` },
        h('div', { class: `cs-card-title tone-${tone}`, text: p.traitName(id) }),
        d?.description ? h('div', { class: 'ui2-small', text: cddaText(d.description) }) : null,
        h('div', { class: 'ui2-small ui2-dim', text: pts > 0 ? 'Good trait' : pts < 0 ? 'Bad trait' : 'Neutral' }),
      ));
    }
    return out;
  }

  // ---------------------------------------------------------------- effects
  function effectsTab(): HTMLElement {
    const list = p.effects.all().filter((e) => e.name());
    if (!list.length) return h('div', { class: 'ui2-empty', text: 'No effects right now.' });
    const out = h('div', { class: 'cs-list' });
    for (const e of list) {
      const r = e.type.def.rating;
      const tone = r === 'good' ? 'good' : r === 'bad' ? 'bad' : r === 'mixed' ? 'warn' : 'dim';
      const where = e.bp ? BODY_PARTS[e.bp].name : '';
      out.append(h('div', { class: `cs-card tone-border-${tone}` },
        h('div', { class: `cs-card-title tone-${tone}`, text: `${e.name()}${where ? ` (${where})` : ''}` }),
        h('div', { class: 'ui2-small', text: e.type.desc(e.intensity).replace('%s', where || 'body') || ' ' }),
        e.permanent ? null : h('div', { class: 'ui2-small ui2-dim', text: e.duration > 0 ? `About ${fmtDur(e.duration)} left` : '' }),
      ));
    }
    return out;
  }

  // ---------------------------------------------------------------- more (bionics & co)
  function moreTab(): HTMLElement {
    const list = extras();
    if (!list.length) return h('div', { class: 'ui2-empty', text: 'No bionics installed.' });
    return h('div', { class: 'cs-list' }, ...list.map((b) => h('div', { class: 'cs-card' }, h('div', { class: 'cs-card-title tone-accent', text: b.title }), h('div', { class: 'ui2-small cs-pre', html: b.body }))));
  }

  draw();
  return panel;
}

function kv(k: string, v: string, tone: string): HTMLElement {
  return h('div', { class: 'cs-kv' }, h('span', { class: 'ui2-dim', text: k }), h('span', { class: `tone-${tone}`, text: v }));
}

function fmtDur(s: number): string {
  if (s >= 86400) return `${Math.round(s / 86400)} d`;
  if (s >= 3600) return `${Math.round(s / 3600)} h`;
  if (s >= 60) return `${Math.round(s / 60)} min`;
  return `${Math.round(s)} s`;
}
