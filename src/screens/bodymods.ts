// Body screens (replace the curses menus): bionics (`p`), mutations (`[`), martial arts (`_`)
// and the Autodoc surgery flow. One shape for all three lists: grouped rows on the left (icon,
// name, cost/state chips, an ON/OFF switch for what can be toggled), the selected entry's
// card on the right, and a live bionic-power bar. The Autodoc screen shows what each
// operation means before you agree to it: odds, what can go wrong, anesthetic, time under.

import type { Game } from '../game/game';
import type { Item } from '../game/item';
import type { BodyMods } from '../game/bodymods';
import { BODY_PARTS, isBodyPart } from '../game/bodyparts';
import { cddaText } from '../game/units';
import { currentStyle, learnStyle, maOf, selectStyle, styleBuffs, styleDef, styleWeaponValid, traitStyleChoices, BUFF_TRIGGERS, type MartialArtDef } from '../game/martialarts';
import { techniqueDef } from '../game/techniques';
import { attachTooltip, button, confirmModal, h, iconEl, openPanel, tabs, type IconRef, type Panel, type Tone } from '../ui2';
import { chip, markup, meter, plain, section } from './common';
import { operationTime, surgeryPlan } from './logic/surgery';
import { beginInstall, beginUninstall } from '../ui/mutbio_ui';

// ------------------------------------------------------------------ the shared list/detail shape

interface Row {
  id: string;
  group: string;
  icon?: IconRef;
  name: string;
  tone?: Tone;
  chips?: HTMLElement[];
  /** Toggle state for activatable entries (a switch is drawn); undefined = not toggleable. */
  on?: boolean;
  /** Reason the switch can't be flipped now. */
  lockReason?: string;
}

interface ListPanelOpts {
  id: string;
  title: string;
  openKey: string;
  width?: string;
  empty: string;
  head: () => HTMLElement | null;
  rows: () => Row[];
  detail: (id: string) => HTMLElement[];
  /** Enter / double-click / the switch. */
  activate?: (id: string) => void;
  footer: string;
  /** Redraw every this many ms while open (power drains, buffs expire). */
  refreshMs?: number;
}

export interface ListPanelHandle {
  panel: Panel;
  select(id: string): void;
  redraw(): void;
}

function listPanel(o: ListPanelOpts): ListPanelHandle {
  let sel: string | null = null;
  const panel = openPanel({
    id: o.id,
    title: o.title,
    pauses: true,
    width: o.width ?? 'min(calc(var(--fs) * 56), 95vw)',
    height: 'min(84vh, calc(var(--fs) * 34))',
    footer: o.footer,
    onKey: (e) => {
      if (e.key === o.openKey && !e.repeat) return panel.close(), true;
      const rows = o.rows();
      const i = rows.findIndex((r) => r.id === sel);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const r = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
        if (r) (sel = r.id), draw();
        list.querySelector('.ix-brow.selected')?.scrollIntoView({ block: 'nearest' });
        return true;
      }
      if ((e.key === 'Enter' || e.key === ' ') && sel && o.activate) return o.activate(sel), draw(), true;
      return false;
    },
    onClose: () => timer && clearInterval(timer),
  });
  panel.el.classList.add('ix-body-win');
  const head = h('div', { class: 'ix-bhead' });
  const list = h('div', { class: 'ix-blist', attrs: { 'data-testid': `${o.id}-list` } });
  const detail = h('div', { class: 'ix-bdetail', attrs: { 'data-testid': `${o.id}-detail` } });
  panel.body.append(head, h('div', { class: 'ix-bmain' }, list, detail));
  panel.body.classList.add('ix-bbody');
  const timer = o.refreshMs ? setInterval(() => !panel.closed && draw(), o.refreshMs) : 0;

  function draw(): void {
    const hd = o.head();
    head.replaceChildren(...(hd ? [hd] : []));
    head.style.display = hd ? '' : 'none';
    const rows = o.rows();
    if (!sel || !rows.some((r) => r.id === sel)) sel = rows[0]?.id ?? null;
    const out: HTMLElement[] = [];
    let group = '';
    for (const r of rows) {
      if (r.group !== group) out.push(h('div', { class: 'ix-tgroup', text: (group = r.group) }));
      const sw = r.on === undefined ? null : h('button', { class: `ix-switch${r.on ? ' on' : ''}${r.lockReason ? ' locked' : ''}`, text: r.on ? 'ON' : 'OFF', title: r.lockReason ?? (r.on ? 'Click to turn off' : 'Click to turn on') });
      sw?.addEventListener('click', (e) => {
        e.stopPropagation();
        sel = r.id;
        o.activate?.(r.id);
        draw();
      });
      const el = h('div', { class: `ix-brow${r.id === sel ? ' selected' : ''}`, data: { id: r.id } },
        iconEl(r.icon, 'row'),
        h('span', { class: `ix-brow-name${r.tone ? ` tone-${r.tone}` : ''}`, text: r.name }),
        h('span', { class: 'ix-brow-chips' }, ...(r.chips ?? [])),
        sw);
      el.addEventListener('click', () => ((sel = r.id), draw()));
      el.addEventListener('dblclick', () => (o.activate?.(r.id), draw()));
      out.push(el);
    }
    list.replaceChildren(...(out.length ? out : [h('div', { class: 'ui2-empty', text: o.empty })]));
    detail.replaceChildren(...(sel ? o.detail(sel) : []));
  }
  draw();
  return { panel, select: (id) => ((sel = id), draw()), redraw: draw };
}

const partName = (bp: string) => (isBodyPart(bp) ? BODY_PARTS[bp].name : bp);
/** CDDA-style energy: "0.5 J", "25 J", "2 kJ". */
const energy = (v: number) => (v >= 1 ? `${+v.toFixed(2)} kJ` : `${+(v * 1000).toFixed(2)} J`);

function powerMeter(mods: BodyMods): HTMLElement | null {
  const { bio } = mods;
  const max = bio.maxPower();
  if (max <= 0) return null;
  const f = bio.power / max;
  return meter('Bionic power', f, `${bio.power >= 10 ? Math.round(bio.power) : bio.power.toFixed(1)} / ${Math.round(max)} kJ`, f >= 0.5 ? 'info' : f >= 0.25 ? 'warn' : 'bad', { cls: 'ix-power' });
}

// ------------------------------------------------------------------ bionics

export function openBionicsPanel(game: Game, mods: BodyMods): ListPanelHandle {
  const { bio } = mods;
  return listPanel({
    id: 'bionics',
    title: 'Bionics',
    openKey: game.keys.keyFor('bionics'),
    empty: 'You have no bionics installed. An Autodoc can install Compact Bionic Modules.',
    footer: `↑↓ choose · Enter / click the switch: turn on or off · ${game.keys.keyFor('bionics')} / Esc close`,
    refreshMs: 500,
    head: () => powerMeter(mods) ?? (bio.bionics.length ? h('div', { class: 'ui2-dim', text: 'No power storage installed: active bionics need a Power Storage CBM.' }) : null),
    rows: () =>
      bio.bionics
        .filter((b) => !b.included)
        .map((b) => {
          const d = bio.def(b.id);
          const act = bio.activatable(b);
          const chips: HTMLElement[] = [];
          if (d?.act_cost) chips.push(chip(energy(d.act_cost), 'dim', 'Power to turn it on'));
          if (d?.react_cost) chips.push(chip(`${energy(d.react_cost)}/${d.time ?? 1}t`, 'dim', 'Power while it runs, per turn(s)'));
          if (d?.capacity) chips.push(chip(`+${d.capacity} kJ`, 'info', 'Power storage'));
          const faulty = !!d?.flags?.includes('BIONIC_FAULTY');
          if (faulty) chips.push(chip('faulty', 'bad'));
          const toggled = !!d?.flags?.includes('BIONIC_TOGGLED');
          return {
            id: b.id,
            group: act ? 'Active' : 'Passive',
            icon: { typeId: b.id, symbol: '⌂', color: 'light_blue' },
            name: bio.name(b.id),
            tone: faulty ? 'bad' : b.powered ? 'good' : undefined,
            chips,
            on: act ? b.powered : undefined,
            lockReason: act && b.powered && !toggled ? 'Runs until it finishes' : act && !b.powered && (d?.act_cost ?? 0) > bio.power ? `Needs ${energy(d!.act_cost!)} of power` : undefined,
          } satisfies Row;
        })
        .sort((a, b) => Number(a.group === 'Passive') - Number(b.group === 'Passive') || a.name.localeCompare(b.name)),
    activate: (id) => {
      const b = bio.bionics.find((x) => x.id === id);
      if (b && bio.activatable(b)) bio.toggle(id);
    },
    detail: (id) => bionicCard(mods, id),
  });
}

function bionicCard(mods: BodyMods, id: string): HTMLElement[] {
  const { bio } = mods;
  const d = bio.def(id);
  if (!d) return [h('div', { text: id })];
  const b = bio.bionics.find((x) => x.id === id);
  const out: HTMLElement[] = [
    h('div', { class: 'ix-bcard-head' }, iconEl({ typeId: id, symbol: '⌂', color: 'light_blue' }, 'grid'), h('div', {}, h('div', { class: 'ix-dlg-name', text: bio.name(id) }),
      h('div', { class: 'ix-dlg-tags' }, b && bio.activatable(b) ? chip(b.powered ? 'On' : 'Off', b.powered ? 'good' : 'dim') : chip('Passive', 'dim'), d.flags?.includes('BIONIC_FAULTY') ? chip('Faulty: have it removed', 'bad') : null))),
    h('div', { class: 'ix-bdesc' }, markup(cddaText(d.description) || '')),
  ];
  const facts: [string, string][] = [];
  const occ = (d.occupied_bodyparts ?? []).map(([bp, n]) => `${partName(bp)} (${n})`);
  if (occ.length) facts.push(['Occupies', occ.join(', ')]);
  const costs: string[] = [];
  if (d.act_cost) costs.push(`${energy(d.act_cost)} to turn on`);
  if (d.react_cost) costs.push(`${energy(d.react_cost)} every ${d.time ?? 1} turn(s) while on`);
  if (d.trigger_cost) costs.push(`${energy(d.trigger_cost)} per use`);
  if (costs.length) facts.push(['Power', costs.join(', ')]);
  if (d.capacity) facts.push(['Stores', `${d.capacity} kJ`]);
  const protec = (['bash', 'cut', 'bullet'] as const).flatMap((k) => (d[`${k}_protec`] ?? []).map(([bp, v]) => `${partName(bp)} ${k} +${v}`));
  if (protec.length) facts.push(['Armor', protec.join(', ')]);
  if (d.stat_bonus?.length) facts.push(['Stats', d.stat_bonus.map(([s, n]) => `${s} ${n > 0 ? '+' : ''}${n}`).join(', ')]);
  if (d.fake_item) facts.push([d.flags?.includes('BIONIC_WEAPON') ? 'Weapon' : 'Provides', `${bio.c.data.items[d.fake_item]?.name ?? d.fake_item}${d.flags?.includes('BIONIC_WEAPON') ? ' (extends while on)' : ''}`]);
  if (facts.length) out.push(factGrid(facts));
  return out;
}

function factGrid(facts: [string, string][]): HTMLElement {
  return h('div', { class: 'ix-facts' }, ...facts.flatMap(([k, v]) => [h('span', { class: 'ui2-dim', text: k }), h('span', { text: v })]));
}

// ------------------------------------------------------------------ mutations

export function openMutationsPanel(game: Game, mods: BodyMods): ListPanelHandle {
  const { mut } = mods;
  const p = game.player;
  const catName = (c: string) => mut.idx.categories.get(c)?.name ?? c.toLowerCase().replace(/^./, (x) => x.toUpperCase());
  return listPanel({
    id: 'mutations',
    title: 'Mutations & traits',
    openKey: game.keys.keyFor('mutations'),
    empty: 'Nothing unusual about you (yet).',
    footer: `↑↓ choose · Enter / the switch: use an active mutation · ${game.keys.keyFor('mutations')} / Esc close`,
    refreshMs: 1000,
    head: () => {
      const levels = [...mut.categoryLevels()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const thresh = mut.thresholdCategory();
      if (!levels.length && !thresh) return null;
      return h('div', { class: 'ix-mut-head' },
        thresh ? chip(`Post-threshold: ${catName(thresh)}`, 'magic') : null,
        ...levels.map(([c, v]) => meter(catName(c), Math.min(1, v / 100), `${v}`, 'magic', { title: 'How far you have drifted toward this line (BN category level)' })));
    },
    rows: () =>
      [...p.traits]
        .filter((id) => mut.idx.visible(id))
        .map((id) => {
          const d = mut.idx.def(id);
          const pts = d?.points ?? 0;
          const cats = d?.category ?? [];
          return {
            id,
            group: d?.active ? 'Active' : mut.isBase(id) ? 'Traits' : 'Mutations',
            icon: { typeId: `overlay_male_mutation_${id}`, symbol: pts > 0 ? '+' : pts < 0 ? '-' : '~', color: pts > 0 ? 'light_green' : pts < 0 ? 'light_red' : 'yellow' },
            name: mut.name(id),
            tone: (pts > 0 ? 'good' : pts < 0 ? 'bad' : undefined) as Tone | undefined,
            chips: cats.slice(0, 1).map((c) => chip(catName(c), 'magic')),
            on: d?.active ? mut.isPowered(id) : undefined,
          } satisfies Row;
        })
        .sort((a, b) => ['Active', 'Mutations', 'Traits'].indexOf(a.group) - ['Active', 'Mutations', 'Traits'].indexOf(b.group) || a.name.localeCompare(b.name)),
    activate: (id) => {
      if (mut.idx.def(id)?.active) game.message(mut.toggle(id));
    },
    detail: (id) => {
      const d = mut.idx.def(id);
      const pts = d?.points ?? 0;
      const facts: [string, string][] = [];
      if (d?.category?.length) facts.push(['Line', d.category.map(catName).join(', ')]);
      facts.push(['Kind', mut.isBase(id) ? 'Innate trait' : 'Mutation']);
      if (d?.active) facts.push(['Use', mut.isPowered(id) ? 'On' : 'Off: turn it on to use it']);
      return [
        h('div', { class: 'ix-bcard-head' }, h('div', {}, h('div', { class: 'ix-dlg-name', text: mut.name(id) }),
          h('div', { class: 'ix-dlg-tags' }, chip(pts > 0 ? 'Beneficial' : pts < 0 ? 'Harmful' : 'Mixed', pts > 0 ? 'good' : pts < 0 ? 'bad' : 'warn')))),
        h('div', { class: 'ix-bdesc' }, markup(cddaText(d?.description) || '')),
        factGrid(facts),
      ];
    },
  });
}

// ------------------------------------------------------------------ martial arts

export function openMartialArtsPanel(game: Game): ListPanelHandle {
  const p = game.player;
  const ma = maOf(p);
  const h0 = listPanel({
    id: 'martialarts',
    title: 'Martial arts',
    openKey: game.keys.keyFor('martial_arts'),
    empty: 'You know no styles.',
    footer: `↑↓ choose · Enter: use (or learn) the style · ${game.keys.keyFor('martial_arts')} / Esc close`,
    refreshMs: 500,
    head: () => {
      const st = currentStyle(p);
      const buffs = [...ma.buffs.values()];
      return h('div', { class: 'ix-ma-head' }, h('span', { class: 'ui2-dim', text: 'Style: ' }), h('span', { class: 'tone-accent', text: st.name }),
        ...buffs.map((b) => chip(`${b.def.name}${b.stacks > 1 ? ` ×${b.stacks}` : ''}`, 'good', `${Math.ceil(b.left)} s left`)));
    },
    rows: () => {
      const known = [...ma.known].map((id) => styleDef(game.data, id)).filter((s): s is MartialArtDef => !!s)
        .sort((a, b) => (a.id === 'style_none' ? -1 : b.id === 'style_none' ? 1 : a.name.localeCompare(b.name)));
      const rows: Row[] = known.map((st) => ({
        id: st.id,
        group: 'Known styles',
        name: st.name,
        tone: st.id === ma.style ? 'accent' : undefined,
        chips: [st.id === ma.style ? chip('In use', 'accent') : null, p.inv.wielded && !styleWeaponValid(st, p.inv.wielded) && st.id !== 'style_none' ? chip('not with this weapon', 'warn') : null].filter((x): x is HTMLElement => !!x),
      }));
      for (const id of traitStyleChoices(p)) {
        const st = styleDef(game.data, id);
        if (st) rows.push({ id, group: 'Your training: learn one', name: st.name, tone: 'warn', chips: [chip('learnable', 'warn')] });
      }
      return rows;
    },
    activate: (id) => {
      if (!ma.known.has(id)) {
        learnStyle(p, id);
        selectStyle(p, id);
      } else if (id !== ma.style) selectStyle(p, id);
    },
    detail: (id) => styleCard(game, id),
  });
  return h0;
}

function styleCard(game: Game, id: string): HTMLElement[] {
  const p = game.player;
  const st = styleDef(game.data, id);
  if (!st) return [];
  const out: HTMLElement[] = [h('div', { class: 'ix-dlg-name', text: st.name })];
  if (st.description) out.push(h('div', { class: 'ix-bdesc' }, markup(cddaText(st.description))));
  const w = p.inv.wielded;
  if (w && st.id !== 'style_none' && !styleWeaponValid(st, w)) out.push(h('div', { class: 'tone-warn', text: `Can't be used with your ${plain(w.baseName())}.` }));
  const weapons = (st.weapon_category ?? []).map((cat) => (game.data.misc?.weapon_category?.[cat]?.name as string | undefined) ?? cat);
  if (st.allow_melee) out.push(h('div', { class: 'ui2-dim', text: 'Works with any weapon.' }));
  else if (weapons.length) out.push(h('div', { class: 'ui2-dim', text: `Weapons: ${weapons.join(', ')}` }));
  const buffs = BUFF_TRIGGERS.flatMap((t) => styleBuffs(game.data, st, t).map((b) => [b, t] as const));
  if (buffs.length) {
    out.push(section('Buffs'));
    out.push(h('div', { class: 'ix-chiplist' }, ...buffs.map(([b, t]) => {
      const c = chip(`${b.name} · ${t === 'static' ? 'always' : t.replace(/^on/, 'on ')}`, 'good');
      if (b.description) attachTooltip(c, () => plain(cddaText(b.description as string)));
      return c;
    })));
  }
  const tecs = (st.techniques ?? []).map((tid) => techniqueDef(game.data, tid)).filter((t) => !!t);
  if (tecs.length) {
    out.push(section('Techniques'));
    for (const t of tecs) {
      const req = (t!.skill_requirements ?? []).map((s) => `${p.skillName(s.name)} ${s.level}`).join(', ');
      const met = (t!.skill_requirements ?? []).every((s) => p.getSkill(s.name) >= s.level);
      out.push(h('div', { class: 'ix-tec' }, h('span', { class: met ? 'tone-info' : 'ui2-dim', text: t!.name }), req ? chip(req, met ? 'good' : 'bad', met ? 'You have the skill' : 'Not yet: train your skills') : null));
    }
  }
  if (!maOf(p).known.has(id)) out.push(button('Learn this style', () => (learnStyle(p, id), selectStyle(p, id)), { tone: 'accent', key: 'Enter' }));
  else if (maOf(p).style !== id) out.push(button('Use this style', () => selectStyle(p, id), { tone: 'accent', key: 'Enter' }));
  return out;
}

// ------------------------------------------------------------------ Autodoc

export interface AutodocHandle {
  panel: Panel;
  /** Select a CBM (install tab) or an installed bionic (uninstall tab). */
  select(id: string): void;
  begin(): Promise<boolean>;
}

/**
 * The Autodoc (iexamine::autodoc): pick a CBM from what you carry or what lies next to the
 * couch, read what the operation means, then agree to it (one confirmation that restates the
 * odds). Uninstalling works the same way on installed bionics.
 */
export function openAutodocPanel(game: Game, mods: BodyMods, cbms: () => { item: Item; consume: () => void }[], dropItem: (it: Item) => void): AutodocHandle {
  const { bio } = mods;
  const p = game.player;
  let tab: 'install' | 'remove' = 'install';
  let sel: string | null = null;
  const panel = openPanel({
    id: 'autodoc',
    title: 'Autodoc Mk. XI',
    pauses: true,
    width: 'min(calc(var(--fs) * 58), 95vw)',
    height: 'min(86vh, calc(var(--fs) * 36))',
    footer: '↑↓ choose · Enter: begin the operation · ←→ install / remove · Esc close',
    onKey: (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') return t.set(tab === 'install' ? 'remove' : 'install'), true;
      const ids = entries().map((x) => x.id);
      const i = ids.indexOf(sel ?? '');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        sel = ids[Math.max(0, Math.min(ids.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))] ?? null;
        draw();
        return true;
      }
      if (e.key === 'Enter') return void begin(), true;
      return false;
    },
  });
  panel.el.classList.add('ix-autodoc-win');
  const t = tabs([{ id: 'install', label: 'Install a CBM' }, { id: 'remove', label: 'Remove a bionic' }], tab, (id) => {
    tab = id as typeof tab;
    sel = null;
    draw();
  });
  const status = h('div', { class: 'ix-doc-status' });
  const list = h('div', { class: 'ix-blist', attrs: { 'data-testid': 'autodoc-list' } });
  const detail = h('div', { class: 'ix-bdetail', attrs: { 'data-testid': 'autodoc-detail' } });
  panel.body.append(status, t.el, h('div', { class: 'ix-bmain' }, list, detail));
  panel.body.classList.add('ix-bbody');

  type Entry = { id: string; name: string; item?: Item; consume?: () => void };
  function entries(): Entry[] {
    if (tab === 'install') {
      const seen = new Map<string, number>();
      return cbms().map((c) => {
        // Two of the same CBM are two entries: key them apart.
        const n = (seen.get(c.item.typeId) ?? 0) + 1;
        seen.set(c.item.typeId, n);
        return { id: `${c.item.typeId}#${n}`, name: plain(c.item.name()), item: c.item, consume: c.consume };
      });
    }
    return bio.bionics.filter((b) => !b.included).map((b) => ({ id: b.id, name: bio.name(b.id) }));
  }

  function draw(): void {
    const kits = bio.anesthesiaAvailable();
    status.replaceChildren(
      h('span', { class: 'tone-good', text: 'Status: online.' }),
      h('span', { class: 'ui2-dim', text: ` Patient: ${p.name}.` }),
      chip(bio.needsAnesthesia() ? `Anesthetic at hand: ${kits}` : 'No anesthetic needed (you feel no pain)', bio.needsAnesthesia() ? (kits > 0 ? 'info' : 'warn') : 'good'),
    );
    const es = entries();
    if (!sel || !es.some((e) => e.id === sel)) sel = es[0]?.id ?? null;
    list.replaceChildren(
      ...(es.length
        ? es.map((e) => {
            const chance = e.item ? surgeryPlan(bio, e.item, (id) => p.traitName(id)).chance : bio.successChance(e.id, true);
            const blocked = e.item ? surgeryPlan(bio, e.item, (id) => p.traitName(id)).blocker : null;
            const row = h('div', { class: `ix-brow${e.id === sel ? ' selected' : ''}`, data: { id: e.id } },
              iconEl({ typeId: e.item?.typeId ?? e.id, symbol: '⌂', color: 'light_blue' }, 'row'),
              h('span', { class: `ix-brow-name${blocked ? ' ui2-dim' : ''}`, text: e.name }),
              h('span', { class: 'ix-brow-chips' }, blocked ? chip("can't", 'bad', blocked) : chip(`${chance}%`, chance >= 75 ? 'good' : chance >= 40 ? 'warn' : 'bad', 'Chance the operation goes without complications')));
            row.addEventListener('click', () => ((sel = e.id), draw()));
            row.addEventListener('dblclick', () => void begin());
            return row;
          })
        : [h('div', { class: 'ui2-empty', text: tab === 'install' ? 'No Compact Bionic Modules here. Carry them, or put them next to the Autodoc.' : 'You have no bionics to remove.' })]),
    );
    const e = es.find((x) => x.id === sel);
    detail.replaceChildren(...(e ? (e.item ? installCard(e.item) : removeCard(e.id)) : []));
  }

  function installCard(it: Item): HTMLElement[] {
    const plan = surgeryPlan(bio, it, (id) => p.traitName(id));
    const out: HTMLElement[] = [
      h('div', { class: 'ix-bcard-head' }, iconEl({ typeId: it.typeId, symbol: '⌂', color: 'light_blue' }, 'grid'), h('div', {}, h('div', { class: 'ix-dlg-name', text: plan.name }), h('div', { class: 'ui2-dim ui2-small', text: `Difficulty ${plan.difficulty}` }))),
      h('div', { class: 'ix-odds' },
        meter('Success', plan.chance / 100, `${plan.chance}%`, plan.chanceTone, { cls: 'ix-odds-meter', title: 'BN: the Autodoc always installs; a failed roll means complications' }),
        h('div', { class: `ix-odds-risk tone-${plan.chanceTone}`, text: plan.chance >= 100 ? 'No risk of complications.' : `${100 - plan.chance}% chance of complications.` })),
    ];
    const facts: [string, string][] = [['Time under', operationTime(plan.seconds)]];
    if (plan.anesthesia.required) facts.push(['Anesthetic', `${plan.anesthesia.needed} needed, ${plan.anesthesia.have} at hand`]);
    if (plan.program) facts.push(['Program', `${plan.program.name}: ${plan.program.have ? 'loaded (the Autodoc works at skill 10)' : 'not at hand (it would raise the odds)'}`]);
    if (plan.parts.length) facts.push(['Occupies', plan.parts.join(', ')]);
    if (plan.capacity) facts.push(['Adds', `${plan.capacity} kJ of power storage`]);
    if (plan.upgrades) facts.push(['Replaces', plan.upgrades]);
    out.push(factGrid(facts));
    if (plan.removesTraits.length) out.push(h('div', { class: 'tone-warn', text: `Removes: ${plan.removesTraits.join(', ')}` }));
    if (plan.chance < 100) {
      out.push(section('If it goes wrong'));
      out.push(h('ul', { class: 'ix-risks' }, ...plan.risks.map((r) => h('li', { text: r }))));
    }
    const d = bio.def(plan.bionicId);
    if (d?.description) out.push(h('div', { class: 'ix-bdesc' }, markup(cddaText(d.description))));
    out.push(plan.blocker ? h('div', { class: 'ix-blocker tone-bad', text: plan.blocker }) : button('Begin the operation', () => void begin(), { tone: 'accent', key: 'Enter' }));
    return out;
  }

  function removeCard(id: string): HTMLElement[] {
    const chance = bio.successChance(id, true);
    const tone: Tone = chance >= 75 ? 'good' : chance >= 40 ? 'warn' : 'bad';
    return [
      h('div', { class: 'ix-bcard-head' }, iconEl({ typeId: id, symbol: '⌂', color: 'light_blue' }, 'grid'), h('div', { class: 'ix-dlg-name', text: bio.name(id) })),
      h('div', { class: 'ix-odds' }, meter('Success', chance / 100, `${chance}%`, tone, { cls: 'ix-odds-meter' })),
      factGrid([['Time under', operationTime(Math.max(1, bio.idx.difficulty(id)) * 20 * 60)], ['On success', 'The used module is set down next to you (not sterile).'], ['On failure', 'It stays in; you are hurt (pain).']]),
      button('Begin the removal', () => void begin(), { tone: 'accent', key: 'Enter' }),
    ];
  }

  async function begin(): Promise<boolean> {
    const e = entries().find((x) => x.id === sel);
    if (!e) return false;
    if (e.item) {
      const plan = surgeryPlan(bio, e.item, (id) => p.traitName(id));
      if (plan.blocker) return false;
      const ok = await confirmModal({
        title: `Install ${plan.name}?`,
        body: h('div', { class: 'ix-confirm' },
          h('div', { class: `tone-${plan.chanceTone}`, text: plan.chance >= 100 ? 'The Autodoc reports no risk.' : `${plan.chance}% success · ${100 - plan.chance}% chance of complications.` }),
          plan.removesTraits.length ? h('div', { class: 'tone-warn', text: `It removes: ${plan.removesTraits.join(', ')}.` }) : null,
          h('div', { text: `You'll be under for ${operationTime(plan.seconds)}${plan.anesthesia.required ? `, using ${plan.anesthesia.needed} anesthetic` : ''}. The module is used up either way.` })),
        ok: 'Operate',
        danger: plan.chance < 100,
      });
      if (!ok || panel.closed) return false;
      panel.close();
      return beginInstall(game, mods, e.item, { autodoc: true, consumeItem: () => e.consume!(), dropItem });
    }
    const chance = bio.successChance(e.id, true);
    const ok = await confirmModal({ title: `Remove ${e.name}?`, body: `${chance}% chance of success. On failure it stays in and you are hurt.`, ok: 'Operate', danger: true });
    if (!ok || panel.closed) return false;
    panel.close();
    return beginUninstall(game, mods, e.id, dropItem);
  }

  draw();
  return {
    panel,
    select: (id) => ((sel = entries().find((e) => e.id === id || e.id.startsWith(`${id}#`))?.id ?? sel), draw()),
    begin,
  };
}
