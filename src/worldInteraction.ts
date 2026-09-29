import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { Item } from './game/item';
import { installSound, emitSound, recentSounds, soundsHeardAt, type SoundOpts } from './game/sound';
import { installWeather, forceWeather, refreshWeather } from './game/weather';
import { installFields, ignite, addField, fieldDamageAt } from './game/fields';
import { installZLevels, goStairs } from './game/zlevels';
import { installRest, goToSleep, waitFor, WAIT_OPTIONS, comfortAt } from './game/rest';
import { installTraps, setTrap, trapAt, triggerTrap } from './game/traps';
import { bash, playerSmash, smashUntilBroken, smashAbility } from './game/bash';
import { interact, interactionPrompt, interactionsAt, setInteractUi, describeText } from './game/interact';
import { targetTile, frontTile } from './game/targeting';
import { toggleLight, playerLightState } from './game/lightitems';
import { lightAt, playerCanSee, naturalLight, sunAltitude, tooDarkReason } from './game/vision';
import { installWorldFx } from './render/worldFx';
import { openMenu, openWindow, colorize, c } from './ui/framework';

// Wires the world-interaction systems (sound, vision, examine, bashing, z-levels, fields,
// wait/sleep, weather, light items, traps) into the game, keys, UI and window.cdda.
// Called once from main.ts after the renderer exists.

export function installWorldInteraction(game: Game, renderer: Renderer, api: DebugApi): void {
  installSound(game);
  installWeather(game, { setRenderWeather: (k) => renderer.setWeather(k) });
  installFields(game);
  installZLevels(game);
  installRest(game);
  installTraps(game);
  installWorldFx(game, renderer);

  setInteractUi({
    menu: (title, entries) => {
      openMenu({ title, entries: entries.map((e) => ({ label: c('c_white', e.label), value: e.run })), onSelect: (run) => void run() });
    },
    text: (title, body) => {
      const w = openWindow({ title, width: '60ch', footer: c('c_dark_gray', 'Esc to close') });
      w.body.innerHTML = colorize(body);
      w.body.style.whiteSpace = 'pre-wrap';
    },
    pickup: (title, x, y, z) => {
      const entries = () => (game.map.itemsAt(x, y, z) as unknown as Item[]).map((it) => ({ label: c('c_white', it.name()), value: it }));
      const m = openMenu({
        title, entries: entries(), footer: c('c_dark_gray', 'letter: take item · Esc: close'),
        onSelect: (it) => {
          const r = game.player.inv.pickUp(it);
          if (r.ok) game.map.removeItem(x, y, z, it);
          m.refresh(entries());
          return false;
        },
      });
    },
  });

  game.keys.register('interact', 'Examine / open / close / use', () => void interact(game));
  game.keys.register('smash', 'Smash', () => void playerSmash(game));
  // Every system already honours p.crouching (eye height, footstep noise, being seen/heard);
  // this is the switch. CDDA's move-mode messages.
  game.keys.register('crouch', 'Crouch (toggle)', () => {
    const pl = game.player;
    pl.crouching = !pl.crouching;
    game.message(pl.crouching ? 'You start crouching.' : 'You stop crouching.', 'c_light_gray');
  });
  game.keys.register('flashlight', 'Toggle light (flashlight, lantern)', () => void toggleLight(game));
  game.keys.register('sleep', 'Sleep', () => {
    const p = game.player;
    const ci = comfortAt(game, p.tileX, p.tileY, p.z);
    openMenu({
      title: 'Sleep',
      entries: [
        { label: c('c_white', 'Go to sleep') + ` ${c(ci.comfort > 0 ? 'c_green' : 'c_light_red', `(${ci.on}, comfort ${ci.comfort})`)}`, value: 'sleep', hotkey: 'y' },
        { label: c('c_white', 'Never mind'), value: 'no', hotkey: 'n' },
      ],
      onSelect: (v) => void (v === 'sleep' && goToSleep(game)),
    });
  });
  game.keys.register('wait', 'Wait', () => {
    openMenu({
      title: 'Wait for how long?',
      entries: WAIT_OPTIONS.map((o) => ({ label: c('c_white', o.label), value: o, hotkey: o.key })),
      onSelect: (o) => void waitFor(game, o.seconds(game)),
    });
  });

  // HUD hint: pushed to the UI agent's hud.setPrompt when it exists.
  let promptT = 0, lastPrompt: string | null | undefined;
  game.systems.push({
    name: 'interactPrompt',
    update(g, realDt) {
      if ((promptT -= realDt) > 0) return;
      promptT = 0.15;
      const text = interactionPrompt(g);
      if (text === lastPrompt) return;
      lastPrompt = text;
      (window as any).cdda?.hud?.setPrompt?.(text);
    },
  });

  // ---- window.cdda helpers
  const p = () => game.player;
  const runUntilIdle = (maxRealSeconds = 600) => {
    const n = Math.round(maxRealSeconds * 30);
    for (let i = 0; i < n && game.activities.current; i++) game.tick(1 / 30);
  };
  Object.assign(api, {
    /** Examine/interact with the aimed tile (or tile x,y,z). */
    interact: (x?: number, y?: number, z?: number) => interact(game, x === undefined ? targetTile(game) : { x, y: y!, z: z ?? p().z, dist: 1 }),
    /** Interactions available at a tile: labels. */
    interactions: (x: number, y: number, z = p().z) => interactionsAt(game, x, y, z).map((i) => i.label),
    examineText: (x: number, y: number, z = p().z) => describeText(game, x, y, z),
    target: () => targetTile(game),
    frontTile: () => frontTile(game),
    prompt: () => interactionPrompt(game),
    bash: (x: number, y: number, z: number, str: number) => bash(game, x, y, z, str, {}),
    smash: () => playerSmash(game),
    smashUntilBroken: () => smashUntilBroken(game, targetTile(game) ?? frontTile(game)),
    smashAbility: () => smashAbility(p()),
    ignite: (x: number, y: number, z = p().z, intensity = 1) => ignite(game, x, y, z, intensity),
    addField: (x: number, y: number, z: number, type: string, intensity = 1) => addField(game, x, y, z, type, intensity),
    fieldsAt: (x: number, y: number, z = p().z) => game.map.fieldsAt(x, y, z).map((f) => ({ ...f })),
    fieldDamageAt: (x: number, y: number, z = p().z) => fieldDamageAt(game, x, y, z),
    /** Count fields of a type within r tiles of the player. */
    countFields: (type = 'fd_fire', r = 30) => {
      let n = 0;
      for (let y = p().tileY - r; y <= p().tileY + r; y++)
        for (let x = p().tileX - r; x <= p().tileX + r; x++) if (game.map.fieldsAt(x, y, p().z).some((f) => f.type === type)) n++;
      return n;
    },
    /** Set weather: CDDA id (sunny, rain, thunder, snowing…) or clear/rain/storm/snow; null = generated. */
    setWeather: (id: string | null) => forceWeather(game, id),
    weather: () => ({ ...refreshWeather(game) }),
    /** Wait n game minutes (runs the simulation until the wait activity ends). */
    waitMinutes: (n: number) => {
      waitFor(game, n * 60);
      runUntilIdle();
      return game.clock.format();
    },
    sleep: () => {
      const ok = goToSleep(game);
      return ok;
    },
    /** Run the simulation until the current activity (sleep/wait/craft) finishes. */
    finishActivity: (maxRealSeconds = 600) => runUntilIdle(maxRealSeconds),
    goStairs: (dir: 'up' | 'down') => goStairs(game, dir),
    lightAt: (x = p().tileX, y = p().tileY, z = p().z) => lightAt(game, x, y, z),
    naturalLight: () => ({ light: naturalLight(game), sunAltitude: sunAltitude(game.clock) }),
    canSee: (x: number, y: number, z = p().z) => playerCanSee(game, x, y, z),
    tooDark: (action: 'read' | 'craft' = 'craft') => tooDarkReason(game, action),
    emitSound: (x: number, y: number, z: number, volume: number, desc: string, opts?: SoundOpts) => emitSound(game, { x, y, z }, volume, desc, opts),
    sounds: () => recentSounds(game, 5).map((s) => ({ ...s, source: s.source ? String((s.source as { name?: string }).name ?? 'object') : undefined })),
    soundsHeardAt: (x: number, y: number, z: number) => soundsHeardAt(game, x, y, z).map((h) => ({ desc: h.sound.description, volume: h.volume })),
    toggleLight: () => toggleLight(game),
    lightState: () => {
      const s = playerLightState(game);
      return { on: s.on, lum: s.lum, directional: s.directional, item: s.item?.name() ?? null, flashlight: renderer.flashlightOn };
    },
    placeTrap: (x: number, y: number, z: number, id: string) => setTrap(game, x, y, z, id),
    trapAt: (x: number, y: number, z = p().z) => trapAt(game, x, y, z),
    triggerTrap: (x: number, y: number, z = p().z) => triggerTrap(game, x, y, z),
    /** Nearest tile (same z) whose terrain/furniture id matches `re`, searching r tiles. */
    findTile: (re: string, r = 40, z = p().z) => {
      const rx = new RegExp(re);
      let best: { x: number; y: number; z: number; id: string } | null = null, bd = Infinity;
      for (let y = p().tileY - r; y <= p().tileY + r; y++)
        for (let x = p().tileX - r; x <= p().tileX + r; x++) {
          const t = game.map.terAt(x, y, z).id, f = game.map.furnAt(x, y, z).id;
          const id = rx.test(f) ? f : rx.test(t) ? t : null;
          if (!id) continue;
          const d = (x - p().tileX) ** 2 + (y - p().tileY) ** 2;
          if (d < bd) (bd = d), (best = { x, y, z, id });
        }
      return best;
    },
    /** Stand next to tile (x,y) facing it (for screenshots/tests). */
    faceTile: (x: number, y: number, from?: [number, number]) => {
      const pl = p();
      if (from) {
        pl.x = from[0] + 0.5;
        pl.y = from[1] + 0.5;
      }
      pl.yaw = Math.atan2(x + 0.5 - pl.x, -(y + 0.5 - pl.y));
      pl.pitch = -0.25;
    },
  });
}
