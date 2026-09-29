import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';
import { createItem } from '../game/item';

// window.cdda helpers for the renderer (light map, hit feedback, fields, viewmodel).
// Offsets (dx, dy) are relative to the player's tile.

export function installRenderDebug(api: DebugApi, game: Game, renderer: Renderer): void {
  const tile = () => ({ x: Math.floor(game.player.x), y: Math.floor(game.player.y), z: game.player.z });
  /** Light level (CDDA units) at the player's tile or an offset from it. */
  api.lightAt = (dx = 0, dy = 0) => {
    const t = tile();
    return +renderer.lightAt(t.x + dx, t.y + dy, t.z).toFixed(2);
  };
  /** Add a light-map lamp near the player; returns the handle (h.remove()). */
  api.addLight = (dx: number, dy: number, opts: { intensity?: number; radius?: number; color?: number; flicker?: boolean } = {}) => {
    const t = tile();
    return renderer.lights.add({ x: t.x + dx + 0.5, y: t.y + dy + 0.5, z: t.z, ...opts });
  };
  /** Put a field (fd_fire, fd_blood, fd_smoke, ...) on a tile near the player. */
  api.addField = (type: string, dx: number, dy: number, intensity = 1) => {
    const t = tile();
    game.map.addField(t.x + dx, t.y + dy, t.z, type, intensity);
  };
  /**
   * ASCII view of the light map around the player: natural share 0-9 (outdoor = 9),
   * '#' opaque, '@' player; with artificial=true shows artificial light level instead.
   */
  api.lightmapAscii = (radius = 12, artificial = false) => {
    const t = tile();
    const f = renderer.lightmap.field;
    const rows: string[] = [];
    for (let y = t.y - radius; y <= t.y + radius; y++) {
      let r = '';
      for (let x = t.x - radius; x <= t.x + radius; x++) {
        const i = f.index(x, y);
        if (x === t.x && y === t.y) r += '@';
        else if (i < 0) r += ' ';
        else if (f.opaque[i]) r += '#';
        else {
          const v = artificial ? Math.min(9, Math.floor(Math.log2(1 + f.artificialAt(x, y)))) : Math.min(9, Math.floor(f.natural[i] * 9.99));
          r += String(v);
        }
      }
      rows.push(r);
    }
    return rows.join('\n');
  };
  /** Drop an item on the map at an offset from the player (or absolute with abs=true). */
  api.placeItem = (id: string, dx: number, dy: number, abs = false) => {
    const t = tile();
    const x = abs ? dx : t.x + dx, y = abs ? dy : t.y + dy;
    game.map.addItem(x, y, t.z, createItem(game.data, id));
  };
  /** Turn the player to face tile (x, y) (absolute tile coords; +0.5 = centre). */
  api.lookAt = (x: number, y: number, pitchDeg = 0) => {
    const p = game.player;
    p.yaw = Math.atan2(x - p.x, -(y - p.y));
    p.pitch = (pitchDeg * Math.PI) / 180;
  };
  /** First tile (absolute) within `radius` of the player whose furniture id matches. */
  api.findFurniture = (re: string, radius = 30) => {
    const t = tile(), rx = new RegExp(re);
    for (let r = 0; r <= radius; r++)
      for (let y = t.y - r; y <= t.y + r; y++)
        for (let x = t.x - r; x <= t.x + r; x++) {
          if (Math.max(Math.abs(x - t.x), Math.abs(y - t.y)) !== r) continue;
          const f = game.map.furnAt(x, y, t.z);
          if (f.id !== 'f_null' && rx.test(f.id)) return { x, y, id: f.id };
        }
    return null;
  };
  /** Render `n` frames synchronously (gl.finish) and report ms/frame + draw stats. */
  api.benchRender = (n = 20) => {
    const gl = renderer.three.getContext();
    const px = new Uint8Array(4);
    renderer.render();
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      renderer.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    }
    const ms = (performance.now() - t0) / n;
    const s = renderer.stats();
    return { msPerFrame: +ms.toFixed(1), calls: s.calls, triangles: s.triangles, chunks: s.chunks, sprites: s.sprites, decor: s.decor };
  };
  /**
   * Pixel-stability metric for a slow first-person pan: renders `frames` frames turning
   * `pxPerFrame` low-res pixels per frame and, for each consecutive pair, counts the share
   * of pixels that differ even after the best whole-pixel horizontal shift (i.e. shimmer and
   * crawl rather than rigid scrolling). Lower is steadier. Viewmodel hidden during the test.
   */
  api.shimmerTest = (frames = 12, pxPerFrame = 0.37) => {
    const pl = renderer.pipeline;
    const w = pl.lowW, h = pl.lowH;
    const cam = renderer.camera;
    const step = pxPerFrame * (2 * Math.tan((cam.fov * Math.PI) / 360)) / h;
    const vm = renderer.viewmodel!;
    vm.scene.visible = false;
    const yaw0 = game.player.yaw;
    let prev: Uint8Array | null = null;
    let sum = 0;
    for (let f = 0; f < frames; f++) {
      game.player.yaw = yaw0 + f * step;
      renderer.render();
      const cur = new Uint8Array(w * h * 4);
      renderer.three.readRenderTargetPixels(pl.postTarget, 0, 0, w, h, cur);
      if (prev) {
        let best = 1;
        for (let s = -2; s <= 2; s++) {
          let bad = 0, n = 0;
          for (let y = Math.floor(h * 0.1); y < Math.floor(h * 0.7); y++)
            for (let x = Math.floor(w * 0.2); x < Math.floor(w * 0.8); x++) {
              const a = (y * w + x) * 4, b = (y * w + x + s) * 4;
              const d = Math.abs(cur[a] - prev[b]) + Math.abs(cur[a + 1] - prev[b + 1]) + Math.abs(cur[a + 2] - prev[b + 2]);
              if (d > 24) bad++;
              n++;
            }
          best = Math.min(best, bad / n);
        }
        sum += best;
      }
      prev = cur;
    }
    game.player.yaw = yaw0;
    vm.scene.visible = true;
    return +(sum / (frames - 1)).toFixed(4);
  };
  api.shake = (amount = 0.5) => renderer.shake(amount);
  api.hurtFlash = (amount = 0.5) => renderer.hurtFlash(amount);
  /** Viewmodel animation: 'melee' | 'fire' | 'throw'. */
  api.attack = (kind: 'melee' | 'fire' | 'throw' = 'melee') => renderer.viewmodel?.attack(kind);
  /** Freeze the viewmodel in an attack pose at t (0..1) for screenshots; null releases. */
  api.viewmodelPose = (kind: 'melee' | 'fire' | 'throw' | null, t = 0.5) => renderer.viewmodel?.freeze(kind, t);
}
