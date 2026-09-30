import type { Game } from '../game/game';
import { AudioEngine } from './audio';
import { isNight } from './ambience';
import { footstepVariant, strideLength } from './footsteps';
import { isClimbing } from '../game/stairwalk';
import { setAudioEngine, sfx } from './sfx';
import { soundForEvent } from './soundEvents';
import { rangeForLoudness } from './spatial';

// Wires the audio engine into the game: listener = player camera, footsteps, ambient beds,
// world `sound` events, and window.cdda helpers. Call once after the Game exists.

// Smashes and doors too: a one-shot whose sample isn't decoded within STALE_MS is dropped, so a
// cold first blow on a door during a busy frame (chunk streaming) could go silent.
// They're small (~0.5 MB for every smash_*, open_door and close_door file).
const PRELOAD = ['plmove', 'melee_swing', 'melee_hit_flesh', 'mon_bite', 'melee_attack', 'speech', 'mon_death', 'menu_move', 'menu_error', 'deal_damage',
  'smash', 'smash_fail', 'smash_success', 'open_door', 'close_door'];

export interface AudioHandle {
  engine: AudioEngine;
  ready: Promise<void>;
}

export function installAudio(game: Game, debugApi?: Record<string, any>): AudioHandle {
  const engine = new AudioEngine();
  engine.opaque = (x, y, z) => game.map.opaque(x, y, z);
  setAudioEngine(engine);
  engine.unlockOnGesture();

  const ready = engine.load().then(() => {
    void engine.preload(PRELOAD);
  });
  ready.catch((e) => console.error(`audio: failed to load soundset: ${e}`));

  game.events.on('sound', (e) => {
    const s = soundForEvent(e);
    if (!s) return;
    engine.play(s.id, s.variant, { pos: { x: e.x + 0.5, y: e.y + 0.5, z: e.z }, range: rangeForLoudness(e.volume), pitchJitter: 0.1 });
  });

  let lastX = game.player.x, lastY = game.player.y, lastZ = game.player.z;
  let strideAcc = 0;
  let idle = 0;
  let ambientTimer = 0;
  game.systems.push({
    name: 'audio',
    update(g, realDt) {
      const p = g.player;
      engine.updateListener({ x: p.x, y: p.y, z: p.z, yaw: p.yaw });
      const tx = Math.floor(p.x), ty = Math.floor(p.y);
      const season = g.clock.season;
      const underground = p.z < 0;
      const sheltered = underground || g.map.hasFloor(tx, ty, p.z + 1);
      const night = isNight(g.clock.hourOfDay, season);
      engine.env = { season, indoors: sheltered, night };

      // Footsteps: one per stride of distance actually travelled (collisions don't count).
      const moved = Math.hypot(p.x - lastX, p.y - lastY);
      // Carried by a vehicle (driving or riding along): the engine is the sound, not your feet.
      const riding = !!g.vehicles?.driving || !!g.vehicles?.at(tx, ty, p.z)?.v.velocity;
      // teleport / vehicle; on a flight each tread plays its own step (render/stairs/install.ts)
      if (p.z !== lastZ || moved > 2 || riding || isClimbing(p)) strideAcc = 0;
      else if (moved > 0) {
        strideAcc += moved;
        const stride = strideLength(p.running, p.crouching);
        if (strideAcc >= stride) {
          strideAcc -= stride;
          const ter = g.map.terAt(tx, ty, p.z);
          const variant = footstepVariant({ terrainId: ter.id, terrainFlags: ter.flags, hasVariant: (v) => engine.has('plmove', v) });
          sfx.footstep(variant, p.running ? 1 : p.crouching ? 0.35 : 0.7);
        }
        idle = 0;
      } else if ((idle += realDt) > 0.3) {
        // Standing still: the next step after starting to walk comes a bit sooner than a
        // full stride, like a real first step, instead of whatever was left over.
        strideAcc = Math.min(strideAcc, strideLength(p.running, p.crouching) * 0.6);
      }
      lastX = p.x; lastY = p.y; lastZ = p.z;

      ambientTimer -= realDt;
      if (ambientTimer <= 0 && engine.loaded) {
        ambientTimer = 0.5;
        engine.updateAmbient({ underground, sheltered, night, season, altitude: p.z });
      }
    },
  });

  if (debugApi) {
    debugApi.audio = engine;
    debugApi.sfx = sfx;
    /**
     * Headless verification: decode every file of the given ids (default: all real files)
     * and report durations, e.g. `await cdda.audioCheck(['plmove'])`.
     */
    debugApi.audioCheck = async (ids?: string[]) => {
      await ready;
      const files = ids
        ? [...new Set(ids.flatMap((id) => engine.soundset.variants(id).flatMap((v) => (engine.soundset.find(id, v) ?? []).map((f) => f.file))))]
        : engine.soundset.allFiles();
      const out: Record<string, { duration: number; expected?: number; channels: number } | { error: string }> = {};
      await Promise.all(
        files.map(async (f) => {
          try {
            const b = await engine.loadBuffer(f);
            out[f] = { duration: Math.round(b.duration * 1000) / 1000, expected: engine.fileInfo[f]?.duration, channels: b.numberOfChannels };
          } catch (e) {
            out[f] = { error: String(e) };
          }
        }),
      );
      return out;
    };
    /**
     * One-call headless verification used by `npm run shot -- --print "cdda.audioSelfTest()"`:
     * every file decodes with the duration the build tool measured, and the sfx helpers
     * resolve to real sounds. Returns { ok, ... } with details of any failure.
     */
    debugApi.audioSelfTest = async () => {
      const check = await debugApi.audioCheck();
      const entries = Object.entries(check) as [string, any][];
      const failures = entries
        .filter(([, v]) => v.error || (v.expected !== undefined && Math.abs(v.duration - v.expected) > 0.05) || !(v.duration > 0))
        .map(([f, v]) => ({ file: f, ...v }));
      const p = game.player;
      const at = { x: p.x + 3, y: p.y, z: p.z };
      const helpers: Record<string, string | null> = {};
      const probe = (name: string, v: { sound: { file: string } } | null) => (helpers[name] = v ? v.sound.file : null);
      probe('meleeHit', sfx.meleeHit('flesh', at, { skill: 'cutting', volumeMl: 500 }));
      probe('gunshot', sfx.gunshot('glock_19', at));
      probe('door', sfx.door('open', at, 't_door_c'));
      probe('smash', sfx.smash(at, { glass: true }));
      probe('monsterDeath', sfx.monsterDeath('mon_zombie', at));
      probe('zombieGroan', sfx.zombieGroan(at));
      probe('bulletHit', sfx.bulletHit('metal', at));
      probe('ui', sfx.ui('menu_error'));
      const missing = Object.entries(helpers).filter(([, f]) => !f).map(([k]) => k);
      return {
        ok: failures.length === 0 && missing.length === 0,
        decoded: entries.length,
        seconds: Math.round(entries.reduce((a, [, v]) => a + (v.duration || 0), 0)),
        failures: failures.slice(0, 10),
        missingHelpers: missing,
        helpers,
      };
    };
  }
  return { engine, ready };
}
