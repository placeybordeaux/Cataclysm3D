import type { SoundEffectDef } from './soundsetTypes';

// Procedurally synthesized sounds for things the CC packs lack (bullet impacts, metal hits,
// fire, wind, generic smashes, UI confirm, animal growls, monster footsteps, heartbeat).
// Rendered offline into Float32Arrays (pure, deterministic per seed), then wrapped in an
// AudioBuffer by the engine. Registered as ordinary soundset entries whose files are
// "synth:<name>/<seed>", so CDDA fallback rules apply uniformly and a real recording, if a
// future pack adds one, wins automatically (see registerSynth).

export const SYNTH_PREFIX = 'synth:';

type Gen = (sr: number, rnd: () => number) => Float32Array;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- tiny DSP kit -------------------------------------------------------------------

const buf = (sr: number, sec: number) => new Float32Array(Math.max(1, Math.round(sr * sec)));

/** One-pole lowpass in place; cutoff may vary per sample. */
function lowpass(x: Float32Array, sr: number, cutoff: number | ((i: number) => number)): Float32Array {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const fc = typeof cutoff === 'number' ? cutoff : cutoff(i);
    const a = 1 - Math.exp((-2 * Math.PI * fc) / sr);
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}
function highpass(x: Float32Array, sr: number, cutoff: number): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / sr);
  let prevX = 0, y = 0;
  for (let i = 0; i < x.length; i++) {
    y = a * (y + x[i] - prevX);
    prevX = x[i];
    x[i] = y;
  }
  return x;
}
/** RBJ band-pass biquad (constant peak gain). */
function bandpass(x: Float32Array, sr: number, f: number, q: number): Float32Array {
  const w = (2 * Math.PI * f) / sr, alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * c) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
  return x;
}
function noise(n: Float32Array, rnd: () => number, amp = 1): Float32Array {
  for (let i = 0; i < n.length; i++) n[i] += (rnd() * 2 - 1) * amp;
  return n;
}
/** Attack/exponential-decay envelope applied in place (times in seconds). */
function env(x: Float32Array, sr: number, attack: number, decay: number, start = 0): Float32Array {
  const s0 = Math.round(start * sr);
  for (let i = 0; i < x.length; i++) {
    const t = (i - s0) / sr;
    x[i] *= t < 0 ? 0 : t < attack ? t / attack : Math.exp(-(t - attack) / decay);
  }
  return x;
}
function mix(into: Float32Array, src: Float32Array, gain = 1, offset = 0): Float32Array {
  for (let i = 0; i < src.length && i + offset < into.length; i++) into[i + offset] += src[i] * gain;
  return into;
}
function normalize(x: Float32Array, peak = 0.9): Float32Array {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
  return x;
}
/** Sum of decaying sine partials: metallic when ratios are inharmonic. */
function partials(sr: number, sec: number, f0: number, ratios: number[], decay: number, rnd: () => number): Float32Array {
  const x = buf(sr, sec);
  ratios.forEach((r, k) => {
    const f = f0 * r * (0.98 + rnd() * 0.04), ph = rnd() * 6.28, d = decay / (1 + k * 0.6), g = 1 / (1 + k);
    for (let i = 0; i < x.length; i++) x[i] += Math.sin(ph + (2 * Math.PI * f * i) / sr) * g * Math.exp(-i / sr / d);
  });
  return x;
}
/** Seamless loop: crossfade the tail into the head. */
function loopify(x: Float32Array, sr: number, fade = 0.5): Float32Array {
  const n = Math.min(Math.round(fade * sr), Math.floor(x.length / 3));
  const out = x.slice(0, x.length - n);
  for (let i = 0; i < n; i++) {
    const t = i / n;
    out[i] = x[i] * Math.sqrt(t) + x[x.length - n + i] * Math.sqrt(1 - t);
  }
  return out;
}

// ---- generators -----------------------------------------------------------------------

const GENERATORS: Record<string, Gen> = {
  // Bullet into masonry: dry crack plus (sometimes) a ricochet whine.
  hit_wall(sr, rnd) {
    const x = env(highpass(noise(buf(sr, 0.5), rnd), sr, 1200), sr, 0.001, 0.025);
    if (rnd() < 0.6) {
      const w = buf(sr, 0.35), f0 = 2600 + rnd() * 1800, f1 = f0 * (0.45 + rnd() * 0.2);
      let ph = 0;
      for (let i = 0; i < w.length; i++) {
        const t = i / w.length;
        ph += (2 * Math.PI * (f0 + (f1 - f0) * t)) / sr;
        w[i] = Math.sin(ph) * (1 - t) * (1 - t);
      }
      mix(x, env(w, sr, 0.005, 0.12), 0.25, Math.round(sr * 0.02));
    }
    return normalize(x);
  },
  hit_metal(sr, rnd) {
    const x = partials(sr, 0.7, 1100 + rnd() * 500, [1, 2.76, 5.4, 8.93], 0.18, rnd);
    mix(x, env(highpass(noise(buf(sr, 0.05), rnd), sr, 2000), sr, 0.0005, 0.01), 0.8);
    return normalize(x, 0.8);
  },
  hit_flesh(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.2), rnd), sr, 900), sr, 0.002, 0.03);
    const thump = buf(sr, 0.15);
    for (let i = 0; i < thump.length; i++) thump[i] = Math.sin((2 * Math.PI * (80 + rnd() * 2) * i) / sr);
    mix(x, env(thump, sr, 0.002, 0.04), 0.7);
    return normalize(x, 0.8);
  },
  // Weapon into armour / a robot: heavier, lower ring than a bullet.
  melee_metal(sr, rnd) {
    const x = partials(sr, 1.0, 520 + rnd() * 250, [1, 2.4, 3.9, 6.3, 8.1], 0.3, rnd);
    mix(x, env(lowpass(noise(buf(sr, 0.1), rnd), sr, 3000), sr, 0.001, 0.02), 1.2);
    return normalize(x, 0.85);
  },
  // Generic "you smash something and it breaks": splintering noise bursts.
  smash_break(sr, rnd) {
    const x = buf(sr, 0.9);
    const n = 5 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
      const b = env(bandpass(noise(buf(sr, 0.25), rnd), sr, 400 + rnd() * 2500, 1.2), sr, 0.001, 0.02 + rnd() * 0.05);
      mix(x, b, 0.5 + rnd(), Math.round(sr * (k === 0 ? 0 : rnd() * 0.5)));
    }
    mix(x, env(lowpass(noise(buf(sr, 0.3), rnd), sr, 180), sr, 0.002, 0.08), 3);
    return normalize(x);
  },
  // Blow that doesn't break it: dull thud.
  smash_thud(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.4), rnd), sr, 250 + rnd() * 150), sr, 0.002, 0.06);
    mix(x, env(bandpass(noise(buf(sr, 0.1), rnd), sr, 900, 2), sr, 0.001, 0.015), 0.4);
    return normalize(x, 0.85);
  },
  metal_door_slam(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.9), rnd), sr, 200), sr, 0.002, 0.07);
    mix(x, partials(sr, 0.9, 180 + rnd() * 40, [1, 2.1, 3.3, 5.2], 0.25, rnd), 0.35);
    return normalize(x, 0.85);
  },
  door_locked(sr, rnd) {
    const x = buf(sr, 0.6);
    for (let k = 0; k < 3; k++) {
      const h = env(bandpass(noise(buf(sr, 0.12), rnd), sr, 700 + rnd() * 300, 3), sr, 0.001, 0.02);
      mix(x, h, 1, Math.round(sr * (0.05 + k * (0.12 + rnd() * 0.05))));
    }
    return normalize(x, 0.7);
  },
  // Animal growl / generic creature vocalisation: vibrato buzz through a vowel-ish bandpass.
  growl(sr, rnd) {
    const sec = 0.7 + rnd() * 0.5, x = buf(sr, sec);
    const f0 = 70 + rnd() * 60;
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * f0 * (1 + 0.06 * Math.sin(2 * Math.PI * 7 * t) + 0.3 * (t / sec))) / sr;
      x[i] = ((ph / (2 * Math.PI)) % 1) * 2 - 1 + (rnd() * 2 - 1) * 0.3;
    }
    const a = bandpass(x.slice(), sr, 500 + rnd() * 200, 3), b = bandpass(x.slice(), sr, 1100 + rnd() * 300, 4);
    const out = mix(mix(buf(sr, sec), a), b, 0.6);
    for (let i = 0; i < out.length; i++) out[i] *= Math.sin((Math.PI * i) / out.length) ** 0.6;
    return normalize(out, 0.8);
  },
  // A monster dragging its feet: short lowpassed scrape.
  shuffle(sr, rnd) {
    const x = noise(buf(sr, 0.3), rnd);
    lowpass(x, sr, (i) => 300 + 900 * Math.sin((Math.PI * i) / x.length));
    for (let i = 0; i < x.length; i++) x[i] *= Math.sin((Math.PI * i) / x.length);
    return normalize(x, 0.7);
  },
  // A swing through empty air: band-passed noise sweeping down, loud in the middle.
  whoosh(sr, rnd) {
    const sec = 0.28 + rnd() * 0.08, x = noise(buf(sr, sec), rnd);
    const f0 = 1400 + rnd() * 500;
    lowpass(x, sr, (i) => f0 * (1 - 0.7 * (i / x.length)) + 150);
    highpass(x, sr, 180);
    for (let i = 0; i < x.length; i++) x[i] *= Math.sin((Math.PI * i) / x.length) ** 1.6;
    return normalize(x, 0.75);
  },
  // A monster drawing back to strike: a short rising snarl over a cloth/limb rustle.
  windup(sr, rnd) {
    const sec = 0.32 + rnd() * 0.08, x = buf(sr, sec);
    const f0 = 85 + rnd() * 35;
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      ph += (2 * Math.PI * f0 * (1 + 0.8 * (t / sec) + 0.05 * Math.sin(2 * Math.PI * 9 * t))) / sr;
      x[i] = ((ph / (2 * Math.PI)) % 1) * 2 - 1 + (rnd() * 2 - 1) * 0.4;
    }
    const out = mix(bandpass(x.slice(), sr, 650 + rnd() * 200, 2.5), bandpass(x, sr, 1500, 3), 0.5);
    mix(out, lowpass(noise(buf(sr, sec), rnd), sr, 900), 0.25);
    for (let i = 0; i < out.length; i++) {
      const u = i / out.length;
      out[i] *= Math.min(1, u * 6) * (u < 0.8 ? 0.4 + 0.75 * u : (1 - u) * 5);
    }
    return normalize(out, 0.8);
  },
  // Guard meets blow at the right moment: bright clack with a short ring.
  parry(sr, rnd) {
    const x = partials(sr, 0.45, 900 + rnd() * 200, [1, 2.3, 3.7, 5.9], 0.09, rnd);
    mix(x, env(highpass(noise(buf(sr, 0.04), rnd), sr, 1800), sr, 0.0005, 0.008), 1.5);
    mix(x, env(lowpass(noise(buf(sr, 0.12), rnd), sr, 300), sr, 0.001, 0.03), 1.2);
    return normalize(x, 0.85);
  },
  // A body hitting the ground: low thump plus a slap of limbs.
  bodyfall(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.5), rnd), sr, 160 + rnd() * 60), sr, 0.003, 0.09);
    const thump = buf(sr, 0.3);
    for (let i = 0; i < thump.length; i++) thump[i] = Math.sin((2 * Math.PI * (55 + rnd()) * i) / sr);
    mix(x, env(thump, sr, 0.003, 0.08), 0.9);
    mix(x, env(bandpass(noise(buf(sr, 0.1), rnd), sr, 700, 1.5), sr, 0.001, 0.02), 0.5, Math.round(sr * (0.05 + rnd() * 0.04)));
    return normalize(x, 0.85);
  },
  // ---- archery (rangedfeel.ts): the pack has one bow recording for every bow, crossbow and
  // sling; these give each its own voice and replace the bullet crack where an arrow lands.
  // Loosed bowstring: a low plucked string (Karplus-Strong) with a woody knock of the limbs.
  bow_twang(sr, rnd) {
    const sec = 0.55, x = buf(sr, sec);
    const f0 = 95 + rnd() * 35, n = Math.max(2, Math.round(sr / f0));
    const line = noise(new Float32Array(n), rnd);
    let idx = 0;
    for (let i = 0; i < x.length; i++) {
      const a = line[idx], b = line[(idx + 1) % n];
      line[idx] = (a + b) * 0.5 * 0.994;
      x[i] = a;
      idx = (idx + 1) % n;
    }
    env(x, sr, 0.001, 0.09);
    mix(x, env(bandpass(noise(buf(sr, 0.08), rnd), sr, 900 + rnd() * 300, 1.4), sr, 0.0005, 0.012), 1.4);
    mix(x, env(lowpass(noise(buf(sr, 0.1), rnd), sr, 220), sr, 0.001, 0.02), 0.8);
    return normalize(highpass(x, sr, 60), 0.85);
  },
  // Drawing a bow: the limbs and string creak under a slowly rising load.
  bow_creak(sr, rnd) {
    const sec = 0.5 + rnd() * 0.15, x = buf(sr, sec);
    let t = 0;
    while (t < sec - 0.02) {
      const g = env(bandpass(noise(buf(sr, 0.03), rnd), sr, 500 + (t / sec) * 500 + rnd() * 200, 6), sr, 0.001, 0.004);
      mix(x, g, 0.4 + (t / sec) * 0.6, Math.round(t * sr));
      t += 0.012 + rnd() * 0.02;
    }
    mix(x, lowpass(noise(buf(sr, sec), rnd, 0.15), sr, 400), 1);
    for (let i = 0; i < x.length; i++) x[i] *= Math.min(1, (i / x.length) * 4) * Math.min(1, (1 - i / x.length) * 8);
    return normalize(x, 0.6);
  },
  // An arrow striking flesh: a short wet thock.
  arrow_flesh(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.18), rnd), sr, 700 + rnd() * 200), sr, 0.001, 0.025);
    const thump = buf(sr, 0.12);
    for (let i = 0; i < thump.length; i++) thump[i] = Math.sin((2 * Math.PI * (120 + rnd() * 4) * i) / sr);
    mix(x, env(thump, sr, 0.001, 0.03), 0.8);
    return normalize(x, 0.8);
  },
  // An arrow thunking into wood or a wall, then the shaft quivering.
  arrow_wood(sr, rnd) {
    const x = env(bandpass(noise(buf(sr, 0.06), rnd), sr, 1400 + rnd() * 400, 2), sr, 0.0005, 0.01);
    mix(x, env(lowpass(noise(buf(sr, 0.1), rnd), sr, 300), sr, 0.001, 0.02), 1.2);
    const quiver = buf(sr, 0.45), f = 30 + rnd() * 12, g = 380 + rnd() * 120;
    for (let i = 0; i < quiver.length; i++) {
      const t = i / sr;
      quiver[i] = Math.sin(2 * Math.PI * g * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * f * t)) * Math.exp(-t / 0.12);
    }
    mix(x, quiver, 0.25, Math.round(sr * 0.01));
    return normalize(x, 0.8);
  },
  // An arrow or stone into soil: a soft dull thud.
  arrow_ground(sr, rnd) {
    const x = env(lowpass(noise(buf(sr, 0.2), rnd), sr, 350 + rnd() * 100), sr, 0.002, 0.03);
    mix(x, env(bandpass(noise(buf(sr, 0.05), rnd), sr, 1800, 1.5), sr, 0.0005, 0.006), 0.3);
    return normalize(x, 0.6);
  },
  // Crossbow trigger: a hard click of the nut, then the prod's thonk.
  xbow_release(sr, rnd) {
    const x = env(highpass(noise(buf(sr, 0.03), rnd), sr, 2500), sr, 0.0003, 0.004);
    const thonk = partials(sr, 0.35, 160 + rnd() * 40, [1, 2.1, 3.4], 0.07, rnd);
    mix(x, thonk, 0.9, Math.round(sr * 0.012));
    mix(x, env(lowpass(noise(buf(sr, 0.12), rnd), sr, 400), sr, 0.001, 0.025), 0.7, Math.round(sr * 0.012));
    return normalize(x, 0.85);
  },
  // Cranking a crossbow back: a ratchet, click after click.
  xbow_crank(sr, rnd) {
    const sec = 0.9, x = buf(sr, sec);
    for (let t = 0.02; t < sec - 0.05; t += 0.07 + rnd() * 0.02) {
      mix(x, env(bandpass(noise(buf(sr, 0.03), rnd), sr, 2200 + rnd() * 600, 3), sr, 0.0003, 0.005), 0.7 + rnd() * 0.3, Math.round(t * sr));
    }
    mix(x, lowpass(noise(buf(sr, sec), rnd, 0.1), sr, 300), 1);
    return normalize(x, 0.6);
  },
  // A sling whirling overhead: whooshes pulsing about three times a second (loops).
  sling_whirl(sr, rnd) {
    const sec = 1.2, x = noise(buf(sr, sec + 0.3), rnd);
    const rate = 2.8 + rnd() * 0.6;
    lowpass(x, sr, (i) => 600 + 900 * Math.max(0, Math.sin((2 * Math.PI * rate * i) / sr)));
    highpass(x, sr, 200);
    for (let i = 0; i < x.length; i++) x[i] *= Math.max(0, Math.sin((2 * Math.PI * rate * i) / sr)) ** 2;
    return normalize(loopify(x, sr, 0.3), 0.6);
  },
  heartbeat(sr) {
    const x = buf(sr, 0.9);
    for (const [at, g] of [[0, 1], [0.28, 0.7]] as const) {
      const b = buf(sr, 0.2);
      for (let i = 0; i < b.length; i++) b[i] = Math.sin((2 * Math.PI * 48 * i) / sr);
      mix(x, env(b, sr, 0.01, 0.05), g, Math.round(at * sr));
    }
    return normalize(x, 0.9);
  },
  ui_confirm(sr) {
    const x = buf(sr, 0.12);
    for (let i = 0; i < x.length; i++) {
      const t = i / sr;
      x[i] = Math.sin(2 * Math.PI * (t < 0.05 ? 660 : 990) * t) * 0.5;
    }
    return env(x, sr, 0.002, 0.04);
  },
  ui_open(sr) {
    const x = buf(sr, 0.09);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * (440 + 2000 * (i / x.length)) * (i / sr)) * 0.4;
    return env(x, sr, 0.002, 0.03);
  },
  ui_close(sr) {
    const x = buf(sr, 0.09);
    for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * (1400 - 1000 * (i / x.length)) * (i / sr)) * 0.4;
    return env(x, sr, 0.002, 0.03);
  },
  // Looping beds.
  fire_loop(sr, rnd) {
    const sec = 6, x = lowpass(noise(buf(sr, sec + 0.5), rnd, 0.35), sr, 350);
    const pops = 90 + Math.floor(rnd() * 40);
    for (let k = 0; k < pops; k++) {
      const p = env(highpass(noise(buf(sr, 0.03), rnd), sr, 1500 + rnd() * 3000), sr, 0.0005, 0.002 + rnd() * 0.006);
      mix(x, p, 0.3 + rnd() * rnd() * 1.5, Math.floor(rnd() * (x.length - p.length)));
    }
    return normalize(loopify(x, sr), 0.7);
  },
  wind_loop(sr, rnd) {
    const sec = 10, x = noise(buf(sr, sec + 1), rnd);
    const p1 = rnd() * 6.28, p2 = rnd() * 6.28;
    lowpass(x, sr, (i) => 250 + 450 * (0.5 + 0.5 * Math.sin(p1 + (2 * Math.PI * i) / sr / 3.7)));
    for (let i = 0; i < x.length; i++) x[i] *= 0.55 + 0.45 * Math.sin(p2 + (2 * Math.PI * i) / sr / 5.3);
    return normalize(loopify(x, sr, 1), 0.6);
  },
};

export const SYNTH_NAMES = Object.keys(GENERATORS);

/** Render "synth:<name>/<seed>" into samples at `sampleRate`. Deterministic. */
export function renderSynth(file: string, sampleRate: number): Float32Array {
  if (!file.startsWith(SYNTH_PREFIX)) throw new Error(`not a synth file: ${file}`);
  const [name, seedStr] = file.slice(SYNTH_PREFIX.length).split('/');
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`unknown synth sound ${name}`);
  let h = 2166136261;
  for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return gen(sampleRate, mulberry32(h ^ Number(seedStr ?? 0)));
}

const files = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${SYNTH_PREFIX}${name}/${i}`);

/**
 * Synthetic sound_effect entries. Ids/variants follow CDDA where CDDA has them
 * (bullet_hit/hit_wall, melee_hit_metal, smash_success/default ...); the rest use a
 * "synth_" id so nobody mistakes them for pack content.
 */
export const SYNTH_EFFECTS: SoundEffectDef[] = [
  { id: 'bullet_hit', variants: ['hit_wall'], volume: 90, files: files('hit_wall', 4) },
  { id: 'bullet_hit', variants: ['hit_metal'], volume: 80, files: files('hit_metal', 3) },
  { id: 'bullet_hit', variants: ['hit_flesh', 'default'], volume: 90, files: files('hit_flesh', 3) },
  { id: 'melee_hit_metal', variants: ['default'], volume: 90, files: files('melee_metal', 3) },
  { id: 'smash_success', variants: ['default'], volume: 90, files: files('smash_break', 3) },
  { id: 'smash_fail', variants: ['default'], volume: 90, files: files('smash_thud', 3) },
  { id: 'close_door', variants: ['t_door_metal_o', 'metal'], volume: 80, files: files('metal_door_slam', 2) },
  { id: 'synth_door_locked', variants: ['default'], volume: 70, files: files('door_locked', 2) },
  { id: 'synth_growl', variants: ['default'], volume: 80, files: files('growl', 4) },
  { id: 'synth_monster_step', variants: ['default'], volume: 50, files: files('shuffle', 4) },
  { id: 'synth_heartbeat', variants: ['default'], volume: 80, files: files('heartbeat', 1) },
  { id: 'synth_whoosh', variants: ['default'], volume: 55, files: files('whoosh', 3) },
  { id: 'synth_windup', variants: ['default'], volume: 70, files: files('windup', 4) },
  { id: 'synth_parry', variants: ['default'], volume: 85, files: files('parry', 2) },
  { id: 'synth_bodyfall', variants: ['default'], volume: 75, files: files('bodyfall', 3) },
  { id: 'synth_bow_twang', variants: ['default'], volume: 80, files: files('bow_twang', 3) },
  { id: 'synth_bow_draw', variants: ['default'], volume: 55, files: files('bow_creak', 3) },
  { id: 'synth_arrow_hit', variants: ['flesh'], volume: 80, files: files('arrow_flesh', 3) },
  { id: 'synth_arrow_hit', variants: ['wall', 'wood', 'default'], volume: 85, files: files('arrow_wood', 3) },
  { id: 'synth_arrow_hit', variants: ['ground'], volume: 60, files: files('arrow_ground', 3) },
  { id: 'synth_xbow_release', variants: ['default'], volume: 85, files: files('xbow_release', 2) },
  { id: 'synth_xbow_crank', variants: ['default'], volume: 60, files: files('xbow_crank', 1) },
  { id: 'synth_sling_whirl', variants: ['default'], volume: 55, files: files('sling_whirl', 1) },
  { id: 'menu_select', variants: ['default'], volume: 50, files: files('ui_confirm', 1) },
  { id: 'menu_open', variants: ['default'], volume: 45, files: files('ui_open', 1) },
  { id: 'menu_close', variants: ['default'], volume: 45, files: files('ui_close', 1) },
  { id: 'synth_fire', variants: ['default'], volume: 70, files: files('fire_loop', 1) },
  { id: 'synth_wind', variants: ['default'], volume: 45, files: files('wind_loop', 1) },
];

/** Add synthetic entries whose (id, variant) the pack doesn't already provide exactly. */
export function registerSynth(
  add: (e: SoundEffectDef) => void,
  hasExact: (id: string, variant: string) => boolean,
): SoundEffectDef[] {
  const added: SoundEffectDef[] = [];
  for (const e of SYNTH_EFFECTS) {
    const variants = e.variants.filter((v) => !hasExact(e.id, v));
    if (!variants.length) continue;
    const def = { ...e, variants };
    add(def);
    added.push(def);
  }
  return added;
}
