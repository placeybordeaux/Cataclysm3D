import { hashSeed } from '../../core/rng';

// Seeded 2D gradient noise + fBm. Evaluated in *global* OMT coordinates so terrain features
// (forests, lakes, rivers) continue seamlessly across lazily generated overmap regions.

const GRADS: [number, number][] = [];
for (let i = 0; i < 16; i++) GRADS.push([Math.cos((i / 16) * Math.PI * 2), Math.sin((i / 16) * Math.PI * 2)]);

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

export class Noise2D {
  constructor(private seed: number) {}

  private grad(ix: number, iy: number, dx: number, dy: number): number {
    const g = GRADS[hashSeed(this.seed, ix, iy) & 15];
    return g[0] * dx + g[1] * dy;
  }

  /** Perlin-style gradient noise, roughly in [-0.7, 0.7]. */
  at(x: number, y: number): number {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = x - x0, fy = y - y0;
    const u = fade(fx), v = fade(fy);
    const n00 = this.grad(x0, y0, fx, fy);
    const n10 = this.grad(x0 + 1, y0, fx - 1, fy);
    const n01 = this.grad(x0, y0 + 1, fx, fy - 1);
    const n11 = this.grad(x0 + 1, y0 + 1, fx - 1, fy - 1);
    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return a + v * (b - a);
  }

  /** Fractal sum normalized to roughly [0, 1] (CDDA's om_noise layers are [0,1] too). */
  fbm(x: number, y: number, octaves = 4, persistence = 0.5, scale = 1): number {
    let amp = 1, freq = scale, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += this.at(x * freq + o * 17.31, y * freq - o * 9.77) * amp;
      norm += amp;
      amp *= persistence;
      freq *= 2;
    }
    return Math.max(0, Math.min(1, 0.5 + (sum / norm) * 0.9));
  }
}
