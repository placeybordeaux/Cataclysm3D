import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import { CHUNK } from './coords';
import type { WorldGenerator } from './worldgen';

// window.cdda helpers for the world generator (see ARCHITECTURE.md "window.cdda").

export function installWorldgenDebug(api: DebugApi, game: Game, gen: WorldGenerator): void {
  const pOmt = () => ({ x: Math.floor(game.player.x / CHUNK), y: Math.floor(game.player.y / CHUNK) });
  /** Overmap symbols around the player (radius in OMTs). '@' marks the player's OMT. */
  api.dumpOvermap = (radius = 20, z = game.player.z) => {
    const p = pOmt();
    return gen.overmap.dump(p.x, p.y, radius, z);
  };
  /** ASCII rows of one chunk (OMT coords), furniture symbol over terrain symbol. */
  api.dumpChunk = (cx: number, cy: number, z = 0) => gen.dumpChunk(game.map, cx, cy, z);
  /** Overmap terrain at OMT coords (default: player's). */
  api.omtAt = (x?: number, y?: number, z?: number) => {
    const p = pOmt();
    const o = gen.overmap.omtAt(x ?? p.x, y ?? p.y, z ?? game.player.z);
    return { id: o.id, type: o.type, rot: o.rot, line: o.line, special: o.special?.def, city: o.special?.city?.name };
  };
  /** Generation stats: % JSON mapgen, ms/chunk, unsupported features, unknown ids. */
  api.worldgenStats = () => gen.stats.summary();
  api.cities = () => gen.overmap.citiesNear(game.player.x / CHUNK, game.player.y / CHUNK);
  /** Nearest OMT whose id contains `text`; returns OMT coords. */
  api.findOmt = (text: string, maxRadius = 60) => {
    const f = gen.overmap.findNearest((o) => o.id.includes(text), pOmt(), maxRadius);
    return f ? { x: f.x, y: f.y, id: f.omt.id } : null;
  };
  /** Teleport to the centre of an OMT (or tile (lx, ly) inside it). */
  api.teleportOmt = (x: number, y: number, z = 0, lx = 12, ly = 12) => {
    game.player.x = x * CHUNK + lx + 0.5;
    game.player.y = y * CHUNK + ly + 0.5;
    game.player.z = z;
  };
  api.startLocation = () => gen.findStartLocation('shelter', game.map);
  /** Chunk extras placed by mapgen (signs, spawns, zones...) for the chunk at OMT coords. */
  api.chunkInfo = (cx: number, cy: number, z = 0) => {
    const c = game.map.chunk(cx, cy, z);
    if (!c) return null;
    return {
      omt: c.omt, items: [...c.items.values()].reduce((a, l) => a + l.length, 0), spawns: c.spawns, vehicles: c.vehicles,
      zones: c.zones, signs: [...c.signs.values()], graffiti: [...c.graffiti.values()], computers: c.computers.size,
    };
  };
}
