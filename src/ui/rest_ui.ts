// Sleep and Wait, adapted (docs/ADAPTATION.md). CDDA has two separate one-line menus: a
// y/n "Sleep" with a raw comfort number, and a list of "Wait 20 heartbeats…" entries. Here
// both keys open one ui2 "Rest" window that answers the questions a newcomer actually has:
// will I fall asleep here, is it safe, how long until morning? Sleep sits on top when you
// pressed the sleep key; the wait key puts the focus on the wait buttons. When something
// dangerous is in view the window says so up front instead of the action failing afterwards.
//
// Options > Rest menus: Modern (default) / Classic (the old terminal menus, kept as they were).

import type { Game } from '../game/game';
import { goToSleep, playerComfort, waitFor, WAIT_OPTIONS } from '../game/rest';
import { isOutside } from '../game/vision';
import { playerLightState, toggleLight } from '../game/lightitems';
import { h } from '../ui2/dom';
import { closeKeyLabel } from '../ui2/host';
import { fmtDuration } from '../ui2/logic/items';
import { closeGroup, openPanel } from '../ui2/window';
import { button } from '../ui2/widgets';
import { registerOption } from './options';
import { sleepSpotText } from './tips_adapted';
import { nextSpeed, timeWarp } from '../game/timewarp';
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

/** A heads-up before resting while hungry or thirsty, or null. */
export function restNeedsWarning(hunger: string, thirst: string): string | null {
  const thirsty = /Very Thirsty|Dehydrated|Parched/.test(thirst);
  const hungry = /Very Hungry|Famished|Starving/.test(hunger);
  if (!thirsty && !hungry) return null;
  const what = thirsty && hungry ? 'hungry and thirsty' : thirsty ? 'thirsty' : 'hungry';
  return `You're ${what}: ${thirsty ? 'drink' : 'eat'} something first. Hours pass while you rest, and it gets worse.`;
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
 * The Rest window's fast-forward pick: the wait or sleep starts at this speed (the same steps as
 * the fast-forward key during it). Remembered for the session: a player who sleeps at ×8 once
 * wants it the next night too.
 */
let restSpeed = 1;
export function restFastSpeed(): number {
  return restSpeed;
}

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
  const ci = playerComfort(game);
  const spot = sleepSpotText(ci.comfort, ci.on, p.sleepinessDescription());
  const cantSleep = ci.refuse ?? (ci.comfort <= -999 ? "You can't sleep here." : undefined);
  const tired = tirednessText(p.sleepinessDescription());
  // Under a vehicle's roof counts as indoors (the map tile under an RV reads as outdoors).
  const outside = ci.vehicle ? !ci.vehicle.v.roofAt(ci.vehicle.mx, ci.vehicle.my) : isOutside(game.map, p.tileX, p.tileY, p.z);
  const choices = waitChoices(game);

  const run = (fn: () => void) => {
    panel.close();
    fn();
    if (restSpeed > 1) timeWarp(game).arm(restSpeed);
  };
  const ffKey = game.keys.label('fast_forward');
  const speedText = () => (restSpeed > 1 ? `Fast: ×${restSpeed}` : 'Fast: off');
  const cycleSpeed = () => {
    restSpeed = nextSpeed(restSpeed);
    speedBtn.querySelector('span')!.textContent = speedText();
    speedBtn.classList.toggle('rest-fast-on', restSpeed > 1);
  };
  const speedBtn = button(speedText(), cycleSpeed, { small: true, key: ffKey, title: `Run the wait or the night faster: ×1, ×2, ×4, ×8, ×16. Anything dangerous drops it back to ×1.` });
  speedBtn.classList.add('rest-fast');
  speedBtn.classList.toggle('rest-fast-on', restSpeed > 1);
  const sleepBtn = button(ci.vehicle ? `Sleep on the ${ci.vehicle.board?.def.name ?? 'seat'}` : 'Sleep here', () => run(() => sleepHere(game)), {
    key: 'Y', tone: 'accent', disabled: blocked ?? cantSleep,
  });
  const sleepCard = h('div', { class: 'rest-card' },
    h('div', { class: 'rest-head' }, h('span', { text: 'Sleep' }), sleepBtn),
    h('div', { class: spot.good ? 'tone-good' : 'tone-warn', text: `Spot: ${spot.spot}.` }),
    ...(ci.refuse ? [h('div', { class: 'tone-bad', text: ci.refuse })] : ci.vehicle ? [h('div', { class: 'ui2-dim', text: `You can use any bed or seat in the ${ci.vehicle.v.name} from here.` })] : []),
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
    footer: `Y sleep · the key on a button waits · ${ffKey} faster · ${closeKeyLabel() || 'Bksp'} close`,
    onKey: (e) => {
      if (e.repeat) return false;
      const k = e.key.toLowerCase();
      if (game.keys.keysFor('sleep').includes(e.key) || game.keys.keysFor('wait').includes(e.key) || e.key === 'Backspace') {
        panel.close();
        return true;
      }
      if (game.keys.keysFor('fast_forward').includes(e.key)) {
        cycleSpeed();
        return true;
      }
      if (blocked) return false;
      if (k === 'y' && !cantSleep) {
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
  // A long wait or a night's sleep doesn't stop for hunger or thirst until they're dangerous
  // (BN): say so before, not after (playtest: slept on "Very Thirsty", woke up worse).
  const needs = restNeedsWarning(p.hungerState(), p.thirstDescription());
  if (needs) panel.body.append(h('div', { class: 'rest-block tone-warn', text: needs }));
  panel.body.append(...(focus === 'sleep' ? [sleepCard, waitCard] : [waitCard, sleepCard]));
  panel.body.append(h('div', { class: 'rest-fast-row' }, speedBtn, h('span', { class: 'ui2-dim ui2-small', text: `${ffKey} while resting changes it too. Danger drops it back to ×1.` })));
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
    category: 'Interface',
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
