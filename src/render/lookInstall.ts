import { storeVisualPreference } from './visualPreference';
import { charSettings, charsApi } from './chars/index';
import { cardSettings } from './cards';
import type { DebugApi } from '../debug';
import type { Game } from '../game/game';
import type { WorldGenerator } from '../world/worldgen';
import { registerOption } from '../ui/options';
import { LOOK_NAMES, LOOKS, isLookName, look } from './look';
import type { Renderer } from './renderer';
import { frameStats, summarize } from '../perfDebug';
import { voxelStats } from './voxel';
import { installFurniture, installSurfaces } from './furniture/install';
import { installHeldIcons } from './heldIconInstall';
import { HAZE_NAMES, HAZES, haze, isHazeName, setHaze } from './atmosphere';
import { cutoutMipsOn, setCutoutMips } from './cutoutMips';
import { installNearCurtain } from './nearChunks';
import { FLORA_DESC, FLORA_NAMES, flora, floraAtlas, floraTiming, isFloraName, setFlora } from './flora';
import { FORM_NAMES, FORMS, form, isFormName, setForm } from './formLight';
import { installShadows } from './shadowInstall';
import { BEAM_MODES, beamSettings, setBeamMode } from './beamMode';

// Wires the visual styles (look.ts) into the game: the Options entry, the automation API
// and the per-look scene layers that need game/world access (skyline from the overmap).
//
//   cdda.setLook('crisp')            switch live (not persisted)
//   cdda.looks                       names
//   await cdda.benchView(5)          frame-time percentiles standing still (GPU perf)

export function installLooks(game: Game, renderer: Renderer, worldgen: WorldGenerator | null, api: DebugApi): void {
  installNearCurtain(game, renderer);
  registerOption({
    category: 'World',
    name: 'Cutout mips', value: () => cutoutMipsOn() ? 'on' : 'off',
    change: () => { setCutoutMips(!cutoutMipsOn()); storeVisualPreference('cutout', cutoutMipsOn() ? 'on' : 'off'); },
    desc: 'Stable grass and leaf sampling at distance; off restores unmipped pixel sampling.',
  });
  registerOption({
    category: 'World',
    name: 'Creature paint', value: () => charSettings.paint,
    change: () => { charsApi({ paint: charSettings.paint === 'styled' ? 'sprite' : 'styled' }); storeVisualPreference('charpaint', charSettings.paint); },
    desc: 'Styled skins or projected tileset paint for 3D creatures.',
  });
  registerOption({
    category: 'World',
    name: 'First-person bow', value: () => charSettings.fpBow ? 'model' : 'sprite',
    change: () => { charSettings.fpBow = !charSettings.fpBow; storeVisualPreference('fpbow', charSettings.fpBow ? 'model' : 'sprite'); },
    desc: 'Draw bows as pixel art or 3D models when first-person hands are 3D.',
  });
  registerOption({
    category: 'World',
    name: 'Props', value: () => cardSettings.mode,
    change: () => { cardSettings.mode = cardSettings.mode === 'cards' ? 'billboard' : 'cards'; storeVisualPreference('props', cardSettings.mode); renderer.chunks.invalidateAll(); },
    desc: 'World-fixed cards or camera-facing billboards for fire, distant furniture and loose items.',
  });
  registerOption({
    category: 'World',
    name: 'Headlight beams', value: () => beamSettings.mode,
    change: (d) => setBeamMode(BEAM_MODES[(BEAM_MODES.indexOf(beamSettings.mode) + d + BEAM_MODES.length) % BEAM_MODES.length]),
    desc: 'smooth: the beam\'s light on walls glides as you drive.  tile: the old tile-stepped beam light (walls popped lit and dark).  spot: only the headlight itself, no extra light-map glow.',
  });

  if (worldgen) {
    renderer.skyline.overmap = worldgen.overmap;
    // how tall each column is (src/world/levels.ts): what exists is derived from the world
    renderer.chunks.levels.overmap = worldgen.overmap;
  }
  registerOption({
    category: 'World',
    name: 'Visual style',
    value: () => LOOKS[look.name].label,
    change: (d) => {
      const i = LOOK_NAMES.indexOf(look.name);
      renderer.setLook(LOOK_NAMES[(i + d + LOOK_NAMES.length) % LOOK_NAMES.length], true);
    },
    desc: LOOK_NAMES.map((n) => `${LOOKS[n].label}: ${LOOKS[n].desc}`).join('\n'),
  });
  registerOption({
    category: 'World',
    name: 'Distance haze',
    value: () => HAZES[haze.name].label,
    change: (d) => {
      const i = HAZE_NAMES.indexOf(haze.name);
      setHaze(HAZE_NAMES[(i + d + HAZE_NAMES.length) % HAZE_NAMES.length], true);
    },
    desc: HAZE_NAMES.map((n) => `${HAZES[n].label}: ${HAZES[n].desc}`).join('\n'),
  });
  registerOption({
    category: 'World',
    name: 'Form lighting',
    value: () => FORMS[form.name].label,
    change: (d) => {
      const i = FORM_NAMES.indexOf(form.name);
      setForm(FORM_NAMES[(i + d + FORM_NAMES.length) % FORM_NAMES.length], true);
    },
    desc: FORM_NAMES.map((n) => `${FORMS[n].label}: ${FORMS[n].desc}`).join('\n'),
  });
  // Trees (flora.ts): modelled species with a middle LOD ring, or the v2 clump trees.
  // The middle ring rides on the look's lodRadius (applyLook runs every look layer).
  const floraLayer = () => {
    renderer.chunks.midRadius = look.f.trees3d && flora.name === 'models' ? 3.3 : 0;
  };
  renderer.lookLayers.push({ name: 'flora', apply: floraLayer });
  floraLayer();
  const switchFlora = (name: string, persist: boolean) => {
    if (!isFloraName(name)) throw new Error(`unknown flora ${name} (expected ${FLORA_NAMES.join('|')})`);
    setFlora(name, persist);
    floraLayer();
    renderer.chunks.invalidateAll();
    return name;
  };
  registerOption({
    category: 'World',
    name: 'Trees',
    value: () => flora.name,
    change: (d) => {
      const i = FLORA_NAMES.indexOf(flora.name);
      switchFlora(FLORA_NAMES[(i + d + FLORA_NAMES.length) % FLORA_NAMES.length], true);
    },
    desc: FLORA_NAMES.map((n) => `${n}: ${FLORA_DESC[n]}`).join('\n') + '\n(Needs the Voxel or Full visual style.)',
  });
  // Draw distance in chunks (OMTs). Past it the far ground ring and skyline carry the
  // horizon; 8 (168 m) is the user's chosen default (style gallery, 2026-09-30) at ~65% more
  // chunks than 6 (+0.5-1 ms render, +100 MB heap, more meshing while moving: docs/LOOKS.md);
  // 5 is for slow machines.
  const RADII = [5, 6, 8];
  const DEFAULT_RADIUS = 8;
  const RADIUS_KEY = 'cdda3d.drawRadius';
  if (!new URLSearchParams(location.search).get('radius')) {
    renderer.chunks.radius = DEFAULT_RADIUS;
    try {
      // Migrate the pre-wave-3 Options entry (cdda3d.options.radius, steps 4-10) once: nearest step here.
      let stored = localStorage.getItem(RADIUS_KEY);
      if (stored === null) {
        const legacy = Number((JSON.parse(localStorage.getItem('cdda3d.options') ?? '{}') as { radius?: number }).radius);
        if (legacy > 0) stored = String(RADII.reduce((a, b) => (Math.abs(b - legacy) < Math.abs(a - legacy) ? b : a)));
      }
      const r = Number(stored);
      if (RADII.includes(r)) renderer.chunks.radius = r;
    } catch {
      // storage blocked: default radius
    }
  }
  registerOption({
    category: 'World',
    name: 'Draw distance',
    value: () => `${Math.max(2, renderer.chunks.radius - 1) * 24} m`,
    change: (d) => {
      const i = Math.max(0, RADII.indexOf(renderer.chunks.radius));
      const r = RADII[(i + d + RADII.length) % RADII.length];
      renderer.chunks.radius = r;
      // World prefetch stays one ring ahead of what is drawn (main.ts sets it at boot).
      const prefetch = (api as unknown as { prefetch?: { opts: { radius: number } } }).prefetch;
      if (prefetch) prefetch.opts.radius = r + 1;
      try {
        localStorage.setItem(RADIUS_KEY, String(r));
      } catch {
        // private mode: not persisted
      }
    },
    desc: 'How far the world is built around you (beyond it the horizon is a cheap silhouette of the overmap). Farther costs memory and frame time while moving.',
  });
  const a = api as DebugApi & Record<string, unknown>;
  a.looks = LOOK_NAMES;
  a.hazes = HAZE_NAMES;
  /** Trees variant (flora.ts): 'models' | 'clumps', live, not persisted. */
  a.setFlora = (name: string) => switchFlora(name, false);
  a.floraStats = () => ({
    flora: flora.name, atlasUsed: +floraAtlas().used.toFixed(3), midRadius: renderer.chunks.midRadius,
    perTreeMs: floraTiming.n.map((n, i) => ({ lod: i, n, mean: +(floraTiming.ms[i] / Math.max(1, n)).toFixed(2), max: +floraTiming.max[i].toFixed(1), maxId: floraTiming.maxId[i] })),
  });
  /** Headlight beam casting (beamMode.ts): 'smooth' | 'tile' | 'spot', live, not persisted. */
  a.setBeam = (m: string) => {
    if (!(BEAM_MODES as readonly string[]).includes(m)) throw new Error(`unknown beam mode ${m} (expected ${BEAM_MODES.join('|')})`);
    beamSettings.mode = m as (typeof BEAM_MODES)[number];
  };
  /** A/B the stable cutout mips on grass/leaf cards (cutoutMips.ts). */
  a.cutoutMips = (on = true) => setCutoutMips(on);
  /** Form-lighting preset (formLight.ts), live, not persisted; formTweak edits single values. */
  a.setForm = (name: string) => {
    if (!isFormName(name)) throw new Error(`unknown form lighting ${name} (expected ${FORM_NAMES.join('|')})`);
    setForm(name);
    return name;
  };
  a.formTweak = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (!(k in form.s)) throw new Error(`unknown form setting ${k}`);
      (form.s as unknown as Record<string, unknown>)[k] = v;
    }
    return form.s;
  };
  /** Distance-haze preset (atmosphere.ts), live, not persisted. */
  a.setHaze = (name: string) => {
    if (!isHazeName(name)) throw new Error(`unknown haze ${name} (expected ${HAZE_NAMES.join('|')})`);
    setHaze(name);
    return name;
  };
  /** Override single values of the current haze preset, e.g. {hazeMax: 0.3}. */
  a.hazeTweak = (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) {
      if (!(k in haze.s)) throw new Error(`unknown haze setting ${k}`);
      (haze.s as unknown as Record<string, unknown>)[k] = v;
    }
    return haze.s;
  };
  a.voxelStats = voxelStats;
  installShadows(game, renderer, api);
  installFurniture(renderer, api);
  installHeldIcons(game, renderer, api);
  installSurfaces(renderer, api, game);
  a.setLook = (name: string) => {
    if (!isLookName(name)) throw new Error(`unknown look ${name}`);
    renderer.setLook(name);
    return name;
  };
  /** Override single features of the current look (not persisted), e.g. {ssao: 0}. */
  a.lookTweak = (o: Record<string, unknown>) => {
    const prevSoft = look.f.softShadows;
    for (const [k, v] of Object.entries(o)) {
      if (!(k in look.f)) throw new Error(`unknown look feature ${k}`);
      (look.f as unknown as Record<string, unknown>)[k] = v;
    }
    renderer.applyLook(prevSoft);
    return look.f;
  };
  /** Stand still for `seconds` and summarise frame intervals (real GPU: drive.ts --gpu). */
  a.benchView = async (seconds = 5) => {
    frameStats.reset();
    frameStats.recording = true;
    await new Promise((r) => setTimeout(r, seconds * 1000));
    frameStats.recording = false;
    // renderer-only cost, synchronised with the GPU (the frame interval also carries the sim)
    const bench = (a.benchRender as ((n: number) => { msPerFrame: number }) | undefined)?.(40);
    return { look: look.name, interval: summarize(frameStats.interval), work: summarize(frameStats.work), renderMs: bench?.msPerFrame, stats: renderer.stats() };
  };
}
