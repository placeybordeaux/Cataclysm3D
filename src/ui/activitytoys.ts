import type { Game } from '../game/game';
import type { DebugApi } from '../debug';
import { ActivityToyController, partFree, type ToyKind } from '../game/activitytoys/controller';
import { visualPreference, storeVisualPreference } from '../render/visualPreference';
import { registerOption } from './options';
import { h, ui2Layers } from '../ui2';
import { surfacesOpen } from '../ui2/host';
import { fmtDuration } from '../ui2/logic/items';
import './activitytoys.css';

export function installActivityToys(game: Game, api?: DebugApi): void {
  const modes: Record<ToyKind, 'timing' | 'teardown' | 'off'> = {
    construction: visualPreference('constructiontoy', ['timing', 'off'], 'timing'),
    disassemble: visualPreference('disassemblytoy', ['teardown', 'off'], 'teardown'),
  };
  for (const [kind, param, label, on] of [
    ['construction', 'constructiontoy', 'Construction toy', 'timing'],
    ['disassemble', 'disassemblytoy', 'Disassembly toy', 'teardown'],
  ] as const) registerOption({
    category: 'Interface',
    name: label, value: () => modes[kind],
    change: () => { modes[kind] = modes[kind] === 'off' ? on : 'off'; storeVisualPreference(param, modes[kind]); },
    desc: 'Optional careful-hands toy. Good inputs save up to 20% work and grant a little practice. Ignoring or missing it has no cost. Off keeps ordinary work. Pauses during fast-forward.',
  });
  const controller = new ActivityToyController(game, (kind: ToyKind) => modes[kind] !== 'off');
  const card = h('div', { class: 'activity-toy', data: { testid: 'activity-toy' } });
  ui2Layers().hud.appendChild(card);
  const visible = () => !game.player.dead && !game.player.isAsleep() && !game.input.captured && surfacesOpen() === 0;
  const paused = () => game.paused || game.tacticalPause || game.lockPaused || (game.input.captured && !game.input.captureTimeFlows);
  game.input.onPriorityPress(e => {
    if (e.repeat || !/^(Digit|Numpad)[1-8]$/.test(e.code) || !visible() || !controller.activity || controller.frozen) return false;
    controller.press(Number(e.code.slice(-1)) - 1);
    return true;
  });
  let last = performance.now();
  let renderedKey = '';
  let renderedFor: typeof controller.activity = null;
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    controller.update((now - last) / 1000, paused()); last = now;
    card.hidden = !controller.activity || !visible();
    if (card.hidden) return;
    const foot = controller.skipped > 0 ? `${fmtDuration(controller.skipped)} work saved` : 'Optional · ignore it to work normally';
    if (renderedFor !== controller.activity) { renderedFor = controller.activity; renderedKey = ''; }
    const key = `${controller.kind}|${controller.frozen}|${foot}|${controller.timingWindow()}|${controller.parts.map(p => `${p.label}:${p.removed}`).join(',')}`;
    const marker = card.querySelector<HTMLElement>('.toy-marker');
    if (marker) marker.style.left = `${controller.phase() * 100}%`;
    if (key === renderedKey) return;
    renderedKey = key;
    if (controller.frozen) {
      card.replaceChildren(h('div', { text: 'Careful hands pause while time runs fast.' })); return;
    }
    if (controller.kind === 'construction') {
      const track = h('div', { class: 'toy-track' }, h('span', { class: 'toy-sweet', attrs: { style: `left:${(0.5-controller.timingWindow())*100}%;width:${controller.timingWindow()*200}%` } }), h('span', { class: 'toy-marker', attrs: { style: `left:${controller.phase() * 100}%` } }));
      card.replaceChildren(h('strong', { text: 'Hammer beat' }), h('div', { text: 'Tap 1 as the mark meets the centre' }), track, h('small', { text: foot }));
    } else {
      const parts = controller.parts.map((p, i) => h('button', {
        class: p.removed ? 'toy-part removed' : 'toy-part',
        text: `${i + 1} · ${p.label}${p.removed ? ' ✓' : partFree(controller.parts, i) ? ' · free' : ' · covered'}`,
        attrs: p.removed || !partFree(controller.parts, i) ? { disabled: '' } : {},
        on: { click: () => controller.press(i) },
      }));
      card.replaceChildren(h('strong', { text: 'Careful teardown' }), h('div', { text: 'Lift the free parts with their number keys' }), h('div', { class: 'toy-parts' }, ...parts), h('small', { text: foot }));
    }
  };
  requestAnimationFrame(frame);
  if (api) api.activityToys = {
    state: () => ({ kind: controller.kind, phase: controller.phase(), hits: controller.hits, savedSeconds: controller.skipped, frozen: controller.frozen, parts: controller.parts, modes: { ...modes } }),
  };
}
