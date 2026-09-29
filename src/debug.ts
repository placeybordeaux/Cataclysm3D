import type { Game } from './game/game';
import type { Renderer } from './render/renderer';

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
  (window as any).cdda = api;
  return api;
}
