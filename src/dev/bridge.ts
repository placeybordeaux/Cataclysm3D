import type { Game } from '../game/game';
import type { Renderer } from '../render/renderer';
import type { DebugApi } from '../debug';

// Dev-only client half of the live bridge (tools/dev/liveBridge.ts): reports what the player
// is seeing so the developer at the terminal can follow along, and answers screenshot/eval
// requests. Installed only when Vite HMR is present, i.e. never in production builds.

const MAX_TEXT = 4000;
const recentErrors: string[] = [];

export function installDevBridge(game: Game, renderer: Renderer, api: DebugApi): void {
  const hot = import.meta.hot;
  if (!hot) return;

  // Keep the last few page errors/warnings so the state shows what went wrong.
  const note = (kind: string, args: unknown[]) => {
    recentErrors.push(`${kind}: ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' ')}`.slice(0, 600));
    if (recentErrors.length > 20) recentErrors.shift();
  };
  for (const kind of ['error', 'warn'] as const) {
    const orig = console[kind].bind(console);
    console[kind] = (...args: unknown[]) => {
      note(kind, args);
      orig(...args);
    };
  }
  window.addEventListener('error', (e) => note('exception', [e.error ?? e.message]));
  window.addEventListener('unhandledrejection', (e) => note('rejection', [e.reason]));

  const state = () => {
    const p = game.player;
    const ui = document.getElementById('ui');
    const windows = [...document.querySelectorAll<HTMLElement>('#ui .cdda-window')].map((w) => w.innerText.slice(0, MAX_TEXT));
    const hp = Object.fromEntries(Object.entries(p.hp).map(([k, v]) => [k, `${v.cur}/${v.max}`]));
    return {
      at: new Date().toISOString(),
      clock: game.clock.format(),
      player: {
        x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: p.z,
        yawDeg: Math.round(((p.yaw * 180) / Math.PI) % 360), pitchDeg: Math.round((p.pitch * 180) / Math.PI),
        hp, pain: p.pain, stamina: Math.round(p.stamina), dead: p.dead,
        wielded: p.inv.wielded?.name() ?? null,
        effects: [...p.effects.all?.() ?? []].map((e: any) => e.type?.id ?? String(e)).slice(0, 20),
        running: p.running, crouching: p.crouching,
      },
      place: (api.omtAt?.(Math.floor(p.x / 24), Math.floor(p.y / 24), p.z) as { id?: string } | undefined)?.id ?? null,
      weather: game.weather?.name ?? null,
      camera: renderer.rig.mode,
      input: { pointerLocked: game.input.locked, menuOpen: game.input.captured, paused: game.paused || game.lockPaused },
      openWindows: windows,
      hudText: ui ? ui.innerText.slice(0, MAX_TEXT) : '',
      log: (api.ui?.log?.() as string[] | undefined)?.slice(-15) ?? [],
      render: renderer.stats?.() ?? null,
      monstersNear: (api.monsters?.() as unknown[] | undefined)?.length ?? null,
      errors: recentErrors.slice(-10),
    };
  };
  // Several tabs may be open on the dev server; only the one the human is looking at reports
  // and answers requests (hidden/background tabs stay quiet).
  const active = () => document.visibilityState === 'visible';
  const push = () => {
    if (!active()) return;
    try {
      hot.send('cdda:state', state());
    } catch (e) {
      console.debug('dev bridge state failed', e);
    }
  };
  setInterval(push, 2000);

  hot.on('cdda:eval', async ({ id, code }: { id: number; code: string }) => {
    if (!active()) return;
    try {
      let fn: () => Promise<unknown>;
      try {
        // Expression form first ("cdda.game.player.x"), statements otherwise ("const a = 1; return a").
        fn = new Function('cdda', 'game', `return (async () => (${code}))();`).bind(null, api, game);
      } catch {
        fn = new Function('cdda', 'game', `return (async () => { ${code} })();`).bind(null, api, game);
      }
      const result = await fn();
      hot.send('cdda:reply', { id, result: JSON.parse(JSON.stringify(result ?? null)) });
    } catch (e) {
      hot.send('cdda:reply', { id, error: String((e as Error)?.stack ?? e) });
    }
  });

  hot.on('cdda:shot', ({ id }: { id: number }) => {
    if (!active()) return;
    // The WebGL buffer is only readable right after a frame is drawn, so capture from the
    // main loop's post-render hook on the next frame.
    api.__onFrame = () => {
      api.__onFrame = undefined;
      try {
        hot.send('cdda:reply', { id, image: renderer.three.domElement.toDataURL('image/png') });
      } catch (e) {
        hot.send('cdda:reply', { id, error: String(e) });
      }
    };
  });
  push();
}
