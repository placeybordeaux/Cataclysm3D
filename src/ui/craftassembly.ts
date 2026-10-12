import { clockScale } from '../core/time';
import { AssemblyPace } from '../game/activitytoys/assemblyPace';
import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import { CraftAssemblyController } from '../game/activitytoys/assembly';
import { cddaText } from '../game/units';
import { visualPreference, storeVisualPreference } from '../render/visualPreference';
import { registerOption } from './options';
import { h, ui2Layers } from '../ui2';
import { surfacesOpen } from '../ui2/host';
import { fmtDuration } from '../ui2/logic/items';
import './craftassembly.css';

export function installCraftAssembly(game: Game, api?: DebugApi): void {
  let mode = visualPreference('assembly', ['grid', 'exploded', 'off'], 'grid');
  registerOption({ category: 'Interface', name: 'Craft assembly', value: () => mode,
    change: () => { mode = mode === 'grid' ? 'exploded' : mode === 'exploded' ? 'off' : 'grid'; storeVisualPreference('assembly', mode); },
    desc: 'Optional component assembly. Place parts to save up to 20% work per batch. Ignoring it fills parts automatically; Off keeps normal crafting. Grid or spread-out layout.' });
  const pace = new AssemblyPace(game);
  const controller = new CraftAssemblyController(game, () => mode !== 'off');
  const card = h('section', { class: 'craft-assembly', data: { testid: 'craft-assembly' } });
  ui2Layers().hud.appendChild(card);
  let release: (() => void) | null = null;
  let selected: string | null = null;
  let dragging = false;
  let dropClick = false;
  let rendered = '';
  let renderedFor: typeof controller.activity = null;
  const disengage = (relock: boolean) => { release?.(); release = null; pace.end(); selected = null; dragging = false; if (relock) game.input.tryLock(); };
  const visible = () => !game.player.dead && !game.player.isAsleep() && surfacesOpen() === 0 && (!game.input.captured || !!release);
  const paused = () => game.paused || game.tacticalPause || game.lockPaused || (game.input.captured && !game.input.captureTimeFlows);
  const place = (index: number, id: string) => { if (controller.place(index, id)) { selected = null; rendered = ''; } };
  const engage = () => {
    if (release) return;
    controller.update(paused());
    if (!controller.activity) return;
    if (controller.activity && controller.state) pace.begin(controller.activity, Math.max(1, controller.state.batch * (1 - controller.state.progress)), clockScale());
    game.input.releaseForMenu();
    release = game.input.capture(e => {
      if (e.code === 'Escape') { disengage(true); return true; }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(e.code)) {
        disengage(true);
        const a = game.activities.current;
        if (a?.spec.kind === 'craft') game.activities.cancel(`You stop ${a.spec.name}.`);
        return true;
      }
      if (/^(Digit|Numpad)[1-8]$/.test(e.code)) {
        const i = Number(e.code.slice(-1)) - 1;
        const slot = controller.slots[i];
        if (slot?.alternatives.length) place(i, selected ?? slot.alternatives[0]);
        return true;
      }
      // Native Tab/Enter/select arrow handling remains available inside this card.
      return false;
    }, { timeFlows: true });
  };
  window.addEventListener('mousedown', e => {
    if (!controller.activity || card.hidden || e.button !== 0) return;
    if (release) {
      if (!card.contains(e.target as Node)) { e.preventDefault(); e.stopImmediatePropagation(); disengage(true); }
    } else if (game.input.locked && !game.input.captured) {
      e.preventDefault(); e.stopImmediatePropagation(); engage();
    } else if (card.contains(e.target as Node) && !game.input.captured) engage();
  }, true);
  window.addEventListener('blur', () => disengage(false));
  game.input.onPriorityPress(e => {
    if (e.repeat || game.input.captured || !visible() || !controller.activity || !/^(Digit|Numpad)[1-8]$/.test(e.code)) return false;
    const i = Number(e.code.slice(-1)) - 1, slot = controller.slots[i];
    if (slot?.alternatives.length) place(i, slot.alternatives[0]);
    return true;
  });
  card.addEventListener('pointerup', e => {
    dragging = false; rendered = '';
    if (!selected) return;
    const slot = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-assembly-slot]');
    if (slot && card.contains(slot)) { dropClick = true; place(Number(slot.dataset.assemblySlot), selected); }
  });
  card.addEventListener('pointercancel', () => { dragging = false; selected = null; rendered = ''; });
  const frame = () => {
    requestAnimationFrame(frame); controller.update(paused());
    card.hidden = !controller.activity || !visible();
    if (card.hidden) { if (release) disengage(false); return; }
    if (renderedFor !== controller.activity) { if (release) disengage(false); renderedFor = controller.activity; rendered = ''; selected = null; }
    if (dragging) return;
    const state = controller.state!;
    const key = `${!!release}|${mode}|${controller.frozen}|${controller.batchIndex}|${controller.skipped}|${selected}|${controller.slots.map(s => `${s.alternatives.join(',')}:${s.placed}:${s.automatic}`).join('|')}`;
    if (rendered === key) return;
    rendered = key;
    const focus = document.activeElement instanceof HTMLElement && card.contains(document.activeElement) ? document.activeElement.dataset.focus : undefined;
    card.classList.toggle('exploded', mode === 'exploded');
    if (controller.frozen) { card.replaceChildren(h('div', { text: 'Assembly pauses while time runs fast.' })); return; }
    const label = (id: string) => cddaText(game.data.items[id]?.name) || id;
    const slots = controller.slots.map((slot, i) => {
      const done = slot.placed || slot.automatic;
      const select = h('select', { data: { focus: `alt${i}` }, attrs: { 'aria-label': `Part ${i + 1} alternative` },
        on: { change: e => { selected = (e.target as HTMLSelectElement).value; rendered = ''; } } },
        ...slot.alternatives.map(id => h('option', { text: label(id), attrs: { value: id } })));
      if (selected && slot.alternatives.includes(selected)) select.value = selected;
      const ingredient = h('button', { class: 'assembly-piece', text: label(select.value), data: { focus: `piece${i}` },
        attrs: done ? { disabled: '' } : {}, on: { click: () => { if (dropClick) { dropClick = false; return; } selected = select.value; rendered = ''; }, pointerdown: e => {
          if (done) return; dragging = true; dropClick = false; selected = select.value; (e.target as HTMLElement).setPointerCapture((e as PointerEvent).pointerId);
        } } });
      const target = h('button', { class: done ? 'assembly-slot done' : 'assembly-slot', data: { assemblySlot: String(i), focus: `slot${i}` },
        text: `${i + 1} · ${done ? '✓ assembled' : label(slot.alternatives[0])}`, attrs: done ? { disabled: '' } : {},
        on: { click: () => place(i, selected ?? select.value) } });
      return h('div', { class: 'assembly-part' }, slot.alternatives.length > 1 ? select : null, ingredient, target);
    });
    const tools = [...(state.recipe.tools ?? []).map(group => group.map(t => label(t.id)).join(' or ')), ...(state.recipe.qualities ?? []).map(group => group.map(q => `${q.id} ${q.level}`).join(' or '))];
    card.replaceChildren(h('strong', { text: `Assembly · batch ${controller.batchIndex + 1}/${state.batch}` }),
      h('div', { text: release ? 'Hand pace · drag, or pick a part and click its slot' : 'Click for hand pace · 1–8 quick placement' }),
      h('small', { text: tools.length ? `Tool requirements: ${tools.join(' · ')}` : 'No tools required' }),
      h('div', { class: 'assembly-grid' }, ...slots),
      h('small', { text: controller.skipped ? `${fmtDuration(controller.skipped)} work saved` : 'Optional · ignored parts fill as you work' }));
    if (focus) card.querySelector<HTMLElement>(`[data-focus="${focus}"]`)?.focus();
  };
  requestAnimationFrame(frame);
  if (api) api.craftAssembly = { state: () => ({ live: !!controller.activity, batch: controller.batchIndex, frozen: controller.frozen, slots: controller.slots, skipped: controller.skipped, mode }) };
}
