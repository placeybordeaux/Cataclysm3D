import { withSceneAppearance } from './appearance';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import { h, ui2Layers, button } from '../ui2';
import { registeredOptions } from '../ui/options';
import { offsetToPixels } from '../game/aimmodel';
import { buildSwitches, type GallerySwitch } from './switches';
import { SCENES, loadViews, resetWorld, sceneById, type Scene, type SceneCtx } from './scenes';
import { captureFrame, pixelDiff, toUrl } from './capture';
import { openMapJournal } from '../world/mapJournal';
import './gallery.css';

// The style gallery (docs/GALLERY.md): `/?gallery`. The real renderer on seed 1, the simulation
// paused, a list of deterministic scenes on the left, every wave-3 variant as a switch on the
// right, and three ways to compare: Live (flip and look), A/B (one switch, two values, same
// frame) and Matrix (one switch across several scenes). Debug `cdda.*` setup is fine here: this
// page is a tool, not play. Loaded only for `?gallery` (main.ts), so normal play never runs it.

export interface GalleryDeps {
  game: Game;
  renderer: Renderer;
  api: DebugApi;
}

type Mode = 'live' | 'ab' | 'matrix';
type AbView = 'side' | 'flicker' | 'slider';

interface AbResult {
  sw: string;
  a: string;
  b: string;
  scene: string;
  urlA: string;
  urlB: string;
  diff: number;
}

export async function runGallery({ game, renderer, api }: GalleryDeps): Promise<void> {
  document.body.classList.add('gallery');
  document.title = 'Style gallery - Cataclysm3D';
  game.paused = true;
  api.godMode(true);
  await loadViews();
  const switches = buildSwitches(renderer, api);
  const swById = (id: string): GallerySwitch => {
    const s = switches.find((q) => q.id === id);
    if (!s) throw new Error(`gallery: unknown switch "${id}" (have ${switches.map((q) => q.id).join(', ')})`);
    return s;
  };
  /** What the game would boot with (stored Options + URL): "Revert" goes back here. */
  const saved: Record<string, string> = Object.fromEntries(switches.map((s) => [s.id, s.get()]));
  const bootSeconds = game.clock.seconds;
  const ctx: SceneCtx = { lights: [] };
  // scenes plant trees, light fires and leave bodies: undone before the next scene
  const journal = openMapJournal(game.map);
  const params = new URLSearchParams(location.search);

  // ------------------------------------------------------------------ state
  const st = {
    mode: 'live' as Mode,
    scene: null as Scene | null,
    frozen: true,
    busy: 0,
    status: '',
    cam: null as { x: number; y: number; z: number; yaw: number; pitch: number } | null,
    ab: { sw: 'look', a: '', b: '', view: 'side' as AbView, showB: false, slider: 0.5, result: null as AbResult | null },
    matrix: { sw: 'look', scenes: new Set<string>(['street', 'horde', 'kitchen']), rows: [] as { scene: string; cells: { v: string; url: string }[] }[] },
    errors: [] as string[],
  };

  // Everything that touches the world runs one at a time.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    const run = async () => {
      st.busy++;
      setStatus(what);
      try {
        return await fn();
      } catch (e) {
        const msg = `${what}: ${(e as Error).message}`;
        st.errors.push(msg);
        console.error('[gallery]', e);
        setStatus(msg, true);
        throw e;
      } finally {
        st.busy--;
        if (!st.busy && !statusEl.classList.contains('bad')) setStatus('');
        refresh();
      }
    };
    const p = chain.then(run, run);
    chain = p.catch(() => undefined);
    return p;
  };

  /** UI handlers: a failure is already in the status line (and st.errors); don't leave it unhandled. */
  const quiet = (p: Promise<unknown>) => void p.catch((e) => setStatus(String((e as Error).message ?? e), true));
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Build everything a switch or scene change invalidated and let async bits (vehicle skins) land. */
  const stabilize = async () => {
    api.settle();
    for (let i = 0; i < 4; i++) await frame();
    await sleep(150);
    api.settle();
    for (let i = 0; i < 120 && renderer.chunks.stats.pending > 0; i++) await frame();
    await frame();
  };

  const applyFreeze = () => void (renderer.timeScale = st.frozen ? 0 : 1);

  // ------------------------------------------------------------------ DOM
  const L = ui2Layers();
  const root = h('div', { class: 'ui2-layer gal-layer', attrs: { 'data-testid': 'gallery' } });
  L.root.append(root);

  const sceneList = h('div', { class: 'gal-scenes' });
  const left = h('div', { class: 'gal-panel gal-left' },
    h('div', { class: 'gal-title', text: 'Style gallery' }),
    h('div', { class: 'gal-hint', text: '↑/↓ scene · drag to look · WASD move · R reset camera · F freeze' }),
    sceneList);
  const swList = h('div', { class: 'gal-switches' });
  const statusEl = h('div', { class: 'gal-status' });
  const right = h('div', { class: 'gal-panel gal-right' },
    h('div', { class: 'gal-title', text: 'Switches' }),
    swList,
    h('div', { class: 'gal-defaults' },
      button('Revert to my saved', () => quiet(revert('saved')), { small: true, title: 'Every switch back to what the game boots with (your Options).' }),
      button('Factory defaults', () => quiet(revert('factory')), { small: true, title: 'Every switch back to what the game ships with.' }),
      button('Copy these as my defaults', () => quiet(copyDefaults()), { small: true, tone: 'accent', title: 'Write the current values into Options (persisted exactly as the Options screen does).' })),
    statusEl);

  const modeBar = h('div', { class: 'gal-modes' });
  const sceneTitle = h('div', { class: 'gal-scene-title' });
  const tools = h('div', { class: 'gal-tools' });
  const view = h('div', { class: 'gal-view', attrs: { 'data-testid': 'gallery-view' } });
  const sway = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  sway.classList.add('gal-sway');
  view.append(sway);
  const abPane = h('div', { class: 'gal-pane gal-ab' });
  const mxPane = h('div', { class: 'gal-pane gal-matrix' });
  const lightbox = h('div', { class: 'gal-lightbox' });
  const center = h('div', { class: 'gal-center' }, h('div', { class: 'gal-top' }, modeBar, sceneTitle, tools), h('div', { class: 'gal-stage' }, view, abPane, mxPane));
  root.append(left, center, right, lightbox);

  // The 3D canvas sits exactly under the stage (not under the side panels): the renderer sizes
  // its drawing buffer from the stage and the page places the canvas there.
  const canvas = renderer.three.domElement;
  const stage = center.querySelector('.gal-stage') as HTMLElement;
  const stageRect = () => stage.getBoundingClientRect();
  renderer.sizeOverride = () => {
    const r = stageRect();
    return { w: Math.max(64, Math.round(r.width)), h: Math.max(64, Math.round(r.height)) };
  };
  const placeCanvas = () => {
    const r = stageRect();
    Object.assign(canvas.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto' });
    renderer.resize();
  };
  window.addEventListener('resize', placeCanvas);
  new ResizeObserver(placeCanvas).observe(stage);
  placeCanvas();

  function setStatus(text: string, bad = false): void {
    st.status = text;
    statusEl.textContent = text;
    statusEl.classList.toggle('bad', bad);
    root.classList.toggle('busy', st.busy > 0);
  }

  // --- scenes (left)
  let lastGroup = '';
  for (const s of SCENES) {
    if (s.group !== lastGroup) {
      sceneList.append(h('div', { class: 'gal-group', text: s.group }));
      lastGroup = s.group;
    }
    sceneList.append(h('button', { class: 'gal-scene', text: s.label, data: { scene: s.id }, title: s.id, on: { click: () => quiet(showScene(s.id)) } }));
  }

  // --- switches (right)
  const rows = new Map<string, HTMLElement>();
  let lastSg = '';
  for (const sw of switches) {
    if (sw.group !== lastSg) {
      swList.append(h('div', { class: 'gal-group', text: sw.group }));
      lastSg = sw.group;
    }
    const seg = h('div', { class: 'gal-seg' });
    for (const v of sw.values)
      seg.append(h('button', { class: 'gal-segbtn', text: v.label, data: { switch: sw.id, value: v.v }, title: `${sw.id}=${v.v}`, on: { click: () => quiet(setSwitch(sw.id, v.v)) } }));
    const hint = [sw.option ? `Options > ${sw.option}` : 'not in Options', sw.url ? `?${sw.url}=` : ''].filter(Boolean).join(' · ');
    const row = h('div', { class: 'gal-sw', data: { switch: sw.id } },
      h('div', { class: 'gal-swhead' }, h('span', { class: 'gal-swname', text: sw.label }), h('span', { class: 'gal-swhint', text: hint })),
      seg,
      sw.note ? h('div', { class: 'gal-swnote', text: sw.note }) : null);
    rows.set(sw.id, row);
    swList.append(row);
  }

  // --- modes (top)
  const modeBtns = (['live', 'ab', 'matrix'] as Mode[]).map((m) =>
    h('button', { class: 'gal-mode', data: { mode: m }, text: m === 'live' ? 'Live' : m === 'ab' ? 'A/B' : 'Matrix', on: { click: () => setMode(m) } }));
  modeBar.append(...modeBtns);
  tools.append(
    button('Reset camera', () => resetCamera(), { small: true, key: 'R' }),
    h('button', { class: 'ui2-btn small gal-freeze', on: { click: () => toggleFreeze() } }),
    button('Re-run scene', () => st.scene && quiet(showScene(st.scene.id)), { small: true }),
  );

  // --- A/B pane
  const swOptions = (sel: HTMLSelectElement, cur: string) => {
    sel.replaceChildren(...switches.map((s) => h('option', { text: `${s.group}: ${s.label}`, attrs: { value: s.id } })));
    sel.value = cur;
  };
  const valOptions = (sel: HTMLSelectElement, sw: GallerySwitch, cur: string) => {
    sel.replaceChildren(...sw.values.map((v) => h('option', { text: v.label, attrs: { value: v.v } })));
    sel.value = cur;
  };
  const abSw = h('select', { class: 'gal-select', attrs: { 'data-testid': 'ab-switch' } });
  const abA = h('select', { class: 'gal-select', attrs: { 'data-testid': 'ab-a' } });
  const abB = h('select', { class: 'gal-select', attrs: { 'data-testid': 'ab-b' } });
  const abDefaults = () => {
    const sw = swById(st.ab.sw);
    const cur = sw.get();
    st.ab.a = cur;
    st.ab.b = sw.values[(sw.values.findIndex((v) => v.v === cur) + 1) % sw.values.length].v;
    valOptions(abA, sw, st.ab.a);
    valOptions(abB, sw, st.ab.b);
  };
  swOptions(abSw, st.ab.sw);
  abDefaults();
  abSw.addEventListener('change', () => {
    st.ab.sw = abSw.value;
    abDefaults();
  });
  abA.addEventListener('change', () => void (st.ab.a = abA.value));
  abB.addEventListener('change', () => void (st.ab.b = abB.value));
  const abViewBtns = (['side', 'flicker', 'slider'] as AbView[]).map((v) =>
    h('button', { class: 'gal-segbtn', data: { abview: v }, text: v === 'side' ? 'side by side' : v, on: { click: () => ((st.ab.view = v), drawAb()) } }));
  const abOut = h('div', { class: 'gal-about' });
  abPane.append(
    h('div', { class: 'gal-controls' },
      h('span', { text: 'Switch' }), abSw, h('span', { text: 'A' }), abA, h('span', { text: 'B' }), abB,
      button('Render A/B', () => quiet(runAb()), { small: true, tone: 'accent', key: 'Enter' }),
      h('div', { class: 'gal-seg' }, ...abViewBtns),
      button('Flip', () => flipAb(), { small: true, key: 'Space' })),
    abOut);

  // --- Matrix pane
  const mxSw = h('select', { class: 'gal-select', attrs: { 'data-testid': 'mx-switch' } });
  swOptions(mxSw, st.matrix.sw);
  mxSw.addEventListener('change', () => void (st.matrix.sw = mxSw.value));
  const mxScenes = h('div', { class: 'gal-chips' });
  const drawChips = () =>
    mxScenes.replaceChildren(...SCENES.map((s) =>
      h('button', { class: `gal-chip${st.matrix.scenes.has(s.id) ? ' on' : ''}`, text: s.label, data: { chip: s.id }, on: { click: () => (st.matrix.scenes.has(s.id) ? st.matrix.scenes.delete(s.id) : st.matrix.scenes.add(s.id), drawChips()) } })));
  drawChips();
  const mxGrid = h('div', { class: 'gal-grid' });
  mxPane.append(
    h('div', { class: 'gal-controls' },
      h('span', { text: 'Switch' }), mxSw,
      button('Generate', () => quiet(runMatrix()), { small: true, tone: 'accent', key: 'Enter' }),
      button('Proof scene', () => ((st.matrix.scenes = new Set([swById(st.matrix.sw).proof])), drawChips()), { small: true, title: 'Just the scene where this switch should matter most' }),
      button('Clear scenes', () => (st.matrix.scenes.clear(), drawChips()), { small: true })),
    mxScenes, mxGrid);

  // ------------------------------------------------------------------ rendering the UI
  function refresh(): void {
    for (const b of sceneList.querySelectorAll<HTMLElement>('.gal-scene')) b.classList.toggle('on', b.dataset.scene === st.scene?.id);
    for (const sw of switches) {
      const cur = sw.get();
      for (const b of rows.get(sw.id)!.querySelectorAll<HTMLElement>('.gal-segbtn')) {
        b.classList.toggle('on', b.dataset.value === cur);
        b.classList.toggle('saved', b.dataset.value === saved[sw.id]);
        b.classList.toggle('factory', b.dataset.value === sw.def);
      }
    }
    for (const b of modeBtns) b.classList.toggle('on', b.dataset.mode === st.mode);
    for (const b of abViewBtns) b.classList.toggle('on', b.dataset.abview === st.ab.view);
    root.dataset.mode = st.mode;
    sceneTitle.textContent = st.scene ? `${st.scene.group} · ${st.scene.label}` : '';
    (tools.querySelector('.gal-freeze') as HTMLElement).textContent = st.frozen ? 'Animate (F)' : 'Freeze (F)';
    root.classList.toggle('busy', st.busy > 0);
  }

  function setMode(m: Mode): void {
    st.mode = m;
    if (m === 'ab') {
      // default to the switch last touched in Live
      abDefaults();
    }
    refresh();
    drawAb();
  }

  // ------------------------------------------------------------------ actions
  async function showScene(id: string): Promise<void> {
    const s = sceneById(id);
    await serial(`scene: ${s.label}`, async () => {
      st.scene = s;
      refresh();
      renderer.timeScale = 1;
      resetWorld(api, ctx, bootSeconds);
      journal.rollback();
      // The simulation runs while the scene is set up, as it does for the tools' screenshot
      // views (new monsters only appear, and the killed only fall, on simulation ticks), and
      // stops once the picture has settled.
      game.paused = false;
      try {
        await withSceneAppearance(api, id, () => s.run(api, ctx));
        if (s.gun) api.step(0.6);
      } finally {
        game.paused = true;
      }
      await stabilize();
      const p = game.player;
      st.cam = { x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch };
      applyFreeze();
      api.settle();
    });
  }

  async function setSwitch(id: string, v: string): Promise<void> {
    const sw = swById(id);
    await serial(`${sw.label}: ${v}`, async () => {
      sw.set(v);
      await afterSwitch(sw);
    });
    st.ab.sw = id;
    abSw.value = id;
  }

  async function afterSwitch(sw: GallerySwitch): Promise<void> {
    // the aim model's sway amplitude eases in over simulation ticks
    // (the weave's clock is put back, so A/B of two models compares the same moment)
    if (sw.id === 'aim' && st.scene?.gun) {
      const aim = aimOf();
      const t0 = aim?.t;
      api.step(0.6);
      if (aim && t0 !== undefined) aim.t = t0;
    }
    await stabilize();
  }

  function resetCamera(): void {
    if (!st.cam) return;
    Object.assign(game.player, st.cam);
    api.settle();
  }

  function toggleFreeze(): void {
    st.frozen = !st.frozen;
    applyFreeze();
    refresh();
  }

  async function revert(which: 'saved' | 'factory'): Promise<void> {
    await serial(which === 'saved' ? 'revert to saved' : 'factory defaults', async () => {
      for (const sw of switches) {
        const v = which === 'saved' ? saved[sw.id] : sw.def;
        if (sw.get() !== v) sw.set(v);
      }
      await stabilize();
    });
  }

  /**
   * Persist the current values through the Options entries themselves: step the entry until it
   * comes back round to the value (stepping at least once, so it writes even when the stored
   * value already differs from the live one). Switches without an Options row are listed.
   */
  async function copyDefaults(): Promise<string[]> {
    return serial('copy as my defaults', async () => {
      const opts = registeredOptions();
      const out: string[] = [];
      for (const sw of switches) {
        const target = sw.get();
        if (!sw.option) {
          if (target !== sw.def) out.push(`${sw.label}: not an Options setting, use ${sw.url ? `?${sw.url}=${target}` : 'the console'}`);
          continue;
        }
        if (sw.persist) {
          sw.persist();
          saved[sw.id] = target;
          continue;
        }
        const o = opts.find((q) => q.name === sw.option);
        if (!o) throw new Error(`no Options entry "${sw.option}"`);
        let n = 0;
        do o.change(1);
        while (sw.get() !== target && ++n <= sw.values.length + 1);
        if (sw.get() !== target) throw new Error(`${sw.option} did not come back to ${target} (at ${sw.get()})`);
        saved[sw.id] = target;
      }
      await stabilize();
      const msg = out.length ? `Saved. ${out.join('; ')}` : 'Saved: the game will boot with these.';
      setTimeout(() => setStatus(msg), 0);
      return out;
    });
  }

  /** Capture the current scene with switch `id` at each value in `values`; the switch is put back. */
  async function captureValues(id: string, values: string[], maxW = Infinity): Promise<HTMLCanvasElement[]> {
    const sw = swById(id);
    const orig = sw.get();
    const out: HTMLCanvasElement[] = [];
    try {
      for (const v of values) {
        if (sw.get() !== v) {
          sw.set(v);
          await afterSwitch(sw);
        } else await stabilize();
        out.push(withSway(captureFrame(renderer, maxW)));
      }
    } finally {
      if (sw.get() !== orig) {
        sw.set(orig);
        await afterSwitch(sw);
      }
    }
    return out;
  }

  async function runAb(): Promise<AbResult> {
    const { sw, a, b } = st.ab;
    if (!st.scene) throw new Error('gallery: pick a scene first');
    const res = await serial(`A/B ${sw}: ${a} vs ${b}`, async () => {
      const [ca, cb] = await captureValues(sw, [a, b]);
      if (st.ab.result) (URL.revokeObjectURL(st.ab.result.urlA), URL.revokeObjectURL(st.ab.result.urlB));
      const r: AbResult = { sw, a, b, scene: st.scene!.id, urlA: await toUrl(ca), urlB: await toUrl(cb), diff: pixelDiff(ca, cb) };
      st.ab.result = r;
      return r;
    });
    drawAb();
    return res;
  }

  function flipAb(): void {
    st.ab.showB = !st.ab.showB;
    drawAb();
  }

  function drawAb(): void {
    const r = st.ab.result;
    if (!r) {
      abOut.replaceChildren(h('div', { class: 'gal-empty', text: 'Pick a switch and two values, then Render A/B (Enter). Same scene, same camera, same frozen frame.' }));
      return;
    }
    const sw = swById(r.sw);
    const lab = (v: string) => sw.values.find((q) => q.v === v)?.label ?? v;
    const cap = (which: 'A' | 'B', v: string) => h('div', { class: 'gal-cap', text: `${which}: ${sw.label} = ${lab(v)}` });
    const info = h('div', { class: 'gal-abinfo', text: `${sceneById(r.scene).label} · ${(r.diff * 100).toFixed(1)}% of pixels differ` });
    if (st.ab.view === 'side') {
      abOut.replaceChildren(info, h('div', { class: 'gal-side' },
        h('figure', null, h('img', { attrs: { src: r.urlA, alt: 'A' } }), cap('A', r.a)),
        h('figure', null, h('img', { attrs: { src: r.urlB, alt: 'B' } }), cap('B', r.b))));
    } else if (st.ab.view === 'flicker') {
      const b = st.ab.showB;
      abOut.replaceChildren(info, h('div', { class: 'gal-single' },
        h('figure', null, h('img', { attrs: { src: b ? r.urlB : r.urlA, alt: b ? 'B' : 'A' } }), cap(b ? 'B' : 'A', b ? r.b : r.a))));
    } else {
      // slider: B over A, clipped at the handle; drag (or move with the button held) to wipe
      const imgB = h('img', { class: 'gal-top-img', attrs: { src: r.urlB, alt: 'B' } });
      const handle = h('div', { class: 'gal-handle' });
      const box = h('div', { class: 'gal-wipe' }, h('img', { attrs: { src: r.urlA, alt: 'A' } }), imgB, handle);
      const setK = (k: number) => {
        st.ab.slider = Math.max(0, Math.min(1, k));
        imgB.style.clipPath = `inset(0 0 0 ${st.ab.slider * 100}%)`;
        handle.style.left = `${st.ab.slider * 100}%`;
      };
      setK(st.ab.slider);
      const move = (e: MouseEvent) => {
        const rr = box.getBoundingClientRect();
        setK((e.clientX - rr.left) / rr.width);
      };
      box.addEventListener('mousedown', (e) => {
        move(e);
        const mm = (ev: MouseEvent) => move(ev);
        const up = () => (window.removeEventListener('mousemove', mm), window.removeEventListener('mouseup', up));
        window.addEventListener('mousemove', mm);
        window.addEventListener('mouseup', up);
      });
      abOut.replaceChildren(info, h('div', { class: 'gal-single' }, box, h('div', { class: 'gal-cap', text: `left: A = ${lab(r.a)} · right: B = ${lab(r.b)}` })));
    }
  }

  async function runMatrix(): Promise<{ scene: string; values: string[] }[]> {
    const sw = swById(st.matrix.sw);
    const ids = SCENES.filter((s) => st.matrix.scenes.has(s.id)).map((s) => s.id);
    if (!ids.length) throw new Error('gallery: pick at least one scene for the matrix');
    for (const r of st.matrix.rows) for (const c of r.cells) URL.revokeObjectURL(c.url);
    st.matrix.rows = [];
    drawMatrix();
    const back = st.scene?.id;
    const values = sw.values.map((v) => v.v);
    // thumbnails sized for the grid (wide enough to judge at 3440 px, light enough for 20+ of them)
    const maxW = Math.min(1400, Math.max(480, Math.round(stageRect().width / Math.max(2, values.length))));
    for (const id of ids) {
      await showScene(id);
      await serial(`matrix: ${sceneById(id).label}`, async () => {
        const caps = await captureValues(sw.id, values, maxW);
        st.matrix.rows.push({ scene: id, cells: await Promise.all(caps.map(async (c, i) => ({ v: values[i], url: await toUrl(c, 'image/jpeg') }))) });
      });
      drawMatrix();
    }
    // back to the scene Live was on
    if (back && back !== ids[ids.length - 1]) await showScene(back);
    return st.matrix.rows.map((r) => ({ scene: r.scene, values: r.cells.map((c) => c.v) }));
  }

  function drawMatrix(): void {
    const sw = swById(st.matrix.sw);
    const cols = sw.values.length;
    mxGrid.style.gridTemplateColumns = `auto repeat(${cols}, minmax(0, 1fr))`;
    const cells: HTMLElement[] = [h('div', { class: 'gal-mxcorner', text: sw.label })];
    for (const v of sw.values) cells.push(h('div', { class: `gal-mxhead${v.v === saved[sw.id] ? ' saved' : ''}`, text: v.label + (v.v === sw.def ? ' (default)' : '') }));
    st.matrix.rows.forEach((r, ri) => {
      cells.push(h('div', { class: 'gal-mxrow', text: sceneById(r.scene).label }));
      r.cells.forEach((c, ci) => cells.push(h('img', { class: 'gal-thumb', attrs: { src: c.url, alt: `${r.scene} ${c.v}`, 'data-row': String(ri), 'data-col': String(ci) }, on: { click: () => openLightbox(ri, ci) } })));
    });
    if (!st.matrix.rows.length) cells.push(h('div', { class: 'gal-empty', style: { gridColumn: `1 / span ${cols + 1}` }, text: 'Pick a switch and some scenes (chips above), then Generate. Rows are scenes, columns the switch values; click a thumbnail to enlarge.' }));
    mxGrid.replaceChildren(...cells);
  }

  let lb: { r: number; c: number } | null = null;
  function openLightbox(r: number, c: number): void {
    const row = st.matrix.rows[r];
    if (!row) return;
    c = (c + row.cells.length) % row.cells.length;
    lb = { r, c };
    const sw = swById(st.matrix.sw);
    const cell = row.cells[c];
    lightbox.replaceChildren(
      h('img', { attrs: { src: cell.url, alt: cell.v } }),
      h('div', { class: 'gal-cap', text: `${sceneById(row.scene).label} · ${sw.label} = ${sw.values.find((v) => v.v === cell.v)?.label} · ←/→ other values · ↑/↓ other scenes · Esc closes` }));
    lightbox.classList.add('open');
  }
  lightbox.addEventListener('click', () => closeLightbox());
  function closeLightbox(): void {
    lb = null;
    lightbox.classList.remove('open');
  }

  // ------------------------------------------------------------------ the aim model's sway path
  const aimOf = () => (api.combat as { aim?: { active: boolean; amp: number; t: number; offset(extra: number): { x: number; y: number } } } | undefined)?.aim;
  /** Where the crosshair goes over the next 2 s (angular offsets -> px for a view `hpx` tall). */
  const swayPath = (hpx: number): { x: number; y: number }[] | null => {
    const aim = aimOf();
    if (!st.scene?.gun || !aim) return null;
    const fov = renderer.rig.camera.fov;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= 80; i++) pts.push(offsetToPixels(aim.offset((i / 80) * 2), fov, hpx));
    return pts;
  };
  /** The capture plus the sway path, so A/B and the matrix show what the aim model does. */
  function withSway(c: HTMLCanvasElement): HTMLCanvasElement {
    const pts = swayPath(c.height);
    if (!pts) return c;
    const g = c.getContext('2d')!;
    const k = c.height / 540;
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.lineWidth = Math.max(1, 2 * k);
    g.strokeStyle = 'rgba(255, 220, 120, 0.9)';
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
    g.stroke();
    g.fillStyle = '#fff';
    g.fillRect(pts[0].x - 3 * k, pts[0].y - 3 * k, 6 * k, 6 * k);
    g.restore();
    return c;
  }
  const drawSwayLive = () => {
    const r = view.getBoundingClientRect();
    const pts = st.mode === 'live' ? swayPath(r.height) : null;
    if (!pts) {
      if (sway.childElementCount) sway.replaceChildren();
      return;
    }
    const cx = r.width / 2, cy = r.height / 2;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${(cx + p.x).toFixed(1)},${(cy + p.y).toFixed(1)}`).join('');
    // the moving dot: wall clock around the 2 s path, so the weave reads as motion
    const q = pts[Math.floor(((performance.now() / 2000) % 1) * (pts.length - 1))];
    sway.innerHTML = `<path d="${d}" fill="none" stroke="rgba(255,220,120,.85)" stroke-width="2"/><rect x="${cx + q.x - 4}" y="${cy + q.y - 4}" width="8" height="8" fill="#fff"/>`;
  };

  // ------------------------------------------------------------------ mouse look, WASD
  let drag: { x: number; y: number } | null = null;
  view.addEventListener('mousedown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    e.preventDefault();
  });
  view.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mouseup', () => void (drag = null));
  window.addEventListener('mousemove', (e) => {
    if (!drag || st.mode !== 'live') return;
    const p = game.player;
    p.yaw += (e.clientX - drag.x) * 0.004;
    p.pitch = Math.max(-1.45, Math.min(1.45, p.pitch - (e.clientY - drag.y) * 0.004));
    drag = { x: e.clientX, y: e.clientY };
  });
  const held = new Set<string>();
  let lastT = performance.now();
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    if (st.mode === 'live' && !st.busy && held.size) {
      const p = game.player;
      const sp = (held.has('ShiftLeft') || held.has('ShiftRight') ? 12 : 4) * dt;
      const f = (held.has('KeyW') ? 1 : 0) - (held.has('KeyS') ? 1 : 0), s = (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0);
      p.x += (Math.sin(p.yaw) * f + Math.cos(p.yaw) * s) * sp;
      p.y += (-Math.cos(p.yaw) * f + Math.sin(p.yaw) * s) * sp;
    }
    drawSwayLive();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ------------------------------------------------------------------ keys
  // Capture phase on window: the game's own key handlers (inventory, Esc menu, attacks) never
  // see a key while the gallery is up.
  const typing = (e: KeyboardEvent) => e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement;
  window.addEventListener('keyup', (e) => {
    held.delete(e.code);
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener('keydown', (e) => {
    e.stopImmediatePropagation();
    if (typing(e) && e.key !== 'Escape') return;
    const idx = st.scene ? SCENES.indexOf(st.scene) : -1;
    if (lb) {
      if (e.key === 'Escape') closeLightbox();
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') openLightbox(lb.r, lb.c + (e.key === 'ArrowLeft' ? -1 : 1));
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') openLightbox((lb.r + (e.key === 'ArrowUp' ? -1 : 1) + st.matrix.rows.length) % st.matrix.rows.length, lb.c);
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'PageDown' || e.key === 'PageUp' || e.key === ']' || e.key === '[') {
      const d = e.key === 'ArrowDown' || e.key === 'PageDown' || e.key === ']' ? 1 : -1;
      quiet(showScene(SCENES[(idx + d + SCENES.length) % SCENES.length].id));
    } else if (e.key === ' ' || e.key === 'x') {
      if (st.mode === 'ab') flipAb();
    } else if (e.key === 'Enter') {
      if (st.mode === 'ab') quiet(runAb());
      else if (st.mode === 'matrix') quiet(runMatrix());
    } else if (e.key === '1' || e.key === '2' || e.key === '3') setMode((['live', 'ab', 'matrix'] as Mode[])[Number(e.key) - 1]);
    else if (e.code === 'KeyR') resetCamera();
    else if (e.code === 'KeyF') toggleFreeze();
    else if (/^Key[WASD]$|^Shift/.test(e.code)) held.add(e.code);
    else return;
    e.preventDefault();
  }, true);

  // ------------------------------------------------------------------ automation (tests, docs)
  api.gallery = {
    scenes: SCENES.map((s) => s.id),
    switches: switches.map((s) => ({ id: s.id, values: s.values.map((v) => v.v), def: s.def, option: s.option, proof: s.proof, value: s.get() })),
    state: () => ({ mode: st.mode, scene: st.scene?.id ?? null, busy: st.busy, status: st.status, frozen: st.frozen, errors: [...st.errors], values: Object.fromEntries(switches.map((s) => [s.id, s.get()])), saved: { ...saved }, ab: st.ab.result && { ...st.ab.result }, matrix: st.matrix.rows.map((r) => ({ scene: r.scene, n: r.cells.length })) }),
    idle: () => chain.then(() => true),
    showScene,
    setSwitch,
    setMode,
    runAb: (sw?: string, a?: string, b?: string) => {
      if (sw) {
        st.ab.sw = sw;
        abSw.value = sw;
        abDefaults();
      }
      if (a) st.ab.a = abA.value = a;
      if (b) st.ab.b = abB.value = b;
      return runAb();
    },
    runMatrix: (sw?: string, scenes?: string[]) => {
      if (sw) st.matrix.sw = mxSw.value = sw;
      if (scenes) {
        for (const s of scenes) sceneById(s);
        st.matrix.scenes = new Set(scenes);
        drawChips();
      }
      return runMatrix();
    },
    copyDefaults,
    revert,
    /**
     * For each switch (or the ids given): in its proof scene, the share of pixels that change
     * from its current value to each other value. A switch that changes nothing shows 0.
     */
    proof: async (ids?: string[]) => {
      const out: { id: string; scene: string; diffs: Record<string, number> }[] = [];
      for (const sw of ids ? ids.map(swById) : switches) {
        // Set what this switch depends on before the scene is built, restore it after.
        const restore: [GallerySwitch, string][] = [];
        for (const [depId, v] of Object.entries(sw.requires ?? {})) {
          const dep = swById(depId);
          if (dep.get() !== v) (restore.push([dep, dep.get()]), dep.set(v));
        }
        if (restore.length || st.scene?.id !== sw.proof) await showScene(sw.proof);
        const cur = sw.get();
        const others = sw.values.map((v) => v.v).filter((v) => v !== cur);
        const caps = await serial(`proof ${sw.id}`, () => captureValues(sw.id, [cur, ...others], 640));
        for (const [dep, v] of restore.reverse()) dep.set(v);
        out.push({ id: sw.id, scene: sw.proof, diffs: Object.fromEntries(others.map((v, i) => [v, +(pixelDiff(caps[0], caps[i + 1]) * 100).toFixed(2)])) });
      }
      return out;
    },
    /** A capture of the stage as a PNG data URL (docs screenshots). */
    capture: (maxW = Infinity) => withSway(captureFrame(renderer, maxW)).toDataURL('image/png'),
  };

  refresh();
  drawAb();
  drawMatrix();
  await showScene(params.get('scene') ?? 'street');
}
