import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { Renderer } from './renderer';

// window.cdda helpers for the renderer (light map, hit feedback, fields, viewmodel).
// Offsets (dx, dy) are relative to the player's tile.

export function installRenderDebug(api: DebugApi, game: Game, renderer: Renderer): void {
  const tile = () => ({ x: Math.floor(game.player.x), y: Math.floor(game.player.y), z: game.player.z });
  // cdda.lightAt(x, y, z) / addField(x, y, z, type) / placeItem(id, dx, dy) / attack() come from
  // worldInteraction, crafting and monsters (installed later; same-named helpers here were
  // silently overwritten). vision lightAt reads this renderer's light map where it's exact.
  /** Add a light-map lamp near the player; returns the handle (h.remove()). */
  api.addLight = (dx: number, dy: number, opts: { intensity?: number; radius?: number; color?: number; flicker?: boolean } = {}) => {
    const t = tile();
    return renderer.lights.add({ x: t.x + dx + 0.5, y: t.y + dy + 0.5, z: t.z, ...opts });
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
  /**
   * Flicker metric for walking (translation can't be compensated like a pan): steps the
   * eye `step` m per frame along the view and counts pixels that change and change *back*
   * over three consecutive frames (A -> B -> A: speckle, crawling texels, popping outlines)
   * within the rows [y0, y1] of the image (fractions, default the band around the horizon
   * where distant things are). Real motion rarely returns to the old value. Lower is steadier.
   * `dt` > 0 lets swaying foliage animate too; `map` returns a heat map PNG as well.
   */
  api.flickerTest = (frames = 16, step = 0.04, y0 = 0.35, y1 = 0.62, map = false, dt = 0) => {
    const pl = renderer.pipeline;
    const w = pl.lowW, h = pl.lowH;
    const vm = renderer.viewmodel!;
    vm.scene.visible = false;
    const p = game.player;
    const x0 = p.x, yy0 = p.y;
    const fx = Math.sin(p.yaw), fy = -Math.cos(p.yaw);
    const shots: Uint8Array[] = [];
    let sum = 0, n = 0;
    // map=true: also return a PNG data URL of where it flickered (white = every frame)
    const acc = map ? new Uint16Array(w * h) : null;
    for (let f = 0; f < frames; f++) {
      p.x = x0 + fx * step * f;
      p.y = yy0 + fy * step * f;
      // dt 0 freezes swaying foliage/grass: only the camera's own motion counts
      renderer.render(dt);
      const cur = new Uint8Array(w * h * 4);
      renderer.three.readRenderTargetPixels(pl.postTarget, 0, 0, w, h, cur);
      shots.push(cur);
      if (shots.length >= 3) {
        const [a, b, c] = shots.slice(-3);
        let bad = 0, m = 0;
        // readRenderTargetPixels rows are bottom-up
        for (let y = Math.floor(h * (1 - y1)); y < Math.floor(h * (1 - y0)); y++)
          for (let x = Math.floor(w * 0.05); x < Math.floor(w * 0.95); x++) {
            const i = (y * w + x) * 4;
            const ab = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
            const ac = Math.abs(a[i] - c[i]) + Math.abs(a[i + 1] - c[i + 1]) + Math.abs(a[i + 2] - c[i + 2]);
            if (ab > 36 && ac < 12) {
              bad++;
              if (acc) acc[y * w + x]++;
            }
            m++;
          }
        sum += bad / m;
        n++;
      }
    }
    p.x = x0;
    p.y = yy0;
    vm.scene.visible = true;
    const score = +(sum / Math.max(1, n)).toFixed(4);
    if (!acc) return score;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    const last = shots[shots.length - 1];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const src = ((h - 1 - y) * w + x), o = (y * w + x) * 4;
        const k = Math.min(1, (acc[src] / Math.max(1, n)) * 3);
        const g = (last[src * 4] + last[src * 4 + 1] + last[src * 4 + 2]) / 9;
        img.data[o] = g + k * (255 - g);
        img.data[o + 1] = g * (1 - k);
        img.data[o + 2] = g * (1 - k);
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    return { score, png: cv.toDataURL('image/png') };
  };
  api.shake = (amount = 0.5) => renderer.shake(amount);
  api.hurtFlash = (amount = 0.5) => renderer.hurtFlash(amount);
  /** Viewmodel animation only: 'melee' | 'fire' | 'throw' (cdda.attack() really attacks). */
  api.viewmodelAttack = (kind: 'melee' | 'fire' | 'throw' = 'melee') => renderer.viewmodel?.attack(kind);
  /** Freeze the viewmodel in an attack pose at t (0..1) for screenshots; null releases. */
  api.viewmodelPose = (kind: 'melee' | 'fire' | 'throw' | null, t = 0.5) => renderer.viewmodel?.freeze(kind, t);
}
