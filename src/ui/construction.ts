import type { CraftHost } from '../game/crafting';
import { formatDuration } from '../game/crafting';
import {
  canBuild, constructionGroups, constructionInventory, facingTile, siteOk, startConstruction, terOrFurnName, validSites,
  type ConstructionDef, type ConstructionGroup,
} from '../game/construction';
import { requirementLines } from '../game/requirements';
import { c, colorize, openMenu, openWindow, prompt, type UiWindow } from './framework';
import './crafting.css';

// The `*` construction menu (construction.cpp construction_menu): category tabs, the list of
// construction groups ("Board Up Window", "Build Wooden Wall" …) — white when you could build
// one next to you right now, dark gray otherwise — and each stage's requirements on the right.
// Enter builds on the tile you face (or asks for a direction when several fit).

export interface ConstructionMenu {
  win: UiWindow;
  setFilter(f: string): void;
  select(groupId: string): boolean;
}

export function openConstructionMenu(game: CraftHost): ConstructionMenu {
  const data = game.data;
  const cats = Object.values((data.misc.construction_category ?? {}) as Record<string, { id: string; name: string }>).filter(
    (k) => k.id !== 'FILTER' && k.id !== 'APPLIANCE',
  );
  const groups = constructionGroups(data);
  let tab = 0, sel = 0, filter = '';
  let inv = constructionInventory(game);
  type Row = { g: ConstructionGroup; ok: boolean; sites: boolean };
  let rows: Row[] = [];
  const stageOk = (con: ConstructionDef) => canBuild(game, con, inv).ok;
  const build = () => {
    const cat = cats[tab]?.id ?? 'ALL';
    const f = filter.toLowerCase();
    rows = groups
      .filter((g) => (filter ? g.name.toLowerCase().includes(f) : cat === 'ALL' || g.constructions.some((con) => con.category === cat)))
      .map((g) => {
        const sites = g.constructions.some((con) => validSites(game, con).length > 0);
        const ok = sites && g.constructions.some((con) => validSites(game, con).length > 0 && stageOk(con));
        return { g, ok, sites };
      })
      .sort((a, b) => Number(b.ok) - Number(a.ok) || a.g.name.localeCompare(b.g.name));
    sel = Math.max(0, Math.min(sel, rows.length - 1));
  };

  const win = openWindow({
    title: 'Construction',
    width: 'min(112ch, 96vw)',
    height: '84vh',
    footer: `${c('c_light_green', 'Tab')}/${c('c_light_green', 'S-Tab')} category  ${c('c_light_green', '/')} search  ${c('c_light_green', 'Enter')} build`,
    onKey: (e) => {
      const k = e.key;
      if (k === 'ArrowDown' || k === 'j') move(1);
      else if (k === 'ArrowUp' || k === 'k') move(-1);
      else if (k === 'PageDown') move(15);
      else if (k === 'PageUp') move(-15);
      else if (k === 'Tab' || k === 'ArrowRight' || k === 'ArrowLeft') setTab(tab + (e.shiftKey || k === 'ArrowLeft' ? -1 : 1));
      else if (k === '/') void askFilter();
      else if (k === 'Enter') choose();
      else if ((k === 'Escape' || k === 'Backspace') && filter) {
        filter = '';
        render();
      } else return false; // unhandled: the framework closes on * / Esc / Bksp
      return true;
    },
  });
  win.body.innerHTML = `<div class="craft-body"><div class="craft-tabs main"></div><div class="craft-status"></div><div class="craft-cols"><div class="craft-list"></div><div class="craft-detail"></div></div></div>`;
  const tabsEl = win.body.querySelector('.craft-tabs') as HTMLElement;
  const statusEl = win.body.querySelector('.craft-status') as HTMLElement;
  const listEl = win.body.querySelector('.craft-list') as HTMLElement;
  const detailEl = win.body.querySelector('.craft-detail') as HTMLElement;

  function move(d: number) {
    sel = Math.max(0, Math.min(rows.length - 1, sel + d));
    render(false);
  }
  function setTab(t: number) {
    tab = (t + cats.length) % cats.length;
    sel = 0;
    filter = '';
    render();
  }
  async function askFilter() {
    const f = await prompt('Search:', filter);
    if (f === null) return;
    filter = f.trim();
    sel = 0;
    render();
  }

  function choose() {
    const row = rows[sel];
    if (!row) return;
    // Prefer the tile under the crosshair; otherwise any adjacent tile that works.
    const [fx, fy, fz] = facingTile(game);
    const candidates = row.g.constructions.filter((con) => stageOk(con));
    const facing = candidates.find((con) => siteOk(game, con, fx, fy, fz));
    if (facing) {
      if (startConstruction(game, facing, fx, fy, fz)) win.close();
      return;
    }
    const options = candidates.flatMap((con) => validSites(game, con).map((s) => ({ con, s })));
    if (!options.length) {
      const any = row.g.constructions.find((con) => validSites(game, con).length);
      game.message(any ? `You can't ${row.g.name.toLowerCase()}: ${canBuild(game, any, inv).missing.join('; ')}.` : `There is nowhere nearby to ${row.g.name.toLowerCase()}.`, 'c_light_red');
      return;
    }
    if (options.length === 1) {
      const { con, s } = options[0];
      if (startConstruction(game, con, s[0], s[1], s[2])) win.close();
      return;
    }
    openMenu({
      title: 'Build where?',
      entries: options.map(({ con, s }) => ({
        label: `${s[3]}: ${terOrFurnName(data, con.post_terrain ?? '') || con.id}`,
        value: { con, s },
      })),
      onSelect: ({ con, s }) => {
        if (startConstruction(game, con, s[0], s[1], s[2])) win.close();
      },
    });
  }

  function render(rebuild = true) {
    if (rebuild) {
      inv = constructionInventory(game);
      build();
    }
    tabsEl.innerHTML = cats.map((ct, i) => `<span class="tab${i === tab && !filter ? ' sel' : ''}" data-t="${i}">&lt;${ct.name}&gt;</span>`).join('');
    tabsEl.querySelectorAll<HTMLElement>('.tab').forEach((el) => (el.onclick = () => setTab(Number(el.dataset.t))));
    statusEl.innerHTML = filter ? `Searching: ${c('c_yellow', filter)}` : ' ';
    listEl.innerHTML = rows
      .map((r, i) => `<div class="row${i === sel ? ' sel' : ''}" data-i="${i}">${c(r.ok ? 'c_white' : 'c_dark_gray', r.g.name)}</div>`)
      .join('') || `<div class="row">${c('c_dark_gray', 'Nothing here.')}</div>`;
    listEl.querySelectorAll<HTMLElement>('.row[data-i]').forEach((el) => {
      const i = Number(el.dataset.i);
      el.onclick = () => (sel === i ? choose() : ((sel = i), render(false)));
    });
    (listEl.querySelector('.sel') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
    const row = rows[sel];
    detailEl.innerHTML = row ? colorize(detail(row.g).join('\n')) : '';
  }

  function detail(g: ConstructionGroup): string[] {
    const out: string[] = [`<color_white>${g.name}</color>`];
    const p = game.player;
    for (const con of g.constructions) {
      const ch = canBuild(game, con, inv);
      const sites = validSites(game, con);
      out.push('', '<color_light_blue>--------------------------------</color>');
      const skills = (con.required_skills ?? []).filter(([, l]) => l > 0);
      out.push(
        `Skills required: ${skills.length ? skills.map(([s, l]) => `<color_${p.getSkill(s) >= l ? 'green' : 'red'}>${p.skillName(s)} (${l})</color>`).join(', ') : '<color_green>N/A</color>'}`,
      );
      const pre = con.pre_terrain;
      if (pre) out.push(`Required terrain: <color_cyan>${terOrFurnName(data, pre)}</color>`);
      const flags = con.pre_flags === undefined ? [] : Array.isArray(con.pre_flags) ? con.pre_flags : [con.pre_flags];
      if (flags.length) out.push(`Required conditions: <color_cyan>${flags.join(', ')}</color>`);
      if (con.post_terrain) out.push(`Result: <color_cyan>${terOrFurnName(data, con.post_terrain)}</color>`);
      out.push(`Time to complete: <color_cyan>${formatDuration(con.time)}</color>`);
      if (con.pre_note) out.push(`<color_light_gray>${con.pre_note}</color>`);
      out.push(...requirementLines(ch.req));
      out.push(sites.length ? `Can build: <color_green>${sites.map((s) => s[3]).join(', ')}</color>` : '<color_red>No suitable spot next to you.</color>');
      if (!ch.light) out.push('<color_red>It is too dark to construct right now.</color>');
    }
    return out;
  }

  render();
  return {
    win,
    setFilter(f) {
      filter = f;
      sel = 0;
      render();
    },
    select(id) {
      const i = rows.findIndex((r) => r.g.id === id);
      if (i < 0) return false;
      sel = i;
      render(false);
      return true;
    },
  };
}
