// In-world feedback for crafting, construction, disassembly and reading (the activities that
// set `customUi`): a ui2 progress bar — over the site for constructions, under the crosshair
// otherwise — and, while reading, a card with the book, the chapter's progress, the skill it
// trains and what you've learned from it. Also: translucent ghosts over unfinished
// constructions nearby, so a half-done wall is visible as one.

import * as THREE from 'three';
import type { Game } from '../../game/game';
import type { Item } from '../../game/item';
import type { Renderer } from '../../render/renderer';
import { craftState } from '../../game/crafting';
import { unfinishedState } from '../../game/construction';
import { bookData, chaptersToLevel, reading, skillProgress, type ReadMode } from '../../game/reading';
import { cddaText } from '../../game/units';
import { LEVEL_HEIGHT } from '../../world/coords';
import { fmtDuration, h, iconEl, palette, progressBar, startProgress, ui2Layers, type ProgressHandle } from '../../ui2';
import { itemIconRef } from './common';
import { ghostHeight } from './construction_screen';
import './craft2.css';

export function installCraftOverlay(game: Game, renderer: Renderer): { state(): unknown } {
  let prog: ProgressHandle | null = null;
  let progFor: unknown = null;
  let readCard: HTMLElement | null = null;
  const v = new THREE.Vector3();
  const canvas = renderer.three.domElement as HTMLCanvasElement;

  const anchorFor = (at: { x: number; y: number; z: number }) => () => {
    const cam = renderer.camera;
    v.set(at.x + 0.5, at.z * LEVEL_HEIGHT + 1.3, at.y + 0.5).project(cam);
    if (v.z > 1 || v.z < -1) return null;
    const r = canvas.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  };

  // --- ghosts over unfinished constructions
  const ghostMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(palette.accent), transparent: true, opacity: 0.22, depthWrite: false });
  const ghostGeo = new THREE.BoxGeometry(1, 1, 1);
  const ghosts = new Map<string, THREE.Mesh>();
  let ghostScan = 0;
  const scanGhosts = () => {
    const p = game.player;
    const seen = new Set<string>();
    const R = 12;
    for (let dy = -R; dy <= R; dy++)
      for (let dx = -R; dx <= R; dx++) {
        const x = Math.floor(p.x) + dx, y = Math.floor(p.y) + dy;
        for (const it of game.map.itemsAt(x, y, p.z) as Item[]) {
          const st = typeof it.isCraft === 'function' ? unfinishedState(game.data, it) : null;
          if (!st) continue;
          const key = `${x},${y},${p.z}`;
          seen.add(key);
          const hgt = Math.max(0.1, ghostHeight(game, st.con) * Math.max(0.15, st.progress));
          let m = ghosts.get(key);
          if (!m) {
            m = new THREE.Mesh(ghostGeo, ghostMat);
            m.renderOrder = 997;
            renderer.scene.add(m);
            ghosts.set(key, m);
          }
          m.scale.set(0.96, hgt, 0.96);
          m.position.set(x + 0.5, p.z * LEVEL_HEIGHT + hgt / 2 + 0.01, y + 0.5);
        }
      }
    for (const [k, m] of ghosts)
      if (!seen.has(k)) {
        renderer.scene.remove(m);
        ghosts.delete(k);
      }
  };

  const frame = () => {
    const a = game.activities.current;
    const custom = a && a.spec.customUi ? a : null;
    // progress bar
    if (!custom || custom.spec.kind === 'read') {
      if (prog) prog.cancel(), (prog = null), (progFor = null);
    } else {
      if (progFor !== custom) {
        prog?.cancel();
        progFor = custom;
        prog = startProgress({ label: labelFor(game, custom.spec.name, custom.spec.target), anchor: custom.spec.at ? anchorFor(custom.spec.at) : undefined, hint: 'move to stop' });
      }
      const target = custom.spec.target as Item | undefined;
      const st = target && typeof target.isCraft === 'function' ? craftState(game.data, target) ?? unfinishedState(game.data, target) : null;
      const frac = st ? (st as { progress: number }).progress : custom.fraction;
      prog!.set(frac, `${Math.floor(frac * 100)}% · ${fmtDuration(Math.max(0, custom.spec.duration - custom.elapsed))}`);
    }
    // reading card
    if (custom?.spec.kind === 'read' && reading.current) {
      readCard ??= ui2Layers().hud.appendChild(h('div', { class: 'c2-read', data: { testid: 'reading' } }));
      renderRead(game, readCard, custom.fraction, custom.spec.duration - custom.elapsed);
    } else if (readCard) {
      readCard.remove();
      readCard = null;
    }
    const now = performance.now();
    if (now - ghostScan > 500) {
      ghostScan = now;
      scanGhosts();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return {
    state: () => ({ progress: prog ? progFor && (progFor as { spec: { name: string } }).spec.name : null, reading: !!readCard, ghosts: [...ghosts.keys()] }),
  };
}

function labelFor(game: Game, name: string, target: unknown): string {
  // "constructing Build Wood Wall" reads badly: the group name is already a verb phrase.
  const site = target as Item | undefined;
  if (site && typeof site.isCraft === 'function' && unfinishedState(game.data, site)) return site.baseName().replace(/^unfinished /, '');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

interface ReadUi {
  chapter: ReturnType<typeof progressBar>;
  skill: ReturnType<typeof progressBar>;
  book: Item | null;
  chapterText: HTMLElement;
  skillText: HTMLElement;
  lines: HTMLElement;
}
const bars = new WeakMap<HTMLElement, ReadUi>();

/** A "label ... value" line above a bar (the bars are too thin for text inside). */
function line(label: string): { el: HTMLElement; value: HTMLElement } {
  const value = h('span');
  return { el: h('div', { class: 'c2-read-line' }, h('span', { class: 'ui2-dim', text: label }), value), value };
}

/** The reading card's subtitle for each "Read …" choice. */
export function readModeText(mode: ReadMode, maxLevel?: number): string {
  if (mode === 'until_level') return 'Reading until you gain a level';
  if (mode === 'until_done') return `Reading until done${maxLevel ? ` (level ${maxLevel})` : ''}`;
  return 'Reading one chapter';
}

function renderRead(game: Game, card: HTMLElement, frac: number, left: number): void {
  const st = reading.current!;
  const b = bookData(st.book);
  let ui = bars.get(card);
  if (!ui || ui.book !== st.book) {
    const chapter = progressBar('accent');
    const skill = progressBar('info');
    skill.el.classList.add('c2-read-bar-skill');
    const cl = line('This chapter');
    const sl = line(b?.skill ? game.player.skillName(b.skill) : '');
    const lines = h('div', { class: 'ui2-small ui2-dim' });
    card.replaceChildren(
      ...[h('div', { class: 'c2-read-head' }, iconEl(itemIconRef(game.data, st.book.typeId), 'grid'), h('div', null, h('div', { class: 'c2-read-title', text: cddaText(st.book.def.name) }), h('div', { class: 'ui2-small ui2-dim', text: readModeText(st.mode, b?.level) }))),
      cl.el,
      chapter.el,
      b?.skill ? sl.el : null,
      b?.skill ? skill.el : null,
      lines,
      h('div', { class: 'ui2-small ui2-dim', text: 'Move to stop reading.' })].filter((e): e is HTMLDivElement => !!e),
    );
    ui = { chapter, skill, book: st.book, chapterText: cl.value, skillText: sl.value, lines };
    bars.set(card, ui);
  }
  ui.chapter.set(frac);
  ui.chapterText.textContent = `${fmtDuration(Math.max(0, left))} left`;
  if (b?.skill) {
    const lvl = game.player.getSkill(b.skill);
    const pct = skillProgress(game.player, b.skill);
    ui.skill.set(pct);
    ui.skillText.textContent = lvl >= b.level ? `level ${lvl} (all this book teaches)` : `level ${lvl} → ${lvl + 1}: ${Math.floor(pct * 100)}%`;
  }
  // "~3 chapters to level 2": how far the session goes, so a newcomer knows whether to sit
  // through it (or fast-forward it) before starting.
  const est = chaptersToLevel(game.player, st.book);
  const ahead = !est ? '' : st.mode === 'until_done' && est.maxLevel > est.nextLevel ? ` · ~${est.done} more to level ${est.maxLevel}` : ` · ~${est.next} more to level ${est.nextLevel}`;
  const text = `${st.sessions} chapter${st.sessions === 1 ? '' : 's'} read${ahead}${b?.skill ? ` · teaches up to level ${b.level}` : ''}`;
  if (ui.lines.textContent !== text) ui.lines.textContent = text;
}
