import * as THREE from 'three';
import type { Game } from '../game/game';
import { CHUNK, LEVEL_HEIGHT } from '../world/coords';
import { loadAtlas } from './atlas';
import { AtlasTextureSource, type WallStyle } from './atlasSource';
import { CameraRig, type CameraMode } from './camera';
import { ChunkManager } from './chunkManager';
import { INDOOR_SKY } from './chunkMesh';
import { LightManager, SkyState } from './lights';
import { LightMap, naturalLightLevel } from './lightmap';
import { patchNormalOutput, shared } from './materials';
import { AA_MODES, PixelPipeline, type AAMode, type GradeMode } from './post';
import { ProceduralTextureSource } from './proceduralSource';
import { Sky } from './sky';
import { SpriteLayer, type SpriteHandle } from './sprites';
import type { TileFrame, TileTextureSource } from './textureSource';
import { Weather, type WeatherKind } from './weather';
import { Viewmodel } from './viewmodel';
import { DecorLayer } from './decor';
import { displayIrradiance } from './lightfield';
import { sunPosition, sunTimes, type SunTimes } from '../game/sun';
import { initialLook, look, setLookState, storeLook, type LookName } from './look';
import { GroundField } from './ground';
import { puddleUniforms } from './props';
import { Img, paintSurface, rampAround } from './pixelArt';
import { paintShingle, paintSolid, type ArchFrames } from './arch';
import { GrassLayer } from './grass';
import { buildTreesSteps, leafGlow, leafSun } from './trees';
import { SkylineLayer } from './skyline';
import { applyHaze, applyWeatherSky, haze } from './atmosphere';
import { applyForm } from './formLight';
import { VoxelFactory } from './voxel';
import { ModelFactory, furnitureState } from './furniture';
import { frameStats } from '../perfDebug';

export { CDDA_COLORS, cddaColor } from './colors';

// "Shadowglass" style renderer: a conventional 3D scene (merged chunk meshes, billboards,
// dynamic lights, shadow maps) rendered at ~360 px tall into an MRT target, then graded,
// dithered, outlined and integer-upscaled (see post.ts). Sub-systems:
//   chunks   ChunkManager    merged per-chunk geometry, budgeted rebuilds
//   sprites  SpriteLayer     billboards API for creatures/items/effects
//   lights   LightManager    sun/moon, ambient, flash point lights, flashlight
//   lightmap LightMap        CDDA-style shadowcast tile light (lamps, fire, windows)
//   rig      CameraRig       first / third / top-down camera modes
//   pipeline PixelPipeline   low-res target + post + blit
//
// URL params: px=<target height> grade=palette|smooth|off tex=atlas|procedural
//             cam=first|third|top walls=tinted|sprite debug=1 (stats overlay)
//             radius=<chunks drawn, default 4> dither=view|screen
// Keys: V camera mode, F flashlight; with debug=1 also F6 grade mode, F7 wall style.

export interface RendererOptions {
  targetHeight?: number;
  grade?: GradeMode;
  texture?: 'atlas' | 'procedural';
  camera?: CameraMode;
  debug?: boolean;
  wallStyle?: WallStyle;
  /** Chunks drawn around the player (default 4). */
  radius?: number;
  /** Dither anchoring, see PipelineOptions.ditherAnchor. */
  dither?: 'screen' | 'view';
  /** Antialiasing, see AAMode (post.ts). */
  aa?: AAMode;
}

export class Renderer {
  readonly three: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  /** Factory-owned static subtrees whose materials are patched when installed. */
  readonly staticMaterialRoots = new Set<THREE.Object3D>();
  readonly sprites: SpriteLayer;
  readonly lights = new LightManager();
  readonly sky = new Sky();
  readonly skyState = new SkyState();
  readonly weather = new Weather();
  readonly rig = new CameraRig();
  readonly pipeline: PixelPipeline;
  readonly chunks: ChunkManager;
  readonly lightmap: LightMap;
  /** Visual ground heights (look relief / curbs). */
  readonly ground: GroundField;
  /** Dense 3D grass cards (look `grass`). */
  readonly grass: GrassLayer;
  private readonly voxels = new VoxelFactory();
  readonly models = new ModelFactory();
  private readonly tmpV = new THREE.Vector3();
  /** Distant silhouettes from the overmap (look `skyline`); lookInstall gives it the overmap. */
  readonly skyline = new SkylineLayer();
  /** Grass tufts around the player (cosmetic ground clutter). */
  readonly decor: DecorLayer;
  /** First-person wielded-item view (typed nullable so other systems call it with `?.`). */
  readonly viewmodel: Viewmodel | null;
  readonly procedural: ProceduralTextureSource;
  source: TileTextureSource;
  /** Resolves once the preferred texture source (UltiCa atlas) is active. */
  readonly ready: Promise<void>;
  /** Hands are on something else (a steering wheel): hide the first-person viewmodel. */
  handsBusy = false;
  /** Per-frame hooks run at the start of render() (e.g. vehicle meshes following vehicles). */
  readonly beforeRender: ((dt: number) => void)[] = [];
  /**
   * Night vision strength (0 none .. ~2 for CDDA's +10 sight range): brightens the night
   * image via exposure. Set by src/mutbio.ts from mutations / active bionics.
   */
  nightVision = 0;
  /**
   * Debug tools (the style gallery, src/gallery): scales the render clock. 0 freezes every
   * render-time animation (poses, wind, rain, sway) so A/B captures of one scene match.
   */
  timeScale = 1;
  /** Debug tools: the drawing-buffer size in CSS px when the canvas isn't the whole window. */
  sizeOverride: (() => { w: number; h: number }) | null = null;
  /**
   * Extra sprite layers for the third-person survivor between the body and the clothes, like
   * CDDA's mutation overlays (`overlay_mutation_FUR`…). Returns base ids without the
   * `overlay_[gender_]` prefix handling: full ids tried in order are
   * overlay_<gender>_mutation_<id>, overlay_mutation_<id>.
   */
  playerMutationOverlays: (() => string[]) | null = null;
  private playerSprite: SpriteHandle | null = null;
  private last = performance.now();
  private time = 0;
  private debugEl: HTMLDivElement | null = null;
  private fps = 0;
  private frames = 0;
  private fpsT = 0;
  private trauma = 0;
  private playerLook = '';
  private snapExposure = true;
  /** Max sun shadow-map re-renders per second in the legacy shadow mode (the shadow pass is
   *  the priciest part of a frame in software GL; sun shadows are world-anchored, so a stale
   *  map stays correct except for moving casters, which then update at this rate). The other
   *  modes (shadows.ts) have a rate per cascade. */
  get shadowHz(): number {
    return this.lights.shadows.legacyHz;
  }
  set shadowHz(v: number) {
    this.lights.shadows.legacyHz = v;
  }
  private playerLookT = 0;
  private sunDay = NaN;
  private sunT: SunTimes = sunTimes(0);
  /** `?px=` pins the render resolution regardless of the look. */
  private pxParam = 0;
  /** 0 uses the display's native ratio; explicit values reduce HiDPI presentation cost. */
  pixelRatio = 0;
  /** `?grade=` pins the colour grading regardless of the look. */
  private gradeParam = false;
  /** Per-look scene layers (grass, skyline...) register here; setLook toggles them. */
  readonly lookLayers: { name: string; apply(): void }[] = [];
  /** Smoothed visual ground height under the camera (relief, curbs), metres. */
  private camGround = 0;
  /** Visual ground offset at a tile position (relief/curbs); 0 when the look has none. */
  groundAt: ((x: number, y: number, z: number) => number) | null = null;
  /** The vehicle renderer (vehicleMesh.ts) once installed: headlight tuning from cdda.renderer. */
  vehicleView: { headlightIntensity: number; headlight: THREE.SpotLight } | null = null;

  constructor(private canvas: HTMLCanvasElement, private game: Game, opts: RendererOptions = {}) {
    const params = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    this.pxParam = Number(params.get('px')) || opts.targetHeight || 0;
    this.gradeParam = !!params.get('grade') || !!opts.grade;
    const o: RendererOptions = {
      targetHeight: Number(params.get('px')) || opts.targetHeight || 360,
      grade: (params.get('grade') as GradeMode) || opts.grade || 'palette',
      texture: (params.get('tex') as 'atlas' | 'procedural') || opts.texture || 'atlas',
      camera: (params.get('cam') as CameraMode) || opts.camera || 'first',
      debug: params.get('debug') === '1' || opts.debug,
      wallStyle: (params.get('walls') as WallStyle) || opts.wallStyle || 'tinted',
      radius: Number(params.get('radius')) || opts.radius,
      dither: (params.get('dither') as 'screen' | 'view') || opts.dither,
      aa: (params.get('aa') as AAMode) || opts.aa || 'off',
    };
    if (!AA_MODES.includes(o.aa!)) throw new Error(`?aa= must be one of ${AA_MODES.join('|')}, got ${o.aa}`);
    this.three = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    const ratio = Number(params.get('pixelRatio'));
    this.pixelRatio = Number.isFinite(ratio) && ratio >= 0.5 && ratio <= 2 ? ratio : 0;
    this.three.setPixelRatio(this.pixelRatio || window.devicePixelRatio || 1);
    this.three.shadowMap.enabled = true;
    // Hard shadow edges: soft PCF blurs into mush at 360p and fights the banded lighting.
    this.three.shadowMap.type = THREE.BasicShadowMap;
    this.three.shadowMap.autoUpdate = false;
    this.three.info.autoReset = false;
    this.three.autoClear = true;
    // The scene root stays at identity. Rebuilding it marks every descendant dirty,
    // defeating frozen local transforms on static chunks during every render pass.
    this.scene.matrixAutoUpdate = false;

    this.pipeline = new PixelPipeline(this.three, { targetHeight: o.targetHeight, grade: o.grade, aa: o.aa, ...(o.dither ? { ditherAnchor: o.dither } : {}) });
    this.rig.mode = o.camera!;
    this.procedural = new ProceduralTextureSource(game.data);
    this.models.itemDefs = game.data.items;
    this.source = this.procedural;
    this.sprites = new SpriteLayer(() => this.source);
    this.chunks = new ChunkManager(game.map, this.sprites, this.source);
    this.staticMaterialRoots.add(this.chunks.group);
    if (o.radius) this.chunks.radius = o.radius;
    this.lightmap = new LightMap(game.map);
    this.ground = new GroundField(game.map);
    const noTrees = function* (): Generator<void, THREE.Object3D[]> { return []; };
    this.chunks.extraObjects = (data) => (data.trees ? buildTreesSteps(data.trees, this.ground.active ? this.ground : null, this.procedural, this.whiteFrame()) : noTrees());
    this.chunks.extras = (near) => {
      if (look.name === 'classic') return undefined;
      return { f: look.f, ground: this.ground.active ? this.ground : null, white: this.whiteFrame(), near, voxels: this.voxels, arch: look.f.archDetail ? this.archFrames() : undefined, models: furnitureState.style === 'model' ? this.models : undefined, heldItems: this.models };
    };
    this.sprites.skyVisAt = (x, y, z) => (this.chunks.covered(Math.floor(x), Math.floor(y), Math.round(z)) ? INDOOR_SKY : 1);
    this.decor = new DecorLayer(() => this.source);
    this.decor.sprites.skyVisAt = this.sprites.skyVisAt;
    this.grass = new GrassLayer(this.ground);
    // tufts and grass cards wait for the chunk they grow on (src/render/surroundings.ts)
    this.decor.ready = this.grass.ready = (cx, cy, z) => this.chunks.chunkShown(cx, cy, z);

    this.viewmodel = new Viewmodel();
    game.events.on('playerHurt', (e) => {
      // A hit your armor stopped is a jolt, not a wound: no red flash (with a horde clawing
      // at good armor the screen otherwise stayed red the whole fight).
      if (e.amount <= 0) return this.shake(0.15);
      const k = Math.min(1, e.amount / 20);
      this.shake(0.25 + k * 0.6);
      this.hurtFlash(0.35 + k * 0.65);
    });
    game.events.on('playerFell', (e) => {
      // The landing's own jolt/damage already fires `playerHurt` (zlevels.ts impact()) for the
      // shake + red flash; this only adds the eased eye drop so the level change itself doesn't
      // read as a snap.
      this.rig.fall(e.levels);
    });

    this.scene.add(this.sky.mesh, this.lights.group, this.chunks.group, this.sprites.group, this.decor.sprites.group, this.weather.group, this.grass.group, this.skyline.group);
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

    game.keys.register('camera_mode', 'Cycle camera (first person / shoulder / top-down; driving: chase / cockpit / top-down)', () => this.setCameraMode(this.rig.cycle()));
    // Mouse wheel zooms the top-down view (CDDA's zoom), from a room to a few blocks of town.
    canvas.addEventListener?.(
      'wheel',
      (e) => {
        if (this.rig.mode !== 'top') return;
        e.preventDefault();
        this.rig.topDistance = Math.max(10, Math.min(60, this.rig.topDistance * (e.deltaY > 0 ? 1.15 : 1 / 1.15)));
      },
      { passive: false },
    );
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
    this.setLook(initialLook());
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /** A white texel on the procedural page for vertex-coloured geometry. */
  whiteFrame(): TileFrame {
    return this.procedural.custom('white', () => {
      const im = new Img(4, 4);
      im.fill([255, 255, 255]);
      return im;
    });
  }

  private archFrames(): ArchFrames {
    const P = this.procedural;
    return {
      white: this.whiteFrame(),
      trim: P.custom('arch:trim', () => paintSolid([196, 188, 170])),
      plinth: P.custom('arch:plinth', () => paintSurface('blocks', 'light_gray', 5, rampAround([92, 90, 84], 0.5))),
      shingle: P.custom('arch:shingle', () => paintShingle([86, 72, 66])),
    };
  }

  get lookName(): LookName {
    return look.name;
  }

  /**
   * Switch the visual style live (look.ts). Image features are uniforms/options; geometry
   * features rebuild every chunk (spread over frames by the chunk budget). `persist`
   * stores the choice for the next session (Options does; `?look=` doesn't).
   */
  setLook(name: LookName, persist = false): void {
    const prevSoft = look.f.softShadows;
    const first = look.version === 0;
    setLookState(name);
    this.applyLook(prevSoft, first);
    if (persist) storeLook(name);
  }

  /** Push look.f into the pipeline/materials/layers (also after cdda.lookTweak edits it). */
  applyLook(prevSoft = look.f.softShadows, first = false): void {
    const f = look.f;
    const po = this.pipeline.options;
    if (!this.pxParam) po.targetHeight = f.autoRes ? 0 : 360;
    po.dither = f.dither;
    if (!this.gradeParam) po.grade = f.grade;
    po.ssao = f.ssao;
    po.bloom = f.bloom;
    po.atmosphere = f.atmosphere;
    shared.uRim.value = f.rim;
    shared.uBump.value = f.bump;
    shared.uSpriteRound.value = f.spriteRound;
    this.lights.fillK = f.fill;
    this.lights.setShadow(f.shadowSize, f.shadowExtent);
    const prevType = this.three.shadowMap.type;
    this.three.shadowMap.type = this.lights.shadows.pcf(f.softShadows) ? THREE.PCFShadowMap : THREE.BasicShadowMap;
    if (!first && (prevSoft !== f.softShadows || prevType !== this.three.shadowMap.type)) {
      // the shadow sampling code is baked into programs: recompile everything once
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(m)) m.forEach((x) => (x.needsUpdate = true));
        else if (m) m.needsUpdate = true;
      });
    }
    this.decor.enabled = !f.grass;
    this.grass.enabled = f.grass;
    // volumetric trees/props only for the chunks around the player (billboards beyond)
    this.chunks.lodRadius = f.trees3d || f.voxelProps ? 1.8 : 0;
    // roofs of two-storey buildings live two levels up
    this.chunks.levelsAbove = f.archDetail ? 2 : 1;
    this.grass.invalidate();
    this.skyline.enabled = f.skyline;
    this.skyline.invalidate();
    this.ground.relief = f.relief;
    this.ground.curbs = f.archDetail;
    this.ground.reset();
    const ga = this.ground.active ? (x: number, y: number, z: number) => this.ground.heightAt(x, y, z) : null;
    this.groundAt = ga;
    this.sprites.groundAt = ga;
    this.decor.sprites.groundAt = ga;
    for (const l of this.lookLayers) l.apply();
    this.chunks.invalidateAll();
    this.decor.invalidate();
    this.snapExposure = true;
    this.lights.shadows.invalidate();
    if (!first) this.resize();
  }

  /** The active camera (its pose depends on the camera mode). */
  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  get cameraMode(): CameraMode {
    return this.rig.mode;
  }

  /** Top-down cuts the player's level to waist height (interiors visible, as in CDDA). Off shows whole buildings with roofs (screenshot recreations). */
  topCutaway = true;

  setCameraMode(mode: CameraMode): void {
    this.rig.mode = mode;
    this.syncPlayerSprite();
  }

  /** The player billboard shows outside first person, except at the wheel (you're inside the
   *  car). Checked every frame: taking/leaving the controls switches the camera mode too. */
  private spriteShown: boolean | null = null;
  /** A 3D first-person view (render/chars/fpView.ts) drawn instead of the sprite viewmodel; null = sprites. */
  viewmodelOverlay: ((dt: number) => { scene: THREE.Scene; camera: THREE.Camera } | null) | null = null;
  /** Another system draws the player's body (render/chars 3D model): keep the billboard hidden. */
  playerBodyOverride = false;
  private syncPlayerSprite(): void {
    const needPlayer = this.rig.mode !== 'first' && !this.rig.drive && !this.playerBodyOverride;
    if (needPlayer === this.spriteShown) return;
    this.spriteShown = needPlayer;
    if (needPlayer && !this.playerSprite) {
      this.playerSprite = this.sprites.add({ x: 0, y: 0, z: 0, frame: this.source.sprite('player'), height: 1.75 });
    }
    this.playerSprite?.setVisible(needPlayer);
  }

  /** Camera shake, 0..1 (accumulates; decays in ~0.5 s). */
  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + Math.max(0, amount));
  }

  /** Red vignette flash in the post pass, 0..1 (decays in ~0.6 s). */
  hurtFlash(amount: number): void {
    this.pipeline.hurt = Math.min(1, this.pipeline.hurt + Math.max(0, amount));
  }

  /** Swap where tile art comes from (procedural <-> atlas); rebuilds all chunks. */
  setTextureSource(src: TileTextureSource): void {
    this.source = src;
    this.chunks.source = src;
    this.chunks.invalidateAll();
    this.decor.invalidate();
    this.playerLook = '';
    if (this.playerSprite) this.playerSprite.setFrame(src.sprite('player'), 1.75);
  }

  /** Menus drawn over the live world (title screen) hide the hands. */
  hideViewmodel = false;

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
    const o = this.sizeOverride?.();
    const w = o?.w ?? window.innerWidth, h = o?.h ?? window.innerHeight;
    this.three.setPixelRatio(this.pixelRatio || window.devicePixelRatio || 1);
    this.three.setSize(w, h, false);
    const buf = this.three.getDrawingBufferSize(new THREE.Vector2());
    this.pipeline.setSize(buf.x, buf.y);
  }

  /**
   * CDDA-style light level at a tile in CDDA luminance units (daylight ~100, lit room >= 10,
   * LIGHT_AMBIENT_LOW = 3.5 is "too dark to see"). Accurate (shadowcast) on the player's
   * level within 64 tiles; elsewhere an outdoors/indoors estimate. For vision and stealth.
   */
  lightAt(x: number, y: number, z: number): number {
    return this.lightmap.lightAt(x, y, z);
  }

  /** Light map value where it is exact (player's level, inside the 128-tile window), else null. */
  exactLightAt(x: number, y: number, z: number): number | null {
    return this.lightmap.exactLightAt(x, y, z);
  }

  /** Build every pending chunk now (tests/screenshots; normal play is budgeted). */
  flushChunks(): void {
    const p = this.game.player;
    this.chunks.update(p.x, p.y, p.z, (z) => this.zVisible(z), true);
    this.lightmap.invalidate();
    this.snapExposure = true;
    this.lights.shadows.invalidate();
  }

  private zVisible(z: number): boolean {
    // Top-down hides everything above the player's level, like CDDA (unless the cutaway is off).
    return this.rig.mode !== 'top' || !this.topCutaway || z <= this.game.player.z;
  }

  /** Draw a frame. `fixedDt` (s) overrides the wall-clock step (frame-by-frame recordings). */
  render(fixedDt?: number): void {
    const now = performance.now();
    const dt = (fixedDt ?? Math.min((now - this.last) / 1000, 0.1)) * this.timeScale;
    this.last = now;
    this.time += dt;
    this.three.info.reset();
    frameStats.lap('pre');
    for (const f of this.beforeRender) f(dt);
    frameStats.lap('beforeRender');
    const p = this.game.player;
    const clock = this.game.clock;

    if (this.chunks.season !== clock.season) {
      this.chunks.season = clock.season;
      this.chunks.invalidateAll();
    }
    // build priority follows the view (last frame's camera: the rig updates below)
    const fwd = this.rig.camera.getWorldDirection(this.tmpV);
    const fl = Math.hypot(fwd.x, fwd.z);
    if (fl > 0.1) { this.chunks.forward.x = fwd.x / fl; this.chunks.forward.y = fwd.z / fl; }
    // what's "in view" for build order (ultrawide: ~62 degrees each side)
    this.chunks.viewHalf = Math.atan(Math.tan((this.rig.camera.fov * Math.PI) / 360) * this.rig.camera.aspect);
    this.chunks.update(p.x, p.y, p.z, (z) => this.zVisible(z));
    frameStats.lap('chunks');
    this.source.flush?.();
    frameStats.lap('texFlush');

    this.rig.update(dt, p, this.game.map, this.pipeline.aspect, this.pipeline.lowH);
    this.syncPlayerSprite();
    this.pipeline.subPixel.copy(this.rig.subPixel);
    const cam = this.rig.camera;
    // Visual ground (relief, raised sidewalks): the eye rides it. Gameplay stays on the
    // flat tile grid; this is presentation only, smoothed so curbs don't jolt the view.
    const g = this.groundAt && this.rig.mode !== 'top' ? this.groundAt(p.x, p.y, p.z) : 0;
    this.camGround += (g - this.camGround) * Math.min(1, dt * 10);
    if (Math.abs(this.camGround) > 1e-4 && this.rig.mode !== 'top') {
      cam.position.y += this.camGround;
      cam.updateMatrixWorld();
    }
    this.applyShake(dt, cam);
    this.pipeline.hurt = Math.max(0, this.pipeline.hurt - dt * 1.7);

    // top-down: cut walls on the current level down to waist height
    const top = this.rig.mode === 'top';
    const cut = top && this.topCutaway;
    shared.uCutFloor.value = cut ? p.z * LEVEL_HEIGHT : -1e6;
    shared.uCutTo.value = cut ? p.z * LEVEL_HEIGHT + 1.1 : 1e6;
    shared.uSpriteTilt.value = top ? 0.55 : 0;
    shared.uTime.value = this.time;
    shared.uPlayerLevel.value = p.z;
    if (this.playerSprite) {
      this.playerSprite.set(p.x, p.y, p.z);
      this.updatePlayerLook(dt);
    }

    frameStats.lap('misc');
    this.sprites.update(dt);
    frameStats.lap('sprites');
    this.decor.update(this.game.map, p.x, p.y, p.z, clock.season, this.source);
    frameStats.lap('decor');
    this.grass.update(this.game.map, p.x, p.y, p.z, clock.season, this.source);
    frameStats.lap('grass');
    this.skyline.ground = haze.s.mode === 1;
    this.skyline.season = clock.season;
    this.skyline.update(p.x, p.y, p.z, this.chunks.radius);
    frameStats.lap('skyline');
    if (this.sunDay !== clock.day) {
      this.sunDay = clock.day;
      this.sunT = sunTimes(clock.day);
    }
    const sunPos = sunPosition(clock.seconds);
    this.skyState.update(clock.hourOfDay, { sunrise: this.sunT.sunrise, sunset: this.sunT.sunset, altitude: sunPos.altitude, azimuth: sunPos.azimuth, season: clock.season });
    this.sky.overcast = applyWeatherSky(this.skyState, this.game.weather, dt, this.snapExposure);
    this.lightmap.naturalLevel = naturalLightLevel(Math.asin(this.skyState.sunDir.y));
    this.lightmap.update(p.x, p.y, p.z, dt, this.time, this.lights.handles(), this.lights.handlesDirty);
    this.lights.handlesDirty = false;
    frameStats.lap('lightmap');
    this.lights.setStaticLights(this.lightmap.statics);
    this.adaptExposure(dt);
    applyForm(); // formLight.ts: bands and billboard curvature (lights.update reads the rest)
    this.lights.beam = this.rig.drive ? null : this.rig.beam;
    this.lights.shadowMapType = this.three.shadowMap.type; // the flashlight's idle map must match it
    this.lights.update(dt, this.skyState, this.rig.focus, cam);
    shared.uRimColor.value.copy(this.skyState.hemiSky).multiplyScalar(this.skyState.hemiIntensity * 0.35);
    shared.uBounce.value.copy(this.skyState.hemiGround).lerp(this.skyState.hemiSky, 0.4).multiplyScalar(this.skyState.hemiIntensity * 0.9 * look.f.bounce * (1 - this.skyState.night));
    this.pipeline.haze.copy(this.skyState.fog);
    this.pipeline.setSky(this.skyState);
    puddleUniforms.uZenith.value.copy(this.skyState.zenith);
    puddleUniforms.uHorizon.value.copy(this.skyState.horizon);
    puddleUniforms.uSunDir.value.copy(this.skyState.sunDir);
    puddleUniforms.uSunColor.value.copy(this.skyState.sunColor);
    puddleUniforms.uNight.value = this.skyState.night;
    leafGlow.value = 0.075 * this.skyState.hemiIntensity * (1 - 0.85 * this.skyState.night);
    leafSun.dir.value.copy(this.skyState.sunDir);
    leafSun.color.value.copy(this.skyState.sunColor).multiplyScalar(this.skyState.sunIntensity * Math.max(0, Math.min(1, this.skyState.sunDir.y * 4)) * (1 - this.skyState.night));
    const su = this.skyline.uniforms;
    su.uSunDir.value.copy(this.skyState.moonLit ? this.skyState.moonDir : this.skyState.sunDir);
    su.uDay.value = 1 - this.skyState.night;
    su.uSkyTint.value.copy(this.skyState.hemiSky).multiplyScalar(this.skyState.hemiIntensity * 0.6);
    // the flashlight's shadow moves with the camera, so it can't be rate limited; the sun
    // maps say themselves when they're due (shadows.ts)
    if (this.lights.shadowDue || this.lights.flashlightOn || this.vehicleView?.headlight.intensity || this.vehicleView?.headlight.shadow.needsUpdate) this.three.shadowMap.needsUpdate = true;
    this.sky.update(this.skyState, cam.position, this.time);
    this.weather.update(dt, cam.position);
    this.autoPatch();
    frameStats.lap('scene');

    const vm = this.viewmodel!;
    vm.enabled = this.rig.mode === 'first' && !this.handsBusy && !this.hideViewmodel;
    // Gunfire lights the scene through MonsterView's muzzle handle (every camera mode);
    // viewmodel.onMuzzleFlash stays free for effects tied to the first-person gun.
    let overlay: { scene: THREE.Scene; camera: THREE.Camera } | undefined;
    if (vm.enabled) {
      this.viewmodelTint(vm.tint);
      vm.update(dt, p.inv.wielded, p.x, p.y, p.yaw, this.pipeline.lowW, this.pipeline.lowH, (id) => this.source.item(id));
      overlay = this.viewmodelOverlay?.(dt) ?? vm;
    }
    // Fog of war tied to the draw distance: fully opaque before the nearest not-yet-loaded
    // chunk can be (the load circle is (radius + 0.5) chunks around the player's chunk, and
    // the player may stand anywhere in theirs), so new chunks and trees always appear inside
    // solid fog and fade in as you approach instead of popping into view.
    const po = this.pipeline.options;
    // looking down from above everything is 30-60 m away: aerial perspective would wash out
    po.atmosphere = look.f.atmosphere * (this.rig.mode === 'top' ? 0.25 : 1);
    po.fogFar = Math.max(2, this.chunks.radius - 1) * CHUNK;
    applyHaze(po); // atmosphere.ts: where the fade starts, haze strength, sky-matched or grey
    this.chunks.visibleDist = po.fogNear + (po.fogFar - po.fogNear) * 0.5;
    frameStats.lap('vm');
    this.pipeline.render(this.scene, cam, this.skyState.fog, overlay);
    frameStats.lap('draw');
    this.updateDebug(dt);
  }

  /**
   * Eye adaptation, daytime only: a room lit through its windows reads clearly while the
   * windows themselves blow out; outdoors stays at 1. At night nothing is boosted, so the
   * dark stays dark (CDDA) and lamps/fire carry the scene.
   */
  private adaptExposure(dt: number): void {
    const p = this.game.player;
    const lum = this.lightmap.lightAt(p.x, p.y, p.z);
    const day = 1 - this.skyState.night;
    // relative to the light outdoors right now: only the indoor/outdoor difference adapts
    const ratio = Math.max(this.lightmap.naturalLevel, 1) / Math.max(lum, 1);
    // top-down mostly shows the outdoors around the player's building: adapt only a little
    const k = day * (this.rig.mode === 'top' ? 0.3 : 1);
    const target = (1 + (Math.min(2.2, Math.max(1, Math.sqrt(ratio))) - 1) * k) * (1 + this.nightVision * this.skyState.night);
    const pl = this.pipeline;
    pl.exposure = this.snapExposure ? target : pl.exposure + (target - pl.exposure) * Math.min(1, dt * 1.5);
    pl.nightVision = Math.min(1, this.nightVision * this.skyState.night);
    this.snapExposure = false;
  }

  /** Trauma-style shake: smooth pseudo-noise rotation offsets scaled by trauma squared. */
  private applyShake(dt: number, cam: THREE.PerspectiveCamera): void {
    if (this.trauma <= 0) return;
    const k = this.trauma * this.trauma;
    const t = this.time * 38;
    const n = (a: number) => Math.sin(t + a) * 0.6 + Math.sin(t * 1.93 + a * 3.1) * 0.4;
    cam.rotation.x += k * 0.045 * n(0);
    cam.rotation.y += k * 0.045 * n(11);
    cam.rotation.z += k * 0.03 * n(23);
    cam.position.y += k * 0.04 * n(37);
    cam.updateMatrixWorld();
    this.trauma = Math.max(0, this.trauma - dt * 2);
  }

  /** Light on the first-person hands: the light map at the player (sky share + lamps). */
  private viewmodelTint(out: THREE.Color): void {
    const p = this.game.player;
    const f = this.lightmap.field;
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const onLevel = p.z === this.lightmap.z;
    let nat = onLevel ? f.naturalAt(tx, ty) : -1;
    if (nat < 0) nat = this.chunks.covered(tx, ty, p.z) ? f.indoorAmbient : 1;
    const sky = this.skyState;
    const i = onLevel ? f.index(tx, ty) : -1;
    const art = i >= 0 ? [f.disp[i * 3], f.disp[i * 3 + 1], f.disp[i * 3 + 2]] : [0, 0, 0];
    const m = Math.max(...art);
    const ak = m > 0 ? displayIrradiance(m, 3.2) / m : 0;
    const gate = Math.min(1, Math.max(0, (nat - 0.02) / 0.18));
    const fl = this.lights.flashlightOn ? 0.5 : 0;
    const ch = (c: 'r' | 'g' | 'b', a: number) =>
      ((sky.hemiSky[c] * 0.6 + sky.hemiGround[c] * 0.4) * sky.hemiIntensity * nat + sky.sunColor[c] * sky.sunIntensity * 0.35 * gate + a * ak + fl) / Math.PI;
    out.setRGB(Math.min(1.2, ch('r', art[0])), Math.min(1.2, ch('g', art[1])), Math.min(1.2, ch('b', art[2])));
  }

  /** Third-person/top-down sprite: CDDA body + worn-item overlays, rebuilt when gear changes. */
  private updatePlayerLook(dt: number): void {
    this.playerLookT -= dt;
    if (this.playerLookT > 0) return;
    this.playerLookT = 0.25;
    const inv = this.game.player.inv;
    const muts = this.playerMutationOverlays?.() ?? [];
    const look = [...inv.worn.map((w) => w.typeId), '|', inv.wielded?.typeId ?? '', '|', ...muts].join(',');
    if (look === this.playerLook) return;
    this.playerLook = look;
    const src = this.source;
    if (!(src instanceof AtlasTextureSource)) return;
    // Until character creation hands out clothes the survivor wears nothing; show the
    // default outfit rather than a naked sprite in that case.
    const worn = inv.worn.length ? inv.worn.map((w) => w.typeId) : ['jeans', 'tshirt', 'sneakers', 'jacket_flannel'];
    src.playerLayers = src.layersFor(worn, inv.wielded?.typeId ?? null, this.game.player.male ? 'male' : 'female', muts);
    this.playerSprite!.setFrame(src.sprite('player'), 1.75);
  }

  /** Other systems may add plain three.js objects to `scene`; give them the MRT output. */
  private autoPatch(): void {
    this.patchDynamicMaterials(this.scene);
  }

  private patchDynamicMaterials(o: THREE.Object3D): void {
    if (!o.visible || this.staticMaterialRoots.has(o)) return;
    const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) for (const x of m) patchNormalOutput(x);
    else if (m) patchNormalOutput(m);
    for (const child of o.children) this.patchDynamicMaterials(child);
  }

  /** Numbers for the ?debug=1 overlay and for scripted checks. */
  stats(): Record<string, number | string> {
    const i = this.three.info;
    return {
      fps: Math.round(this.fps),
      calls: i.render.calls,
      triangles: i.render.triangles,
      lowres: `${this.pipeline.lowW}x${this.pipeline.lowH} x${this.pipeline.scale}`,
      look: look.name,
      chunks: this.chunks.stats.entries,
      pending: this.chunks.stats.pending,
      buildMs: +this.chunks.stats.lastBuildMs.toFixed(2),
      sprites: this.sprites.count,
      decor: this.decor.count,
      grass: this.grass.count,
      lights: this.lights.activeCount,
      exposure: +this.pipeline.exposure.toFixed(2),
      lmSources: this.lightmap.stats.sources,
      lmMs: `${this.lightmap.stats.naturalMs.toFixed(1)}/${this.lightmap.stats.artificialMs.toFixed(1)}`,
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
