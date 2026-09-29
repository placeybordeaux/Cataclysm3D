import type { Game, LookCreature } from './game/game';
import type { Renderer } from './render/renderer';
import type { DebugApi } from './debug';
import type { WorldGenerator } from './world/worldgen';
import type { MonstersHandle } from './monsters';
import type { Chunk } from './world/map';
import { Rng, hashSeed } from './core/rng';
import { CHUNK, chunkKey } from './world/coords';
import { oterRotation } from './world/overmap/oter';
import { NpcSystem, type NpcSystemJSON } from './game/npcai';
import type { Npc, NpcData } from './game/npc';
import type { Dialogue } from './game/talk';
import { NpcView } from './render/npcView';
import { hud } from './ui/hud';
import { interact } from './game/interact';
import { playerCanSee, isOutside } from './game/vision';
import { chunkTracker } from './save/tracking';
import { registerSaveable } from './save/registry';
import { sanitizeItemJSON } from './save/items';
import { confirmAttackNpc, factionName, openChatMenu, openDialogue, openMissionLog, openTrade, pickItemMenu, type NpcUiCtx } from './ui/npc_ui';
import type { UiWindow } from './ui/framework';

// Wiring for NPCs: data (public/data/npcs.json), the simulation system, mapgen placements
// (the refugee center's Free Merchants) and random survivors in towns, player combat hooks,
// keys (C chat, M missions, e talks to the NPC under the crosshair), HUD prompt, look mode,
// save section 'npcs', rendering and window.cdda helpers. main.ts awaits installNpcs() once.

export interface NpcsHandle {
  sys: NpcSystem;
  view: NpcView | null;
  talk(n: Npc): void;
}

/** Common npc_class ids random survivors are drawn from (npc_class "common", sensible ones). */
const RANDOM_CLASSES = ['NC_SCAVENGER', 'NC_HUNTER', 'NC_FARMER', 'NC_DOCTOR', 'NC_COWBOY', 'NC_BOUNTY_HUNTER', 'NC_TRADER', 'NC_HACKER', 'NC_MOTORHEAD', 'NC_SOLDIER'];
/** One random NPC per this many city OMTs (CDDA's overmap NPC density is low too). */
const CITY_NPC_ONE_IN = 45;

export async function loadNpcData(base = '/data/'): Promise<NpcData> {
  const res = await fetch(base + 'npcs.json');
  if (!res.ok) throw new Error(`Failed to load ${base}npcs.json: HTTP ${res.status} (run \`npm run extract:npcs\`)`);
  return res.json();
}

export async function installNpcs(game: Game, renderer: Renderer | null, worldgen: WorldGenerator | null, monsters: MonstersHandle | null, api?: DebugApi, nd?: NpcData): Promise<NpcsHandle> {
  const data = nd ?? (await loadNpcData());
  const sys = new NpcSystem(game, data, monsters?.sys ?? null);
  game.systems.push(sys);
  (game as unknown as { npcs: NpcSystem }).npcs = sys;
  let view: NpcView | null = null;
  if (renderer) {
    view = new NpcView(game, renderer, sys);
    game.systems.push(view);
  }

  // ---------------------------------------------------------------- world queries
  if (worldgen) {
    const om = worldgen.overmap;
    sys.omtAt = (x, y, z) => om.omtAt(x, y, z).id;
    sys.omtRotation = (x, y, z) => oterRotation(om.omtAt(x, y, z), worldgen.wg.overmap.terrains);
    sys.mapgenUpdate = (src, at, opts) => worldgen.applyUpdate(game.map, src, at.x, at.y, at.z, opts);
    sys.cityName = () => om.closestCity(Math.floor(game.player.x / CHUNK), Math.floor(game.player.y / CHUNK))?.name ?? 'town';
    sys.findOmt = (pred, from, opts) => {
      const min = opts.minDist ?? 0, max = Math.min(opts.maxDist ?? 80, 160);
      if (opts.random) {
        const cands: { x: number; y: number }[] = [];
        for (let dy = -max; dy <= max; dy += 1)
          for (let dx = -max; dx <= max; dx += 1) {
            const d = Math.max(Math.abs(dx), Math.abs(dy));
            if (d < min || d > max || (dx * 7 + dy * 13) % 3) continue; // sparse sample keeps this cheap
            if (pred(om.omtAt(from.x + dx, from.y + dy, 0).id)) cands.push({ x: from.x + dx, y: from.y + dy });
          }
        return cands.length ? sys.rng.pick(cands) : null;
      }
      for (let r = min; r <= max; r++)
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            if (pred(om.omtAt(from.x + dx, from.y + dy, 0).id)) return { x: from.x + dx, y: from.y + dy };
          }
      return null;
    };
    sys.reveal = (x, y, r) => {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) game.overmapSeen.add(`${x + dx},${y + dy},0`);
    };
  }

  // ---------------------------------------------------------------- UI hooks
  const uiCtx = (): NpcUiCtx => ({ game, renderer: renderer!, sys });
  let current: { d: Dialogue; win: UiWindow } | null = null;
  const talk = (n: Npc) => {
    if (!renderer || typeof document === 'undefined') return;
    const d = sys.talkTo(n);
    if (!d) return;
    const win = openDialogue(uiCtx(), d, () => {
      if (current?.d === d) current = null;
    });
    current = { d, win };
  };
  if (renderer && typeof document !== 'undefined') {
    sys.startTrade = (n, cost = 0, onDone) => void openTrade(uiCtx(), n, cost, onDone);
    sys.pickItem = pickItemMenu;
    sys.confirmAttack = confirmAttackNpc;
    sys.onWantsTalk = (n) => {
      if (game.input.captured || game.player.dead) return;
      game.message(`${n.name} wants to talk to you.`, 'c_yellow');
      talk(n);
    };
  }

  // ---------------------------------------------------------------- combat hooks
  if (monsters) {
    const combat = monsters.combat;
    combat.attackGuard = () => sys.guardAttack();
    combat.npcMelee = (reach, m) => {
      if (!sys.playerMelee(reach, m)) return false;
      combat.cooldown = sys.lastPlayerSwing;
      return true;
    };
    combat.npcShot = (yaw, maxDist, shot) => sys.playerShot(yaw, maxDist, shot);
    game.activities.dangerChecks.push(() => {
      const p = game.player;
      for (const n of sys.npcs) {
        if (n.dead || !n.isEnemy() || n.z !== p.z || Math.hypot(n.x - p.x, n.y - p.y) > 30) continue;
        if (playerCanSee(game, n.tileX, n.tileY, n.z)) return `${n.name} is hostile!`;
      }
      return null;
    });
  }

  // ---------------------------------------------------------------- look mode / crosshair
  const prevCreatureAt = game.creatureAt;
  game.creatureAt = (x, y, z) => {
    const n = sys.npcAt(x, y, z);
    if (!n) return prevCreatureAt(x, y, z);
    return { name: n.displayName(), symbol: '@', color: n.isEnemy() ? 'c_red' : n.isAlly() ? 'c_light_green' : 'c_white', describe: () => describeNpc(sys, n), npc: n } as LookCreature;
  };
  const npcUnderCrosshair = (maxDist = 3): Npc | null => {
    const hit = game.lookAt?.(maxDist);
    const n = hit?.kind === 'creature' ? (hit.creature as { npc?: Npc } | undefined)?.npc : undefined;
    if (n && !n.dead && Math.hypot(n.x - game.player.x, n.y - game.player.y) <= maxDist + 0.5) return n;
    return null;
  };
  hud.addPromptProvider(() => {
    const n = npcUnderCrosshair();
    if (!n || n.isEnemy()) return null;
    return `[${game.keys.keyFor('interact')}] Talk to ${n.displayName()}`;
  });

  // ---------------------------------------------------------------- keys
  const prevInteract = game.keys.handler('interact');
  game.keys.register('interact', 'Examine / open / close / use / talk', () => {
    const n = npcUnderCrosshair();
    if (n && !n.isEnemy()) return talk(n);
    if (prevInteract) prevInteract();
    else void interact(game);
  });
  game.keys.register('chat', 'Chat with NPCs / order followers', () => {
    const n = npcUnderCrosshair(4);
    if (n) return talk(n);
    if (renderer) openChatMenu(uiCtx(), talk);
  });
  game.keys.register('missions', 'View missions', () => {
    if (renderer) openMissionLog(uiCtx());
  });

  // ---------------------------------------------------------------- spawning
  const startOmt = { x: Math.floor(game.player.x / CHUNK), y: Math.floor(game.player.y / CHUNK) };
  // The refugee center is the NPC hub the evacuee is meant to find, but nothing in the world
  // pointed at it (it can sit 20+ OMTs away in a forest). Mark it on the map from the start, as
  // CDDA's evacuation broadcasts do; a loaded save replaces overmapSeen with its own.
  if (worldgen) revealRefugeeCenter(game, worldgen, startOmt);
  const onChunk = (c: Chunk) => {
    // Chunks generated before a loaded save already made their NPCs (they're in the save).
    const prior = chunkTracker(game)?.priorGenerated.has(chunkKey(c.cx, c.cy, c.z)) ?? false;
    if (c.npcSpawns.length) {
      if (!prior) for (const s of c.npcSpawns) spawnMapgenNpc(sys, s.template, s.x, s.y, s.z, s.addTrait);
      c.npcSpawns = [];
    }
    if (!prior && worldgen && c.z === 0) randomSurvivor(sys, worldgen, c, startOmt);
  };
  game.map.onChunkGenerated.push(onChunk);
  game.map.onChunkUpdated.push((c) => {
    for (const s of c.npcSpawns) spawnMapgenNpc(sys, s.template, s.x, s.y, s.z, s.addTrait);
    c.npcSpawns = [];
  });
  // Chunks generated before this install (the start area) get their placements too.
  for (const c of game.map.loadedChunks()) if (c.npcSpawns.length) onChunk(c);

  // ---------------------------------------------------------------- save
  registerSaveable<NpcSystemJSON>(game, 'npcs', {
    order: 25,
    save: () => sys.toJSON(),
    load: (s, ctx) => {
      const clean = (j: Parameters<typeof sanitizeItemJSON>[1] | null) => (j ? sanitizeItemJSON(game.data, j, ctx.warn) : null);
      const npcs = s.npcs.map((n) => ({
        ...n,
        character: { ...n.character, inventory: { wielded: clean(n.character.inventory.wielded), worn: n.character.inventory.worn.map(clean).filter((x): x is NonNullable<typeof x> => !!x) } },
        stock: n.stock.map(clean).filter((x): x is NonNullable<typeof x> => !!x),
      }));
      const missions = { ...s.missions, missions: s.missions.missions.filter((m) => (data.missions[m.id] ? true : (ctx.warn(`unknown mission "${m.id}" dropped`), false))) };
      sys.fromJSON({ ...s, npcs, missions });
    },
    missing: () => sys.clear(),
  });

  if (api) installDebug(api, game, sys, worldgen, talk, () => current, uiCtx);
  return { sys, view, talk };
}

/** place_npcs: template id + optional traits; spawnKey keeps reloads from duplicating them. */
function spawnMapgenNpc(sys: NpcSystem, template: string, x: number, y: number, z: number, addTrait?: string[]): Npc | null {
  const n = sys.spawn({ template }, x, y, z, { spawnKey: `mg:${x},${y},${z}:${template}` });
  if (n) for (const t of addTrait ?? []) n.traits.add(t);
  return n;
}

/**
 * A few survivors roam the towns (CDDA's overmap NPCs): mostly scavengers of the common
 * classes, some of whom walk up to talk or carry a job, and the odd bandit gang member
 * who attacks on sight (never right next to the evac shelter).
 */
/** Add the refugee center's OMTs (evac_center special) to the overmap memory. */
export function revealRefugeeCenter(game: Game, wg: WorldGenerator, from: { x: number; y: number }): { x: number; y: number } | null {
  const sp = wg.overmap.findSpecial('evac_center', from, 3);
  if (!sp) return null;
  let n = 0, sx = 0, sy = 0;
  for (let dy = -18; dy <= 18; dy++)
    for (let dx = -18; dx <= 18; dx++) {
      if (!/^(refctr|evac_center)/.test(wg.overmap.omtAt(sp.x + dx, sp.y + dy, 0).id)) continue;
      game.overmapSeen.add(`${sp.x + dx},${sp.y + dy},0`);
      (n++, (sx += sp.x + dx), (sy += sp.y + dy));
    }
  return n ? { x: Math.round(sx / n), y: Math.round(sy / n) } : null;
}

function randomSurvivor(sys: NpcSystem, wg: WorldGenerator, c: Chunk, start: { x: number; y: number }): void {
  const o = wg.overmap.omtAt(c.cx, c.cy, 0);
  const inCity = !!o.special?.city || (o.type === 'road' && !!wg.overmap.closestCity(c.cx, c.cy, 0));
  if (!inCity) return;
  const rng = new Rng(hashSeed(sys.game.seed, c.cx, c.cy, 0x4e5043));
  if (!rng.oneIn(o.type === 'road' ? CITY_NPC_ONE_IN * 2 : CITY_NPC_ONE_IN)) return;
  const map = sys.game.map;
  let spot: [number, number] | null = null;
  for (let i = 0; i < 40 && !spot; i++) {
    const x = c.cx * CHUNK + rng.int(1, CHUNK - 2), y = c.cy * CHUNK + rng.int(1, CHUNK - 2);
    if (!map.passable(x, y, 0) || map.furnAt(x, y, 0).id !== 'f_null') continue;
    if (i < 25 && !isOutside(map, x, y, 0)) continue;
    spot = [x, y];
  }
  if (!spot) return;
  const nearStart = Math.max(Math.abs(c.cx - start.x), Math.abs(c.cy - start.y)) < 8;
  const key = `rnd:${c.cx},${c.cy}`;
  if (!nearStart && rng.oneIn(5)) {
    sys.spawn({ template: 'thug' }, spot[0], spot[1], 0, { spawnKey: key, attitude: 'KILL' });
    return;
  }
  const classes = RANDOM_CLASSES.filter((id) => sys.nd.classes[id]);
  const n = sys.spawn({ cls: rng.pick(classes) }, spot[0], spot[1], 0, { spawnKey: key, randomMission: rng.oneIn(2), attitude: rng.oneIn(3) ? 'TALK' : 'NULL' });
  if (n) n.nameSuffix = undefined;
}

/** Look-mode text: attitude, health, faction, what they're holding. */
export function describeNpc(sys: NpcSystem, n: Npc): string {
  const f = n.hpPercent();
  const health = f >= 100 ? '<color_green>Uninjured</color>' : f > 75 ? '<color_light_green>Lightly injured</color>' : f > 50 ? '<color_yellow>Moderately injured</color>' : f > 25 ? '<color_light_red>Heavily injured</color>' : '<color_red>Nearly dead</color>';
  const att = n.isEnemy() ? '<color_red>Hostile!</color>' : n.isAlly() ? '<color_light_green>Follower</color>' : n.attitude === 'FLEE_TEMP' || n.attitude === 'FLEE' ? '<color_light_blue>Fleeing</color>' : '<color_light_gray>Neutral</color>';
  const job = sys.nd.classes[n.classId]?.name;
  return `${att}  ${health}\n${factionName(sys, n)}${job ? ` — ${job}` : ''}\nWielding: ${n.inv.wielded?.name() ?? 'nothing'}.  Wearing: ${n.inv.worn.slice(-3).map((w) => w.baseName()).join(', ') || 'nothing'}.`;
}

// ------------------------------------------------------------------ debug API

function installDebug(api: DebugApi, game: Game, sys: NpcSystem, wg: WorldGenerator | null, talk: (n: Npc) => void, current: () => { d: Dialogue; win: UiWindow } | null, uiCtx: () => NpcUiCtx): void {
  const p = () => game.player;
  api.npcSystem = sys;
  /** Spawn an NPC by template id (e.g. 'free_merchants_merchant') or npc_class id ('NC_SCAVENGER') at (dx, dy) tiles from the survivor. */
  api.spawnNpc = (id: string, dx = 0, dy = -3, opts: { attitude?: Npc['attitude']; follow?: boolean } = {}) => {
    const spec = sys.nd.templates[id] ? { template: id } : { cls: id };
    const n = sys.spawn(spec, p().x + dx, p().y + dy, p().z, { attitude: opts.attitude });
    if (!n) return null;
    if (opts.follow) sys.dialogueFor(n)!.effect('follow');
    n.facing = Math.atan2(p().x - n.x, -(p().y - n.y));
    return n.uid;
  };
  api.npcs = (all = false) =>
    (all ? sys.npcs : sys.active()).map((n) => ({
      uid: n.uid, name: n.displayName(), template: n.templateId, class: n.classId, x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: n.z,
      attitude: n.attitude, faction: n.faction, goal: n.goal.kind, hp: `${n.hpPercent()}%`, dead: n.dead, following: n.following,
      wielded: n.inv.wielded?.typeId ?? null, dist: +Math.hypot(n.x - p().x, n.y - p().y).toFixed(1),
    }));
  const find = (uid?: number) => (uid === undefined ? sys.nearest(40) : sys.npcByUid(uid) ?? null);
  /** Open the dialogue with an NPC (nearest by default). Returns its first topic id. */
  api.talk = (uid?: number) => {
    const n = find(uid);
    if (!n) return null;
    talk(n);
    return current()?.d.current ?? null;
  };
  /** Current dialogue state: topic, NPC line, responses. */
  api.dialogue = () => {
    const c = current();
    if (!c || c.win.closed) return null;
    const v = c.d.view();
    return { topic: v.id, line: v.line, responses: v.responses.map((r) => `${r.available ? '' : '(x) '}${r.text}`) };
  };
  /** Pick response #i in the open dialogue (as if its letter was pressed). */
  api.respond = (i: number) => {
    const c = current();
    if (!c) return null;
    api.pressKey?.('abcdefghijklmnopqrstuvwxyz'[i]);
    return api.dialogue();
  };
  /** Pick the first response whose text contains `text`. */
  api.respondText = (text: string) => {
    const c = current();
    if (!c) return null;
    const i = c.d.view().responses.findIndex((r) => r.text.includes(text));
    return i < 0 ? { error: `no response containing "${text}"`, ...api.dialogue() } : api.respond(i);
  };
  api.trade = (uid?: number) => {
    const n = find(uid);
    if (n) openTrade(uiCtx(), n);
    return !!n;
  };
  api.missionLog = () => openMissionLog(uiCtx());
  api.missions = () => [...sys.missions.all.values()].map((m) => ({ uid: m.uid, id: m.id, status: m.status, giver: m.npcUid, goal: sys.missions.goalText(m), target: m.target }));
  /** Accept a mission from an NPC without the dialogue (tests). */
  api.giveMission = (id: string, uid?: number) => {
    const n = find(uid);
    const m = sys.missions.create(id, n ?? null);
    if (m) sys.missions.assign(m, n ? sys.dialogueFor(n) : null);
    return m?.uid ?? null;
  };
  /** Run an update_mapgen id on an OMT (default: the one the survivor stands in). */
  api.mapgenUpdate = (id: string, omx = Math.floor(p().x / CHUNK), omy = Math.floor(p().y / CHUNK), z = p().z) =>
    sys.mapgenUpdate?.(id, { x: omx, y: omy, z }) ?? false;
  /** Teleport next to the refugee center's front door (the evac_center special). */
  api.teleportRefugeeCenter = (where: 'outside' | 'merchant' | 'lobby' = 'lobby') => {
    if (!wg) return null;
    const sp = wg.overmap.findSpecial('evac_center', { x: Math.floor(p().x / CHUNK), y: Math.floor(p().y / CHUNK) }, 3);
    if (!sp) return null;
    // Generate the whole center so its NPCs exist, then stand next to one of them. The special
    // is rotated, so its OMTs can lie on any side of the origin: find them by id.
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (let dy = -18; dy <= 18; dy++)
      for (let dx = -18; dx <= 18; dx++) {
        if (!/^(refctr|evac_center)/.test(wg.overmap.omtAt(sp.x + dx, sp.y + dy, 0).id)) continue;
        game.map.chunk(sp.x + dx, sp.y + dy, 0);
        bx0 = Math.min(bx0, sp.x + dx), by0 = Math.min(by0, sp.y + dy), bx1 = Math.max(bx1, sp.x + dx), by1 = Math.max(by1, sp.y + dy);
      }
    if (bx0 === Infinity) (bx0 = bx1 = sp.x), (by0 = by1 = sp.y);
    const merchant = sys.npcs.find((n) => n.templateId === 'free_merchants_merchant');
    const anchor = where === 'merchant' ? merchant : where === 'lobby' ? sys.npcs.find((n) => n.templateId === 'refugee_beggar1') ?? merchant : null;
    let x: number, y: number;
    if (anchor) {
      const spot = [[0, 2], [2, 0], [0, -2], [-2, 0], [1, 1], [-1, 1], [1, -1], [-1, -1]].find(([dx, dy]) => game.map.passable(anchor.tileX + dx, anchor.tileY + dy, 0));
      x = anchor.tileX + (spot?.[0] ?? 0) + 0.5;
      y = anchor.tileY + (spot?.[1] ?? 1) + 0.5;
      p().yaw = Math.atan2(anchor.x - x, -(anchor.y - y));
    } else {
      // just outside the south fence, midway along it
      x = Math.floor((bx0 + bx1) / 2) * CHUNK + 12;
      y = (by1 + 1) * CHUNK + 4;
    }
    p().x = x;
    p().y = y;
    p().z = 0;
    return { omx: sp.x, omy: sp.y, npcs: sys.npcs.filter((n) => Math.abs(n.x - x) < 80 && Math.abs(n.y - y) < 80).length };
  };
  /** Face an NPC (screenshots). */
  api.faceNpc = (uid?: number) => {
    const n = find(uid);
    if (!n) return false;
    p().yaw = Math.atan2(n.x - p().x, -(n.y - p().y));
    p().pitch = 0;
    return true;
  };
}
