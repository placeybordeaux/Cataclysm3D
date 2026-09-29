// The ui2 construction screen (`*`) and in-world placement. Pick what to build from a
// searchable list (category tabs, each group with its stages: what it needs to stand on, what
// it becomes, skills, time, tools and materials as icon chips); "Place" closes the window and
// puts a ghost of the result on the tile under your crosshair — green where it can go, red
// where it can't, with the reason and the requirements in a card at the side. Left click
// builds there, right click or Esc cancels. The work shows a progress bar over the site.

import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Renderer } from '../../render/renderer';
import {
  canBuild, constructionGroups, constructionInventory, facingTile, groupName, siteProblem, stageFor, startConstruction, terOrFurnName, unfinishedAt,
  type ConstructionDef, type ConstructionGroup,
} from '../../game/construction';
import { formatDuration } from '../../game/crafting';
import type { CraftingInventory } from '../../game/crafting_inv';
import { evaluateRequirements } from '../../game/requirements';
import { cddaText } from '../../game/units';
import { LEVEL_HEIGHT } from '../../world/coords';
import { hasFlag } from '../../world/registry';
import { attachTooltip, button, h, iconEl, openPanel, palette, ui2Layers, type Panel } from '../../ui2';
import { itemIconRef, mapIconRef, rememberedWindow, requirementSections, searchField } from './common';
import './craft2.css';

const PANEL_ID = 'craft.construct';

/** What a stage turns the tile into (for icons and the ghost's shape). */
export function stageResult(con: ConstructionDef): string | null {
  return con.post_furniture ?? con.post_terrain ?? null;
}

/** Ghost shape: a full-height block for walls/doors, a crate for furniture, a slab for floors and pits. */
export function ghostHeight(game: Game, con: ConstructionDef): number {
  if (con.post_furniture) return 0.9;
  const t = con.post_terrain ? game.data.terrain[con.post_terrain] : null;
  if (!t) return 0.1;
  if (hasFlag(t, 'WALL') || hasFlag(t, 'DOOR') || hasFlag(t, 'WINDOW') || (t.move_cost ?? 1) === 0) return LEVEL_HEIGHT * 0.98;
  if (hasFlag(t, 'GOES_DOWN') || hasFlag(t, 'NO_FLOOR')) return 0.05;
  return 0.12;
}

export interface ConstructionScreen {
  panel: Panel;
  setQuery(q: string): void;
  select(groupId: string): boolean;
  rows(): string[];
  place(): void;
}

let screen: ConstructionScreen | null = null;
export function constructionScreen(): ConstructionScreen | null {
  return screen && !screen.panel.closed ? screen : null;
}

export function openConstructionScreen(game: Game, renderer: Renderer): ConstructionScreen {
  const open = constructionScreen();
  if (open) {
    open.panel.close();
    return open;
  }
  placement?.cancel();
  const data = game.data;
  const p = game.player;
  const cats = [
    { id: 'ALL', name: 'All' },
    ...Object.values((data.misc.construction_category ?? {}) as Record<string, { id: string; name: string }>).filter((k) => !['ALL', 'FILTER', 'FAVORITE', 'APPLIANCE'].includes(k.id)).map((k) => ({ id: k.id, name: cddaText(k.name) || k.id })),
  ];
  const groups = constructionGroups(data);
  let cat = 'ALL', query = '', sel: string | null = null, onlyHere = false;
  const inv = constructionInventory(game);
  const px = Math.floor(p.x), py = Math.floor(p.y);
  /** Group → can it go on some tile next to you, and can you build some stage of it. */
  const status = new Map<string, { site: boolean; build: boolean }>();
  for (const g of groups) {
    let site = false, build = false;
    for (const con of g.constructions) {
      const fits = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && siteProblem(game, con, px + dx, py + dy, p.z) === null));
      site ||= fits;
      if (fits && canBuild(game, con, inv).ok) build = true;
    }
    status.set(g.id, { site, build });
  }

  const search = searchField('Search constructions…', (v) => {
    query = v.toLowerCase();
    render();
  });
  const hereBtn = h('button', { class: 'c2-filter', text: 'Can build here', title: 'Only what fits a tile next to you' });
  hereBtn.addEventListener('click', () => {
    onlyHere = !onlyHere;
    render();
  });
  const catBar = h('div', { class: 'c2-cats' });
  const list = h('div', { class: 'c2-list' });
  const detail = h('div', { class: 'c2-detail' });
  const panel = openPanel({
    id: PANEL_ID,
    title: 'Construction',
    icon: itemIconRef(data, 'hammer'),
    width: 'min(calc(var(--fs) * 58), 96vw)',
    height: 'min(calc(var(--fs) * 34), 92vh)',
    group: 'construct',
    pauses: true,
    footer: 'Type to search · ↑↓ pick · Enter place in the world · Tab category · Esc close',
    onClose: () => void (screen = null),
  });
  panel.body.classList.add('c2-build');
  panel.body.append(h('div', { class: 'c2-top' }, search, hereBtn), catBar, h('div', { class: 'c2-main' }, h('div', { class: 'c2-left' }, list), detail));
  if (!rememberedWindow(PANEL_ID)) {
    const r = panel.el.getBoundingClientRect();
    panel.moveTo(Math.max(8, (innerWidth - r.width) / 2), Math.max(8, (innerHeight - r.height) / 2));
  }

  let rows: ConstructionGroup[] = [];
  const render = () => {
    hereBtn.classList.toggle('on', onlyHere);
    catBar.replaceChildren(
      ...cats.map((c) => {
        const b = h('button', { class: `c2-cat${c.id === cat ? ' on' : ''}`, text: c.name, data: { cat: c.id } });
        b.addEventListener('click', () => ((cat = c.id), render()));
        return b;
      }),
    );
    rows = groups
      .filter((g) => (query ? g.name.toLowerCase().includes(query) : cat === 'ALL' || g.categories.includes(cat)))
      .filter((g) => !onlyHere || status.get(g.id)!.site)
      .sort((a, b) => rank(b) - rank(a) || a.name.localeCompare(b.name));
    list.replaceChildren(
      ...rows.map((g) => {
        const st = status.get(g.id)!;
        const res = stageResult(g.constructions[g.constructions.length - 1]) ?? '';
        const el = h(
          'div',
          { class: `c2-row${st.build ? ' ok' : ''}${g.id === sel ? ' selected' : ''}`, data: { id: g.id } },
          iconEl(mapIconRef(data, res), 'row'),
          h('span', { class: 'c2-row-name', text: g.name }),
          st.build ? h('span', { class: 'tone-good ui2-small', text: 'ready' }) : st.site ? h('span', { class: 'ui2-dim ui2-small', text: 'fits' }) : null,
        );
        el.addEventListener('click', () => select(g.id));
        el.addEventListener('dblclick', () => place());
        return el;
      }),
    );
    if (!rows.length) list.append(h('div', { class: 'ui2-empty', text: 'Nothing matches.' }));
    if (!rows.some((g) => g.id === sel)) select(rows[0]?.id ?? null);
    else renderDetail();
  };
  const rank = (g: ConstructionGroup) => (status.get(g.id)!.build ? 2 : status.get(g.id)!.site ? 1 : 0);
  const select = (id: string | null) => {
    sel = id;
    list.querySelectorAll('.c2-row').forEach((r) => r.classList.toggle('selected', (r as HTMLElement).dataset.id === id));
    (list.querySelector('.c2-row.selected') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    renderDetail();
  };
  const renderDetail = () => {
    const g = groups.find((x) => x.id === sel);
    if (!g) return void detail.replaceChildren(h('div', { class: 'ui2-empty', text: 'Pick something to build.' }));
    const stages = g.constructions.map((con) => stageCard(game, con, inv, px, py));
    const st = status.get(g.id)!;
    detail.replaceChildren(
      h('div', { class: 'c2-head' }, iconEl(mapIconRef(data, stageResult(g.constructions[g.constructions.length - 1]) ?? ''), 'grid'), h('div', { class: 'c2-title', text: g.name })),
      h('div', { class: 'c2-scroll' }, ...stages),
      h(
        'div',
        { class: 'c2-actions' },
        h('span', { class: `ui2-small ${st.build ? 'tone-good' : st.site ? 'tone-warn' : 'ui2-dim'}`, text: st.build ? 'You can build this next to you.' : st.site ? 'It fits next to you, but something is missing.' : 'No spot next to you fits: walk to one and point at it.' }),
        h('span', { class: 'c2-spacer' }),
        button('Place…', () => place(), { tone: 'accent', key: 'Enter', title: 'Pick the spot in the world' }),
      ),
    );
  };
  const place = () => {
    const g = groups.find((x) => x.id === sel);
    if (!g) return;
    panel.close();
    startPlacement(game, renderer, g);
  };
  const onKey = (e: KeyboardEvent): boolean => {
    const i = rows.findIndex((g) => g.id === sel);
    if (e.key === 'Escape') panel.close();
    else if (e.key === 'ArrowDown') select(rows[Math.min(rows.length - 1, i + 1)]?.id ?? null);
    else if (e.key === 'ArrowUp') select(rows[Math.max(0, i - 1)]?.id ?? null);
    else if (e.key === 'Enter') place();
    else if (e.key === 'Tab') {
      const c = cats.findIndex((x) => x.id === cat);
      cat = cats[(c + (e.shiftKey ? -1 : 1) + cats.length) % cats.length].id;
      render();
    } else return false;
    return true;
  };
  search.addEventListener('keydown', (e) => {
    if (onKey(e)) (e.preventDefault(), e.stopPropagation());
  });
  render();
  requestAnimationFrame(() => search.focus());
  screen = {
    panel,
    setQuery: (q) => ((search.value = q), (query = q.toLowerCase()), render()),
    select: (id) => (rows.some((g) => g.id === id) ? (select(id), true) : false),
    rows: () => rows.map((g) => g.id),
    place,
  };
  return screen;
}

/** One stage: [needs] → [becomes], skills, time, note, requirement chips. */
function stageCard(game: Game, con: ConstructionDef, inv: CraftingInventory, px: number, py: number): HTMLElement {
  const data = game.data;
  const p = game.player;
  const fits = [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => (dx || dy) && siteProblem(game, con, px + dx, py + dy, p.z) === null));
  const pre = con.pre_furniture ?? con.pre_terrain;
  const post = stageResult(con);
  const head = h(
    'div',
    { class: 'c2-stage-head' },
    pre ? iconEl(mapIconRef(data, pre), 'row') : null,
    pre ? h('span', { text: terOrFurnName(data, pre) }) : h('span', { class: 'ui2-dim', text: con.pre_special === 'check_empty' ? 'empty ground' : con.pre_special === 'check_deconstruct' ? 'furniture / terrain' : 'site' }),
    h('span', { class: 'c2-arrow', text: '→' }),
    post ? iconEl(mapIconRef(data, post), 'row') : null,
    h('span', { text: post ? terOrFurnName(data, post) : con.post_special === 'done_deconstruct' ? 'taken apart' : groupName(data, con) }),
  );
  const skills = (con.required_skills ?? []).filter(([, l]) => l > 0);
  const facts = h(
    'div',
    { class: 'c2-facts' },
    h('div', { class: 'c2-fact' }, h('span', { class: 'ui2-dim', text: 'Time' }), h('span', { text: formatDuration(con.time) })),
    ...skills.map(([s, l]) => h('div', { class: 'c2-fact' }, h('span', { class: 'ui2-dim', text: 'Skill' }), h('span', { class: p.getSkill(s) >= l ? 'tone-good' : 'tone-bad', text: `${p.skillName(s)} ${l} (you ${p.getSkill(s)})` }))),
    con.dark_craftable ? h('div', { class: 'c2-fact' }, h('span', { class: 'ui2-dim', text: 'Works in the dark' })) : null,
  );
  const ev = evaluateRequirements(data, con, inv);
  const card = h('div', { class: `c2-stage${fits ? ' fits' : ''}` }, head, facts, con.pre_note ? h('div', { class: 'ui2-small ui2-dim', text: cddaText(con.pre_note) }) : null, ...requirementSections(data, ev, {}, { tools: 'Tools', comps: 'Materials' }));
  attachTooltip(head, () => (fits ? 'Fits a tile next to you' : 'No tile next to you fits this stage'));
  return card;
}

// ------------------------------------------------------------------ placement mode
interface Placement {
  group: ConstructionGroup;
  cancel(): void;
  /** The tile and stage the ghost is on now (automation). */
  target(): { x: number; y: number; z: number; stage: string | null; ok: boolean; why: string | null } | null;
  confirm(): boolean;
}
let placement: Placement | null = null;
const escHooked = new WeakSet<Game>();
export function currentPlacement(): Placement | null {
  return placement;
}

/** The tile you point at within reach: the crosshair's tile if it's next to you, else the one you face. */
function targetTile(game: Game): [number, number, number] {
  const p = game.player;
  const px = Math.floor(p.x), py = Math.floor(p.y);
  const hit = game.lookAt(2.6);
  if (hit && hit.kind !== 'ceiling' && hit.kind !== 'creature' && hit.z === p.z) {
    const d = Math.max(Math.abs(hit.x - px), Math.abs(hit.y - py));
    if (d === 1) return [hit.x, hit.y, hit.z];
  }
  return facingTile(game);
}

export function startPlacement(game: Game, renderer: Renderer, group: ConstructionGroup): Placement {
  placement?.cancel();
  const data = game.data;
  const canvas = renderer.three.domElement as HTMLCanvasElement;
  const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.good), transparent: true, opacity: 0.35, depthWrite: false });
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: new THREE.Color(palette.good), transparent: true }));
  box.renderOrder = 998;
  edges.renderOrder = 999;
  const ghost = new THREE.Group();
  ghost.add(box, edges);
  ghost.visible = false;
  renderer.scene.add(ghost);
  const card = ui2Layers().hud.appendChild(h('div', { class: 'c2-place', data: { testid: 'placement' } }));

  let inv = constructionInventory(game);
  let invAt = performance.now();
  let tgt: ReturnType<Placement['target']> = null;
  let stage: ConstructionDef | null = null;
  let lastKey = '';

  const update = () => {
    if (!placement || placement !== api) return;
    if (game.input.captured || game.player.dead) {
      ghost.visible = false;
      card.style.display = 'none';
      requestAnimationFrame(update);
      return;
    }
    card.style.display = '';
    const now = performance.now();
    if (now - invAt > 700) (inv = constructionInventory(game)), (invAt = now);
    const [x, y, z] = targetTile(game);
    stage = stageFor(game, group, x, y, z, inv);
    const probe = stage ?? group.constructions[0];
    const why = stage ? null : siteProblem(game, probe, x, y, z);
    const check = canBuild(game, probe, inv);
    const ok = !!stage && check.ok;
    tgt = { x, y, z, stage: stage?.id ?? null, ok, why: why ?? (check.ok ? null : check.missing[0]) };
    const hgt = ghostHeight(game, probe);
    ghost.position.set(x + 0.5, z * LEVEL_HEIGHT + hgt / 2 + 0.01, y + 0.5);
    ghost.scale.set(0.98, hgt, 0.98);
    const col = new THREE.Color(ok ? palette.good : palette.bad);
    mat.color.copy(col);
    (edges.material as THREE.LineBasicMaterial).color.copy(col);
    ghost.visible = true;
    const key = `${x},${y},${z},${probe.id},${ok},${tgt.why},${Math.floor(now / 1000)}`;
    if (key !== lastKey) {
      lastKey = key;
      renderCard(probe, check, ok, tgt.why);
    }
    requestAnimationFrame(update);
  };
  const renderCard = (con: ConstructionDef, check: ReturnType<typeof canBuild>, ok: boolean, why: string | null) => {
    const post = stageResult(con);
    card.replaceChildren(
      h('div', { class: 'c2-place-title' }, iconEl(mapIconRef(data, post ?? ''), 'row'), h('span', { text: group.name })),
      h('div', { class: `c2-place-state ${ok ? 'tone-good' : 'tone-bad'}`, text: ok ? `Ready: ${post ? terOrFurnName(data, post) : 'build here'} (${formatDuration(con.time)})` : why ?? "Can't build here" }),
      ...requirementSections(data, check.req, {}, { tools: 'Tools', comps: 'Materials' }),
      h('div', { class: 'c2-place-keys', html: '<kbd>Left click</kbd> build here · <kbd>Right click</kbd> / <kbd>Esc</kbd> cancel' }),
    );
  };

  const confirm = (): boolean => {
    if (!tgt || !stage || !tgt.ok) {
      game.message(tgt?.why ? `You can't build there: ${tgt.why}` : `You can't ${group.name.toLowerCase()} there.`, 'c_light_red');
      return false;
    }
    const s = stage, t = tgt;
    api.cancel();
    return startConstruction(game, s, t.x, t.y, t.z);
  };
  // Clicks while placing are for placing, not attacks: listen before Input's own handler.
  const onDown = (e: MouseEvent) => {
    if (game.input.captured || !game.input.locked) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.button === 0) confirm();
    else if (e.button === 2) {
      api.cancel();
      game.message('Never mind.', 'c_light_gray');
    }
  };
  canvas.addEventListener('mousedown', onDown, { capture: true });
  if (!escHooked.has(game)) {
    escHooked.add(game);
    // Esc while placing cancels (a browser-eaten Esc arrives as the lock loss below).
    game.input.onPress((e) => (placement && (e.key === 'Escape' || e.key === 'Backspace') ? (placement.cancel(), true) : false));
  }
  const onLock = () => {
    if (!game.input.locked && !game.input.captured) api.cancel();
  };
  document.addEventListener('pointerlockchange', onLock);

  const api: Placement = {
    group,
    cancel() {
      if (placement !== api) return;
      placement = null;
      canvas.removeEventListener('mousedown', onDown, { capture: true });
      document.removeEventListener('pointerlockchange', onLock);
      renderer.scene.remove(ghost);
      box.geometry.dispose();
      mat.dispose();
      edges.geometry.dispose();
      card.remove();
    },
    target: () => tgt,
    confirm,
  };
  placement = api;
  game.message(`Point at where to ${group.name.toLowerCase()}, then click. Right click to cancel.`, 'c_light_gray');
  requestAnimationFrame(update);
  return api;
}

/** Tiles with an unfinished construction near (x, y, z) (for world ghosts). */
export function unfinishedNear(game: Game, r = 10): { x: number; y: number; z: number }[] {
  const p = game.player;
  const out: { x: number; y: number; z: number }[] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (unfinishedAt(game, Math.floor(p.x) + dx, Math.floor(p.y) + dy, p.z)) out.push({ x: Math.floor(p.x) + dx, y: Math.floor(p.y) + dy, z: p.z });
  return out;
}
