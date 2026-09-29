import type { Game } from './game/game';
import type { Renderer } from './render/renderer';
import type { BodyPartId } from './game/bodyparts';
import { MAIN_PARTS } from './game/bodyparts';
import { createItem, inNewContainer } from './game/item';
import { installRenderDebug } from './render/renderDebug';
import { emitSound } from './game/sound';

// window.cdda is the automation surface used by tools/shot.ts and by agents testing
// features headlessly. Anything a test needs to set up (spawn, teleport, time) belongs here.

export interface DebugApi {
  ready: boolean;
  game: Game;
  renderer: Renderer;
  /** Advance the simulation by `seconds` of real time without rendering (deterministic). */
  step(seconds: number): void;
  teleport(x: number, y: number, z?: number): void;
  look(yawDeg: number, pitchDeg?: number): void;
  setHour(h: number): void;
  /** Renderer helpers: camera mode ('first'|'third'|'top'), flashlight, weather, chunk flush. */
  setCameraMode(mode: 'first' | 'third' | 'top'): void;
  flashlight(on: boolean): void;
  setWeather(kind: 'clear' | 'rain' | 'storm' | 'snow'): void;
  /** Build all pending chunk meshes and render one frame (use before screenshots). */
  settle(): void;
  renderStats(): Record<string, number | string>;
  /** Extra helpers registered by subsystems (spawnMonster, giveItem, ...). */
  [k: string]: any;
}

export function installDebugApi(game: Game, renderer: Renderer): DebugApi {
  const api: DebugApi = {
    ready: false,
    game,
    renderer,
    step(seconds) {
      const n = Math.round(seconds * 30);
      for (let i = 0; i < n; i++) game.tick(1 / 30);
    },
    teleport(x, y, z) {
      game.player.x = x;
      game.player.y = y;
      if (z !== undefined) game.player.z = z;
    },
    look(yawDeg, pitchDeg = 0) {
      game.player.yaw = (yawDeg * Math.PI) / 180;
      game.player.pitch = (pitchDeg * Math.PI) / 180;
    },
    setHour(h) {
      const c = game.clock;
      c.seconds = Math.floor(c.seconds / 86400) * 86400 + h * 3600;
    },
    setCameraMode(mode) {
      renderer.setCameraMode(mode);
    },
    flashlight(on) {
      renderer.setFlashlight(on);
    },
    setWeather(kind) {
      renderer.setWeather(kind);
    },
    settle() {
      renderer.flushChunks();
      renderer.render();
    },
    renderStats() {
      return renderer.stats();
    },
  };
  /** Survivor takes no damage (screenshots, long scripted playtests). */
  api.godMode = (on = true) => (game.player.debugInvulnerable = on);
  installCharacterHelpers(api, game);
  installRenderDebug(api, game, renderer);
  (window as any).cdda = api;
  return api;
}

// Survivor helpers (src/game/character.ts, inventory.ts) for scripted tests and screenshots.
function installCharacterHelpers(api: DebugApi, game: Game): void {
  const p = () => game.player;
  /** Compact JSON summary of the survivor: stats, HP, needs, effects, gear. */
  api.player = () => {
    const c = p();
    return {
      stats: { str: c.str, dex: c.dex, int: c.int, per: c.per, speed: c.speed },
      hp: Object.fromEntries(MAIN_PARTS.map((bp) => [bp, `${c.hp[bp].cur}/${c.hp[bp].max}`])),
      pain: c.perceivedPain(),
      stamina: `${Math.round(c.stamina)}/${c.staminaMax()}`,
      hunger: c.hungerState(),
      thirst: c.thirstDescription(),
      sleepiness: c.sleepinessDescription(),
      temp: c.bodyTempDescription(),
      morale: c.morale.level(),
      focus: Math.round(c.focus),
      effects: c.effects.all().map((e) => `${e.name() || e.id}${e.bp ? ` (${e.bp})` : ''}`),
      wielded: c.inv.wielded?.name() ?? null,
      worn: c.inv.worn.map((w) => w.name()),
      carried: c.inv.carried().map((i) => i.name()),
      weight: `${c.inv.weightCarried()}/${c.inv.weightCapacity()} g`,
      dead: c.dead,
    };
  };
  /** Give an item: worn if armor and `wear`, else stashed/wielded. Returns the action message. */
  api.giveItem = (id: string, opts: { count?: number; wear?: boolean; wield?: boolean; ammo?: string } = {}) => {
    let it = createItem(game.data, id, { count: opts.count, ammo: opts.ammo });
    // Liquids come in their default container (a loose puddle can't be carried).
    if (it.isLiquid() && it.def.container && game.data.items[it.def.container]) it = inNewContainer(game.data, it, it.def.container).container;
    if (opts.wear) return p().inv.wear(it, null).msg;
    if (opts.wield) return p().inv.wield(it, null).msg;
    const to = p().inv.giveNew(it);
    return to ? `${it.name()} -> ${to.kind}` : `no room for ${it.name()}`;
  };
  api.hurt = (bp: BodyPartId, amount: number, type = 'bash') => p().takeHit(bp, [{ type, amount }]);
  api.addEffect = (id: string, seconds: number, bp?: BodyPartId) => p().addEffect(id, seconds, { bp }).name();
  api.setSkill = (id: string, level: number) => p().setSkill(id, level);
  /** A noise `volume` loud at (dx, dy) tiles from the survivor (monsters hear it, the log says where). */
  api.noise = (dx: number, dy: number, volume = 40, desc = 'thump!') => emitSound(game, { x: p().tileX + dx, y: p().tileY + dy, z: p().z }, volume, desc).id;
}
