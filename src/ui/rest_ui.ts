// Sleep and Wait, adapted (docs/ADAPTATION.md). CDDA has two separate one-line menus: a
// y/n "Sleep" with a raw comfort number, and a list of "Wait 20 heartbeats…" entries. Here
// both keys open one ui2 "Rest" window that answers the questions a newcomer actually has:
// will I fall asleep here, is it safe, how long until morning? Sleep sits on top when you
// pressed the sleep key; the wait key puts the focus on the wait buttons. When something
// dangerous is in view the window says so up front instead of the action failing afterwards.
//
// Options > Rest menus: Modern (default) / Classic (the old terminal menus, kept as they were).

import type { Game } from '../game/game';
import { comfortAt, goToSleep, waitFor, WAIT_OPTIONS } from '../game/rest';
import { isOutside } from '../game/vision';
import { playerLightState, toggleLight } from '../game/lightitems';
import { h } from '../ui2/dom';
import { fmtDuration } from '../ui2/logic/items';
import { closeGroup, openPanel } from '../ui2/window';
import { button } from '../ui2/widgets';
import { registerOption } from './options';
import { sleepSpotText } from './tips_adapted';
import './rest_ui.css';

type Style = 'modern' | 'classic';
const KEY = 'cdda3d.restMenus';

export function restMenuStyle(): Style {
  try {
    return localStorage.getItem(KEY) === 'classic' ? 'classic' : 'modern';
  } catch {
    return 'modern';
  }
}

/** Why you can't rest right now (a monster in view…), or null. Same checks the activity uses. */
export function restBlocker(game: Game): string | null {
  for (const d of game.activities.dangerChecks) {
    const r = d();
    if (r) return r;
  }
  return null;
}

/** "Tired: you'll drop off soon." — what the sleepiness state means for this decision. */
export function tirednessText(sleepiness: string): { text: string; tone: 'good' | 'warn' | 'bad' | 'dim' } {
  if (!sleepiness) return { text: "You're not tired: you may lie awake for a long time.", tone: 'dim' };
  if (sleepiness === 'Tired') return { text: "You're tired: you'll fall asleep soon.", tone: 'good' };
  return { text: `${sleepiness}: you'll be out like a light. Sleep before you collapse.`, tone: 'warn' };
}

/** Wait entries with their short label ("30 minutes", "Until dawn") and, for the "until" ones, how long that is. */
export function waitChoices(game: Game): { key: string; label: string; seconds: number; detail: string }[] {
  return WAIT_OPTIONS.map((o) => {
    const s = o.seconds(game);
    const label = o.label.replace(/^Wait (until |till )?/, (_m, until) => (until ? 'Until ' : ''));
    const detail = s < 0 ? '' : /^Until/.test(label) ? `in ${fmtDuration(s)}` : '';
    return { key: o.key, label: label.charAt(0).toUpperCase() + label.slice(1), seconds: s, detail };
  });
}

const GROUP = 'rest';

/**
 * Lie down, switching your flashlight off first. Playtest: the phone's flashlight app, left on
 * from walking around in the dark, ran the battery flat overnight and the survivor woke up in
 * the dark with a dead phone. CDDA leaves it to you; this says what it did so it isn't magic.
 */
function sleepHere(game: Game): void {
  const light = playerLightState(game);
  if (light.on && light.item && toggleLight(game)) game.message('You switch off your light to save the battery.', 'c_light_gray');
  goToSleep(game);
}

export function openRest(game: Game, focus: 'sleep' | 'wait'): void {
  closeGroup(GROUP);
  const p = game.player;
  const blocked = restBlocker(game);
  const ci = comfortAt(game, p.tileX, p.tileY, p.z);
  const spot = sleepSpotText(ci.comfort, ci.on, p.sleepinessDescription());
  const tired = tirednessText(p.sleepinessDescription());
  const outside = isOutside(game.map, p.tileX, p.tileY, p.z);
  const choices = waitChoices(game);

  const run = (fn: () => void) => {
    panel.close();
    fn();
  };
  const sleepBtn = button('Sleep here', () => run(() => sleepHere(game)), {
    key: 'Y', tone: 'accent', disabled: blocked ?? (ci.comfort <= -999 ? "You can't sleep here." : undefined),
  });
  const sleepCard = h('div', { class: 'rest-card' },
    h('div', { class: 'rest-head' }, h('span', { text: 'Sleep' }), sleepBtn),
    h('div', { class: spot.good ? 'tone-good' : 'tone-warn', text: `Spot: ${spot.spot}.` }),
    h('div', { class: `tone-${tired.tone}`, text: tired.text }),
    h('div', { class: outside ? 'tone-warn' : 'ui2-dim', text: outside ? "You're outdoors: anything passing by can find you. A closed room is safer." : 'Indoors. Close the doors before you lie down.' }),
  );
  const waitBtns = choices.map((c) =>
    button(c.detail ? `${c.label} · ${c.detail}` : c.label, () => run(() => void waitFor(game, c.seconds)), { key: c.key.toUpperCase(), small: true, disabled: blocked ?? undefined }));
  const waitCard = h('div', { class: 'rest-card' },
    h('div', { class: 'rest-head' }, h('span', { text: 'Wait' }), h('span', { class: 'ui2-dim ui2-small', text: 'Moving stops it. So does anything dangerous showing up.' })),
    h('div', { class: 'rest-grid' }, ...waitBtns),
  );

  const panel = openPanel({
    id: 'rest', title: 'Rest', group: GROUP, pauses: true,
    width: 'min(calc(var(--fs) * 40), 94vw)',
    footer: 'Y sleep · the key on a button waits · Esc close',
    onKey: (e) => {
      if (e.repeat) return false;
      const k = e.key.toLowerCase();
      if (game.keys.keysFor('sleep').includes(e.key) || game.keys.keysFor('wait').includes(e.key) || e.key === 'Backspace') {
        panel.close();
        return true;
      }
      if (blocked) return false;
      if (k === 'y' && ci.comfort > -999) {
        run(() => sleepHere(game));
        return true;
      }
      const c = choices.find((x) => x.key === k);
      if (c) {
        run(() => void waitFor(game, c.seconds));
        return true;
      }
      return false;
    },
  });
  if (blocked) panel.body.append(h('div', { class: 'rest-block tone-bad', text: `You can't rest now: ${blocked.replace(/^You /, 'you ')}` }));
  panel.body.append(...(focus === 'sleep' ? [sleepCard, waitCard] : [waitCard, sleepCard]));
  const r = panel.el.getBoundingClientRect();
  panel.moveTo(Math.round((innerWidth - r.width) / 2), Math.round((innerHeight - r.height) / 3));
  (focus === 'sleep' ? sleepBtn : waitBtns[3] ?? waitBtns[0])?.focus();
}

/** Wrap the sleep/wait keys (registered by worldInteraction.ts): modern window unless Classic is chosen. */
export function installRestUi(game: Game): void {
  const classicSleep = game.keys.handler('sleep');
  const classicWait = game.keys.handler('wait');
  if (!classicSleep || !classicWait) throw new Error('installRestUi: sleep/wait keys must be registered first (installWorldInteraction)');
  game.keys.register('sleep', 'Sleep', () => (restMenuStyle() === 'classic' ? classicSleep() : openRest(game, 'sleep')));
  game.keys.register('wait', 'Wait', () => (restMenuStyle() === 'classic' ? classicWait() : openRest(game, 'wait')));
  registerOption({
    name: 'Rest menus',
    value: () => (restMenuStyle() === 'classic' ? 'Classic (CDDA)' : 'Modern'),
    change: () => {
      try {
        localStorage.setItem(KEY, restMenuStyle() === 'classic' ? 'modern' : 'classic');
      } catch {
        // not persisted
      }
    },
    desc: 'Sleep and Wait: one Rest window that says whether you will fall asleep and how safe the spot is (Modern), or the two short menus from Cataclysm (Classic).',
  });
}
