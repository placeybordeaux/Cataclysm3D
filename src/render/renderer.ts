import * as THREE from 'three';
import type { Game } from '../game/game';
import { LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas } from './atlas';
import { AtlasTextureSource, type WallStyle } from './atlasSource';
import { CameraRig, type CameraMode } from './camera';
import { ChunkManager } from './chunkManager';
import { INDOOR_SKY } from './chunkMesh';
import { LightManager, SkyState } from './lights';
import { patchNormalOutput, shared } from './materials';
import { PixelPipeline, type GradeMode } from './post';
import { ProceduralTextureSource } from './proceduralSource';
import { Sky } from './sky';
import { SpriteLayer, type SpriteHandle } from './sprites';
import type { TileTextureSource } from './textureSource';
import { Weather, type WeatherKind } from './weather';

export { CDDA_COLORS, cddaColor } from './colors';

// "Shadowglass" style renderer: a conventional 3D scene (merged chunk meshes, billboards,
// dynamic lights, shadow maps) rendered at ~360 px tall into an MRT target, then graded,
// dithered, outlined and integer-upscaled (see post.ts). Sub-systems:
//   chunks   ChunkManager    merged per-chunk geometry, budgeted rebuilds
//   sprites  SpriteLayer     billboards API for creatures/items/effects
//   lights   LightManager    sun/moon, ambient, point-light pool, flashlight
//   rig      CameraRig       first / third / top-down camera modes
//   pipeline PixelPipeline   low-res target + post + blit
//
// URL params: px=<target height> grade=palette|smooth|off tex=atlas|procedural
//             cam=first|third|top walls=tinted|sprite debug=1 (stats overlay)
// Keys: V camera mode, F flashlight; with debug=1 also F6 grade mode, F7 wall style.

export interface RendererOptions {
  targetHeight?: number;
  grade?: GradeMode;
  texture?: 'atlas' | 'procedural';
  camera?: CameraMode;
  debug?: boolean;
  wallStyle?: WallStyle;
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly sprites: SpriteLayer;
  readonly lights = new LightManager();
  readonly sky = new Sky();
  readonly skyState = new SkyState();
  readonly weather = new Weather();
  readonly rig = new CameraRig();
  readonly pipeline: PixelPipeline;
  readonly chunks: ChunkManager;
  readonly procedural: ProceduralTextureSource;
  source: TileTextureSource;
  /** Resolves once the preferred texture source (UltiCa atlas) is active. */
  readonly ready: Promise<void>;
  /** Per-frame hooks run at the start of render() (e.g. vehicle meshes following vehicles). */
  readonly beforeRender: ((dt: number) => void)[] = [];
  private playerSprite: SpriteHandle | null = null;
  private last = performance.now();
  private time = 0;
  private debugEl: HTMLDivElement | null = null;
  private fps = 0;
  private frames = 0;
  private fpsT = 0;

  constructor(private canvas: HTMLCanvasElement, private game: Game, opts: RendererOptions = {}) {
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    const o: RendererOptions = {
      targetHeight: Number(params.get('px')) || opts.targetHeight || 360,
      grade: (params.get('grade') as GradeMode) || opts.grade || 'palette',
      texture: (params.get('tex') as 'atlas' | 'procedural') || opts.texture || 'atlas',
      camera: (params.get('cam') as CameraMode) || opts.camera || 'first',
      debug: params.get('debug') === '1' || opts.debug,
      wallStyle: (params.get('walls') as WallStyle) || opts.wallStyle || 'tinted',
    };
    this.three = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.three.setPixelRatio(window.devicePixelRatio || 1);
    this.three.shadowMap.enabled = true;
    // Hard shadow edges: soft PCF blurs into mush at 360p and fights the banded lighting.
    this.three.shadowMap.type = THREE.BasicShadowMap;
    this.three.info.autoReset = false;
    this.three.autoClear = true;

    this.pipeline = new PixelPipeline(this.three, { targetHeight: o.targetHeight, grade: o.grade });
    this.rig.mode = o.camera!;
    this.procedural = new ProceduralTextureSource(game.data);
    this.source = this.procedural;
    this.sprites = new SpriteLayer(() => this.source);
    this.chunks = new ChunkManager(game.map, this.sprites, this.source);
    this.sprites.skyVisAt = (x, y, z) => (this.chunks.covered(Math.floor(x), Math.floor(y), Math.round(z)) ? INDOOR_SKY : 1);

    this.scene.add(this.sky.mesh, this.lights.group, this.chunks.group, this.sprites.group, this.weather.group);
    this.scene.matrixWorldAutoUpdate = true;

    this.ready = o.texture === 'atlas'
      ? loadAtlas().then(
        (atlas) => {
          const src = new AtlasTextureSource(atlas, game.data, this.procedural);
          src.wallStyle = o.wallStyle!;
          this.setTextureSource(src);
        },
        (e) => console.warn(`atlas unavailable, using procedural textures: ${e}`),
      )
      : Promise.resolve();

    game.keys.register('camera_mode', 'Cycle camera (first person / shoulder / top-down)', () => this.setCameraMode(this.rig.cycle()));
    // Placeholder until the flashlight item drives it (items/interaction own that).
    game.keys.register('flashlight', 'Toggle flashlight', () => this.toggleFlashlight());
    game.input.onPress((e) => {
      if (o.debug && e.code === 'F6') {
        const modes: GradeMode[] = ['palette', 'smooth', 'off'];
        this.pipeline.options.grade = modes[(modes.indexOf(this.pipeline.options.grade) + 1) % modes.length];
        game.message(`grade: ${this.pipeline.options.grade}`);
        return true;
      }
      if (o.debug && e.code === 'F7' && this.source instanceof AtlasTextureSource) {
        this.source.wallStyle = this.source.wallStyle === 'tinted' ? 'sprite' : 'tinted';
        this.chunks.invalidateAll();
        game.message(`walls: ${this.source.wallStyle}`);
        return true;
      }
      return false;
    });

    if (o.debug) {
      this.debugEl = document.createElement('div');
      this.debugEl.style.cssText = 'position:fixed;top:4px;right:4px;background:rgba(0,0,0,.75);color:#9f9;font:12px monospace;padding:4px 6px;white-space:pre;pointer-events:none;z-index:10';
      document.body.appendChild(this.debugEl);
    }
    this.setCameraMode(this.rig.mode);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** The active camera (its pose depends on the camera mode). */
  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  get cameraMode(): CameraMode {
    return this.rig.mode;
  }

  setCameraMode(mode: CameraMode): void {
    this.rig.mode = mode;
    const needPlayer = mode !== 'first';
    if (needPlayer && !this.playerSprite) {
      this.playerSprite = this.sprites.add({ x: 0, y: 0, z: 0, frame: this.source.sprite('player'), height: 1.75 });
    }
    this.playerSprite?.setVisible(needPlayer);
  }

  /** Swap where tile art comes from (procedural <-> atlas); rebuilds all chunks. */
  setTextureSource(src: TileTextureSource): void {
    this.source = src;
    this.chunks.source = src;
    this.chunks.invalidateAll();
    if (this.playerSprite) this.playerSprite.setFrame(src.sprite('player'), 1.75);
  }

  get flashlightOn(): boolean {
    return this.lights.flashlightOn;
  }
  /** Hook for the items system: tie this to having a lit flashlight. */
  setFlashlight(on: boolean): void {
    this.lights.flashlightOn = on;
  }
  toggleFlashlight(): void {
    this.setFlashlight(!this.lights.flashlightOn);
  }

  setWeather(kind: WeatherKind): void {
    this.weather.set(kind);
    this.sky.cloudiness = kind === 'clear' ? 0.2 : kind === 'snow' ? 0.7 : 0.9;
  }

  resize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.three.setSize(w, h, false);
    const buf = this.three.getDrawingBufferSize(new THREE.Vector2());
    this.pipeline.setSize(buf.x, buf.y);
  }

  /** Build every pending chunk now (tests/screenshots; normal play is budgeted). */
  flushChunks(): void {
    const p = this.game.player;
    this.chunks.update(p.x, p.y, p.z, (z) => this.zVisible(z), true);
  }

  private zVisible(z: number): boolean {
    // Top-down hides everything above the player's level, like CDDA.
    return this.rig.mode !== 'top' || z <= this.game.player.z;
  }

  render(): void {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    this.last = now;
    this.time += dt;
    this.three.info.reset();
    for (const f of this.beforeRender) f(dt);
    const p = this.game.player;
    const clock = this.game.clock;

    if (this.chunks.season !== clock.season) {
      this.chunks.season = clock.season;
      this.chunks.invalidateAll();
    }
    this.chunks.update(p.x, p.y, p.z, (z) => this.zVisible(z));
    this.source.flush?.();

    this.rig.update(dt, p, this.game.map, this.pipeline.aspect, this.pipeline.lowH);
    this.pipeline.subPixel.copy(this.rig.subPixel);
    const cam = this.rig.camera;

    // top-down: cut walls on the current level down to waist height
    const top = this.rig.mode === 'top';
    shared.uCutFloor.value = top ? p.z * LEVEL_HEIGHT : -1e6;
    shared.uCutTo.value = top ? p.z * LEVEL_HEIGHT + 1.1 : 1e6;
    shared.uSpriteTilt.value = top ? 0.55 : 0;
    shared.uTime.value = this.time;
    if (this.playerSprite) this.playerSprite.set(p.x, p.y, p.z);

    this.sprites.update(dt);
    this.skyState.update(clock.hourOfDay);
    if (this.chunks.lightsDirty) {
      this.lights.setChunkLights(this.chunks.lightLists());
      this.chunks.lightsDirty = false;
    }
    this.lights.update(dt, this.skyState, this.rig.focus, cam);
    this.sky.update(this.skyState, cam.position, this.time);
    this.weather.update(dt, cam.position);
    this.autoPatch();

    this.pipeline.render(this.scene, cam, this.skyState.fog);
    this.updateDebug(dt);
  }

  /** Other systems may add plain three.js objects to `scene`; give them the MRT output. */
  private autoPatch(): void {
    this.scene.traverseVisible((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      if (Array.isArray(m)) for (const x of m) patchNormalOutput(x);
      else patchNormalOutput(m);
    });
  }

  /** Numbers for the ?debug=1 overlay and for scripted checks. */
  stats(): Record<string, number | string> {
    const i = this.three.info;
    return {
      fps: Math.round(this.fps),
      calls: i.render.calls,
      triangles: i.render.triangles,
      lowres: `${this.pipeline.lowW}x${this.pipeline.lowH} x${this.pipeline.scale}`,
      chunks: this.chunks.stats.entries,
      pending: this.chunks.stats.pending,
      buildMs: +this.chunks.stats.lastBuildMs.toFixed(2),
      sprites: this.sprites.count,
      lights: this.lights.activeCount,
      mode: this.rig.mode,
      grade: this.pipeline.options.grade,
      textures: this.source === this.procedural ? 'procedural' : 'atlas',
      geometries: i.memory.geometries,
    };
  }

  private updateDebug(dt: number): void {
    this.frames++;
    this.fpsT += dt;
    if (this.fpsT >= 0.5) {
      this.fps = this.frames / this.fpsT;
      this.frames = 0;
      this.fpsT = 0;
      if (this.debugEl) {
        const s = this.stats();
        this.debugEl.textContent = Object.entries(s).map(([k, v]) => `${k.padEnd(10)} ${v}`).join('\n') +
          `\ntime       ${this.game.clock.format()}\nflashlight ${this.flashlightOn ? 'on' : 'off'}`;
      }
    }
  }
}
