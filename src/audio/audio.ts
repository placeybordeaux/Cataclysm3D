import { Soundset, type ResolvedSound, type SoundContext } from './soundset';
import type { SoundsetFile } from './soundsetTypes';
import { countOccluders, distanceGain, effectGain, listenerSpace, muffle, type Listener, type Vec3 } from './spatial';
import { ambientLayers, WEATHER_TYPES, type AmbientChannel, type AmbientState, type WeatherInfo } from './ambience';
import { registerSynth, renderSynth, SYNTH_PREFIX } from './procedural';
import { warnOnce } from '../data/warn';
import { ASSET_BASE } from '../core/assets';

// WebAudio engine. Graph:
//   voice: source -> lowpass -> gain -> [panner] -> bus(sfx|ui|ambient) -> master -> out
//   music: <audio> element -> music bus -> master
// Everything the game hears goes through play() (one-shots, loops) or the ambient/music
// managers below. Sample decoding is lazy: the first play() of a file fetches it, later ones
// are instant. Music streams through a media element so 3-minute tracks aren't decoded
// into ~70 MB PCM buffers.

export type Bus = 'sfx' | 'ui' | 'ambient';

export interface AudioSettings {
  /** 0..1 */
  master: number;
  sfx: number;
  music: number;
  ambient: number;
  ui: number;
  muted: boolean;
  musicEnabled: boolean;
  /** HRTF panning (nicer, costlier) vs equal-power stereo */
  hrtf: boolean;
  /** muffle sounds behind walls / on other z-levels */
  occlusion: boolean;
}

export const DEFAULT_SETTINGS: AudioSettings = {
  master: 0.8,
  sfx: 1,
  music: 0.35,
  ambient: 0.6,
  ui: 0.6,
  muted: false,
  musicEnabled: true,
  hrtf: true,
  occlusion: true,
};

export interface PlayOptions {
  /** world tile position; omit for sounds at the listener (UI, own footsteps) */
  pos?: Vec3;
  /** multiplier on the entry's CDDA volume (1 = as authored) */
  volume?: number;
  /** random playback-rate spread, e.g. 0.1 => 0.9..1.1 (CDDA uses 0.8..1.2 for many sfx) */
  pitchJitter?: number;
  /** tiles until silent (default 24, CDDA's hearing falloff) */
  range?: number;
  /** floor on distance gain, e.g. CDDA keeps gunshots at >= 30% */
  minGain?: number;
  bus?: Bus;
  loop?: boolean;
  /** seconds to wait before starting */
  delay?: number;
  /** override season/indoors/night used for variant lookup */
  ctx?: SoundContext;
  /** fade-in seconds (loops) */
  fadeIn?: number;
}

export interface Voice {
  readonly sound: ResolvedSound;
  readonly pos?: Vec3;
  setPosition(pos: Vec3): void;
  /** Playback rate (pitch), glided over `glideSec` (engine revs). */
  setRate(rate: number, glideSec?: number): void;
  stop(fadeSec?: number): void;
  readonly ended: boolean;
}

const STORAGE_KEY = 'cdda3d.audio.settings';
const MAX_VOICES = 48;
/** Drop a one-shot whose sample took longer than this to arrive: it'd be out of sync. */
const STALE_MS = 400;

function loadStoredSettings(): Partial<AudioSettings> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    return {};
  }
}

class VoiceImpl implements Voice {
  ended = false;
  /** stop() is ramping the gain down; spatialize() must not ramp it back up */
  fading = false;
  pos?: Vec3;
  occl = 0;
  constructor(
    private engine: AudioEngine,
    readonly sound: ResolvedSound,
    readonly source: AudioBufferSourceNode,
    readonly filter: BiquadFilterNode,
    readonly gain: GainNode,
    readonly panner: PannerNode | null,
    readonly baseGain: number,
    readonly range: number,
    readonly minGain: number,
  ) {}
  setPosition(pos: Vec3): void {
    this.pos = pos;
    this.engine.spatialize(this, false);
  }
  setRate(rate: number, glideSec = 0.15): void {
    if (this.ended) return;
    this.source.playbackRate.setTargetAtTime(Math.max(0.25, Math.min(4, rate)), this.engine.ctx.currentTime, glideSec / 3);
  }
  stop(fadeSec = 0.05): void {
    if (this.ended || this.fading) return;
    this.fading = true;
    const t = this.engine.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + fadeSec);
    try {
      this.source.stop(t + fadeSec + 0.01);
    } catch {
      /* not started yet */
    }
  }
}

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly soundset = new Soundset();
  readonly settings: AudioSettings;
  /** Set by the audio system each tick; positional sounds are relative to this. */
  listener: Listener = { x: 0, y: 0, z: 0, yaw: 0 };
  /** Default season/indoors/night for lookups (CDDA passes these to every sfx call). */
  env: SoundContext = {};
  /** Opaque-tile query for occlusion (map.opaque). */
  opaque: ((x: number, y: number, z: number) => boolean) | null = null;
  loaded = false;
  fileInfo: SoundsetFile['files'] = {};

  private master: GainNode;
  private buses: Record<Bus | 'music', GainNode>;
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  private voices = new Set<VoiceImpl>();
  private lastPlayed = new Map<string, number>();
  private lastFile = new Map<string, string>();
  private baseUrl: string;
  private unlocked = false;

  constructor(opts: { baseUrl?: string; ctx?: AudioContext } = {}) {
    this.baseUrl = opts.baseUrl ?? `${ASSET_BASE}audio/`;
    this.ctx = opts.ctx ?? new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    const bus = () => {
      const g = this.ctx.createGain();
      g.connect(this.master);
      return g;
    };
    this.buses = { sfx: bus(), ui: bus(), ambient: bus(), music: bus() };
    // Settings is a live object for the options menu: assigning a field applies and persists it.
    const initial = { ...DEFAULT_SETTINGS, ...loadStoredSettings() };
    this.settings = new Proxy(initial, {
      set: (o, k, v) => {
        (o as any)[k] = v;
        this.applySettings();
        return true;
      },
    });
    this.applySettings();
  }

  // ------------------------------------------------------------------ setup

  async load(url = `${this.baseUrl}soundset.json`): Promise<void> {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`audio: GET ${url} -> HTTP ${r.status}`);
    const file = (await r.json()) as SoundsetFile;
    if (file.version !== 1) throw new Error(`audio: soundset version ${file.version} unsupported`);
    for (const e of file.effects) this.soundset.add(e);
    this.fileInfo = file.files;
    this.playlists = file.playlists;
    registerSynth((e) => this.soundset.add(e), (id, v) => this.soundset.findExact(id, v) !== null);
    this.loaded = true;
  }

  /**
   * Browsers keep an AudioContext suspended until a user gesture. Resume on the first
   * key/mouse/touch event; music starts then too.
   */
  unlockOnGesture(target: EventTarget = window): void {
    const events = ['pointerdown', 'keydown', 'touchstart'];
    const handler = () => {
      void this.unlock();
      for (const e of events) target.removeEventListener(e, handler, true);
    };
    for (const e of events) target.addEventListener(e, handler, true);
  }

  async unlock(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.unlocked) return;
    this.unlocked = true;
    if (this.settings.musicEnabled) this.startMusic();
  }

  applySettings(): void {
    const s = this.settings;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.master, t, 0.05);
    this.buses.sfx.gain.setTargetAtTime(s.sfx, t, 0.05);
    this.buses.ui.gain.setTargetAtTime(s.ui, t, 0.05);
    this.buses.ambient.gain.setTargetAtTime(s.ambient, t, 0.05);
    this.buses.music.gain.setTargetAtTime(s.music, t, 0.05);
    if (this.musicEl) {
      if (!s.musicEnabled) this.stopMusic();
    } else if (s.musicEnabled && this.unlocked) this.startMusic();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...s }));
    } catch {
      /* private mode etc. */
    }
  }

  // ------------------------------------------------------------------ samples

  /** Which file (id, variant) resolves to right now, with CDDA fallback; null if none. */
  resolve(id: string, variant = 'default', ctx?: SoundContext): ResolvedSound | null {
    return this.soundset.resolve(id, variant, ctx ?? this.env);
  }

  has(id: string, variant = 'default', exact = false): boolean {
    return exact ? this.soundset.findExact(id, variant, this.env) !== null : this.soundset.find(id, variant, this.env) !== null;
  }

  loadBuffer(file: string): Promise<AudioBuffer> {
    const have = this.buffers.get(file);
    if (have) return Promise.resolve(have);
    let p = this.pending.get(file);
    if (!p) {
      p = (async () => {
        let b: AudioBuffer;
        if (file.startsWith(SYNTH_PREFIX)) {
          const data = renderSynth(file, this.ctx.sampleRate);
          b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
          b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
        } else {
          const r = await fetch(this.baseUrl + file);
          if (!r.ok) throw new Error(`audio: GET ${file} -> HTTP ${r.status}`);
          b = await this.ctx.decodeAudioData(await r.arrayBuffer());
        }
        this.buffers.set(file, b);
        this.pending.delete(file);
        return b;
      })();
      p.catch(() => this.pending.delete(file));
      this.pending.set(file, p);
    }
    return p;
  }

  /** Warm the cache for sounds needed with no latency (footsteps, hits). */
  preload(ids: string[]): Promise<unknown> {
    const files = new Set<string>();
    for (const id of ids)
      for (const v of this.soundset.variants(id)) {
        const leaf = this.soundset.find(id, v, this.env);
        for (const f of leaf ?? []) files.add(f.file);
      }
    return Promise.allSettled([...files].map((f) => this.loadBuffer(f)));
  }

  // ------------------------------------------------------------------ playback

  /**
   * Play sound effect `id` / `variant` (falls back to the "default" variant like CDDA).
   * Returns the voice, or null if nothing matches (warned once per id/variant) or the
   * sound was rate-limited.
   */
  play(id: string, variant = 'default', opts: PlayOptions = {}): Voice | null {
    let sound = this.soundset.resolve(id, variant, opts.ctx ?? this.env);
    // Avoid the same sample twice in a row (footsteps, groans): repetition is what makes
    // game audio sound canned. One re-roll keeps it random but rarely repetitive.
    const lastKey = `${id}/${variant}`;
    if (sound && sound.file === this.lastFile.get(lastKey)) sound = this.soundset.resolve(id, variant, opts.ctx ?? this.env) ?? sound;
    if (sound) this.lastFile.set(lastKey, sound.file);
    if (!sound) {
      if (this.loaded) warnOnce('audio', `${id}/${variant}`, `audio: no sound for ${id}/${variant}`);
      return null;
    }
    // Same effect retriggered within 30 ms (e.g. several zombies dying on one tick at the
    // same spot) just stacks into a louder click; CDDA guards guns with 80 ms similarly.
    const key = `${id}/${sound.variant}/${opts.pos ? `${Math.round(opts.pos.x)},${Math.round(opts.pos.y)}` : ''}`;
    const now = performance.now();
    if (!opts.loop && now - (this.lastPlayed.get(key) ?? -1e9) < 30) return null;
    if (this.lastPlayed.size > 512) this.lastPlayed.clear(); // keys include positions
    this.lastPlayed.set(key, now);
    return this.playResolved(sound, opts);
  }

  /**
   * Last 64 sounds started, newest last (debugging / headless assertions). `outcome` says
   * whether the sample actually reached the speakers: 'pending' while it loads, 'playing'
   * once started, 'stale' when it arrived too late and was dropped, 'failed' on a load error.
   * Real-input tests read this (cdda.audio.history) to prove a player action made a sound.
   */
  readonly history: { seq: number; t: number; id: string; variant: string; file: string; pos?: Vec3; bus: Bus; outcome: 'pending' | 'playing' | 'stale' | 'failed'; waitMs?: number }[] = [];
  /** Total sounds started so far; history entries carry their sequence number. */
  playSeq = 0;

  playResolved(sound: ResolvedSound, opts: PlayOptions = {}): Voice {
    const ctx = this.ctx;
    const entry = { seq: ++this.playSeq, t: ctx.currentTime, id: sound.id, variant: sound.variant, file: sound.file, pos: opts.pos, bus: opts.bus ?? 'sfx', outcome: 'pending' as 'pending' | 'playing' | 'stale' | 'failed', waitMs: undefined as number | undefined };
    this.history.push(entry);
    if (this.history.length > 64) this.history.shift();
    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 22000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(filter).connect(gain);
    let panner: PannerNode | null = null;
    if (opts.pos) {
      panner = ctx.createPanner();
      panner.panningModel = this.settings.hrtf ? 'HRTF' : 'equalpower';
      // Distance attenuation is ours (spatial.ts); the panner only does direction.
      panner.distanceModel = 'linear';
      panner.rolloffFactor = 0;
      gain.connect(panner).connect(this.buses[opts.bus ?? 'sfx']);
    } else gain.connect(this.buses[opts.bus ?? 'sfx']);

    const jitter = opts.pitchJitter ?? 0;
    source.playbackRate.value = 1 + (Math.random() * 2 - 1) * jitter;
    source.loop = !!opts.loop;
    const v = new VoiceImpl(this, sound, source, filter, gain, panner, effectGain(sound.volume, opts.volume ?? 1), opts.range ?? 24, opts.minGain ?? 0);
    v.pos = opts.pos;
    source.onended = () => {
      v.ended = true;
      this.voices.delete(v);
      source.disconnect();
      gain.disconnect();
      panner?.disconnect();
    };
    this.voices.add(v);
    this.enforceVoiceLimit();

    const requested = performance.now();
    const start = (buffer: AudioBuffer) => {
      if (v.ended) {
        entry.outcome = 'stale';
        return;
      }
      // stopped (e.g. an ambient bed crossfaded away) before its sample arrived
      if (v.fading || (!opts.loop && performance.now() - requested > STALE_MS)) {
        v.ended = true;
        this.voices.delete(v);
        entry.outcome = 'stale';
        return;
      }
      entry.outcome = 'playing';
      entry.waitMs = Math.round(performance.now() - requested);
      source.buffer = buffer;
      this.spatialize(v, true, opts.fadeIn ?? 0);
      const when = ctx.currentTime + (opts.delay ?? 0);
      // Loops start at a random offset so two fires / two rain beds never phase together.
      source.start(when, opts.loop ? Math.random() * buffer.duration : 0);
    };
    const have = this.buffers.get(sound.file);
    if (have) start(have);
    else this.loadBuffer(sound.file).then(start, (e) => {
      warnOnce('audio-load', sound.file, `audio: failed to load ${sound.file}: ${e}`);
      entry.outcome = 'failed';
      v.ended = true;
      this.voices.delete(v);
    });
    return v;
  }

  /** Recompute direction, distance gain and muffling for a voice. */
  spatialize(v: VoiceImpl, initial: boolean, fadeIn = 0): void {
    const t = this.ctx.currentTime;
    let g = v.baseGain;
    let cutoff = 22000;
    if (v.pos && v.panner) {
      const rel = listenerSpace(this.listener, v.pos);
      // Keep a minimum distance so HRTF doesn't flip hemispheres for sounds on our tile.
      const n = Math.hypot(rel.x, rel.y, rel.z) || 1;
      const d = Math.max(rel.dist, 0.5);
      const px = (rel.x / n) * d, py = (rel.y / n) * d, pz = rel.dist < 1e-3 ? -0.5 : (rel.z / n) * d;
      if (initial) {
        v.panner.positionX.value = px;
        v.panner.positionY.value = py;
        v.panner.positionZ.value = pz;
      } else {
        v.panner.positionX.setTargetAtTime(px, t, 0.03);
        v.panner.positionY.setTargetAtTime(py, t, 0.03);
        v.panner.positionZ.setTargetAtTime(pz, t, 0.03);
      }
      if (initial || this.tickCount % 6 === 0) {
        v.occl = this.settings.occlusion && this.opaque ? countOccluders(this.listener, v.pos, this.opaque) : 0;
      }
      const m = muffle(v.occl, rel.dist);
      g *= distanceGain(rel.dist, v.range, v.minGain) * m.gain;
      cutoff = m.cutoff;
    }
    if (initial) {
      v.filter.frequency.value = cutoff;
      if (fadeIn > 0) {
        v.gain.gain.setValueAtTime(0, t);
        v.gain.gain.linearRampToValueAtTime(g, t + fadeIn);
      } else v.gain.gain.value = g;
    } else {
      v.filter.frequency.setTargetAtTime(cutoff, t, 0.05);
      if (!v.fading) v.gain.gain.setTargetAtTime(g, t, 0.05);
    }
  }

  private tickCount = 0;
  /** Called each game tick with the player's ears. */
  updateListener(l: Listener): void {
    this.listener = l;
    this.tickCount++;
    for (const v of this.voices) if (v.pos && !v.ended && v.source.buffer) this.spatialize(v, false);
  }

  private enforceVoiceLimit(): void {
    if (this.voices.size <= MAX_VOICES) return;
    // Oldest non-looping voice goes first; loops (fires, ambience) are long-lived on purpose.
    for (const v of this.voices) {
      if (!v.source.loop) {
        v.stop(0.02);
        this.voices.delete(v);
        if (this.voices.size <= MAX_VOICES) return;
      }
    }
  }

  get activeVoices(): number {
    return this.voices.size;
  }

  // ------------------------------------------------------------------ ambience

  private weather: WeatherInfo = WEATHER_TYPES.sunny;
  weatherId = 'sunny';
  private ambient = new Map<AmbientChannel | 'wind', { key: string; voice: Voice | null }>();
  private nextThunder = 0;

  /** CDDA weather_type id (sunny, cloudy, drizzle, rain, thunder, snowing, ...). */
  setWeather(id: string): void {
    const w = WEATHER_TYPES[id];
    if (!w) {
      warnOnce('audio-weather', id, `audio: unknown weather "${id}", treating as silent`);
      this.weather = { category: 'silent', rains: false, precip: 'none' };
    } else this.weather = w;
    this.weatherId = id;
  }

  /** Crossfade ambient beds toward what CDDA would play in this situation. */
  updateAmbient(s: Omit<AmbientState, 'weather'> & { altitude?: number }, fade = 2.5): void {
    const layers = ambientLayers({ ...s, weather: this.weather });
    const want = new Map<AmbientChannel | 'wind', { key: string; id: string; variant: string; ctx: SoundContext; volume?: number }>();
    for (const l of layers) {
      want.set(l.channel, { key: `${l.id}/${l.variant}/${l.ctx.season}/${l.ctx.indoors}/${l.ctx.night}`, id: l.id, variant: l.variant, ctx: l.ctx });
    }
    // Rooftops and upper floors in the open get wind (the pack's beds are ground-level birds).
    if (!s.sheltered && !s.underground && (s.altitude ?? 0) > 0) want.set('wind', { key: 'wind', id: 'synth_wind', variant: 'default', ctx: {} });
    for (const [ch, cur] of this.ambient) {
      const w = want.get(ch);
      if (!w || w.key !== cur.key) {
        cur.voice?.stop(fade);
        this.ambient.delete(ch);
      }
    }
    for (const [ch, w] of want) {
      if (this.ambient.has(ch)) continue;
      // exact lookup: CDDA's "daytime" variant is missing from CC-Sounds and must stay silent
      // rather than falling back to some unrelated default.
      const sound = this.soundset.findExact(w.id, w.variant, w.ctx) ? this.soundset.resolve(w.id, w.variant, w.ctx) : null;
      const voice = sound ? this.playResolved(sound, { bus: 'ambient', loop: true, fadeIn: fade }) : null;
      this.ambient.set(ch, { key: w.key, voice });
    }
    // Thunder claps at random intervals during thunderstorms (CDDA weather_sound).
    if (this.weather.category === 'thunder' && !s.underground) {
      const now = this.ctx.currentTime;
      if (this.nextThunder === 0) this.nextThunder = now + 5 + Math.random() * 20;
      if (now >= this.nextThunder) {
        this.nextThunder = now + 12 + Math.random() * 40;
        const near = Math.random() < 0.3;
        const a = Math.random() * Math.PI * 2, d = near ? 30 : 90;
        this.play('environment', near ? 'thunder_near' : 'thunder_far', {
          bus: 'ambient',
          volume: s.sheltered ? 0.5 : 0.9,
          pos: { x: this.listener.x + Math.cos(a) * d, y: this.listener.y + Math.sin(a) * d, z: this.listener.z },
          range: 400,
        });
      }
    } else this.nextThunder = 0;
  }

  ambientState(): Record<string, string | null> {
    const o: Record<string, string | null> = {};
    for (const [ch, cur] of this.ambient) o[ch] = cur.voice ? cur.voice.sound.file : null;
    return o;
  }

  // ------------------------------------------------------------------ music

  private playlists: SoundsetFile['playlists'] = [];
  private musicEl: HTMLAudioElement | null = null;
  private musicQueue: number[] = [];
  private musicTimer: ReturnType<typeof setTimeout> | null = null;
  /** seconds of silence between tracks; CDDA plays back-to-back but silence reads as dread */
  musicGap: [number, number] = [20, 90];
  currentTrack: string | null = null;

  startMusic(playlistId = 'title'): void {
    if (this.musicEl || !this.settings.musicEnabled) return;
    const pl = this.playlists.find((p) => p.id === playlistId);
    if (!pl || !pl.files.length) return;
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous';
    this.ctx.createMediaElementSource(el).connect(this.buses.music);
    this.musicEl = el;
    const next = () => {
      if (!this.musicQueue.length) {
        this.musicQueue = pl.files.map((_, i) => i);
        if (pl.shuffle) this.musicQueue.sort(() => Math.random() - 0.5);
      }
      const track = pl.files[this.musicQueue.shift()!];
      el.src = this.baseUrl + track.file;
      el.volume = Math.min(1, track.volume / 100);
      this.currentTrack = track.file;
      el.play().catch((e) => warnOnce('audio-music', track.file, `audio: music play failed: ${e}`));
    };
    el.addEventListener('ended', () => {
      this.currentTrack = null;
      const [a, b] = this.musicGap;
      this.musicTimer = setTimeout(next, (a + Math.random() * (b - a)) * 1000);
    });
    next();
  }

  stopMusic(): void {
    if (this.musicTimer) clearTimeout(this.musicTimer);
    this.musicTimer = null;
    if (this.musicEl) {
      this.musicEl.pause();
      this.musicEl.src = '';
    }
    this.musicEl = null;
    this.currentTrack = null;
  }
}
