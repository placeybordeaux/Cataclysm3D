// Tiny hand-drawn pixel icons for the HUD and status screens (12×12 art pixels), plus the
// body silhouette used by the HUD and the character sheet. Drawn once per colour into a
// canvas and shown with nearest filtering at an integer multiple of the ui2 UI pixel, so they
// sit in the same pixel grid as the ui2 panels.
//
// Bitmap legend: '.' transparent, 'o' outline (near-black), '#' the icon colour,
// 'w' a highlight (the colour lightened), 'd' the colour darkened.

export const ICONS: Record<string, string[]> = {
  hunger: [
    '......o.....',
    '.....o#oo...',
    '...oo#o##o..',
    '..o##oo##o..',
    '.o#w######o.',
    '.o#w######o.',
    '.o########o.',
    '.o########o.',
    '.od######do.',
    '..od####do..',
    '...oo..oo...',
    '............',
  ],
  thirst: [
    '.....oo.....',
    '....o##o....',
    '....o##o....',
    '...o####o...',
    '..o######o..',
    '..o#w####o..',
    '.o#w######o.',
    '.o#w######o.',
    '.o########o.',
    '..od####do..',
    '...oooooo...',
    '............',
  ],
  fatigue: [
    '...oooo.....',
    '..o###o.....',
    '.o##oo...ooo',
    '.o#o.....o#o',
    'o##o......o.',
    'o#o......ooo',
    'o#o.........',
    'o##o......o.',
    '.o##oo..oo#o',
    '.o#####o##o.',
    '..oo#####o..',
    '....ooooo...',
  ],
  temperature: [
    '.....oo.....',
    '....o##o....',
    '....o#wo.oo.',
    '....o#wo....',
    '....o#wo.oo.',
    '....o##o....',
    '....o##o.oo.',
    '...o####o...',
    '..o#w####o..',
    '..o######o..',
    '...od##do...',
    '....oooo....',
  ],
  pain: [
    '......oooo..',
    '.....o##o...',
    '....o##o....',
    '...o##o.....',
    '..o#####oo..',
    '..oooo###o..',
    '.....o##o...',
    '....o##o....',
    '...o#o......',
    '...oo.......',
    '............',
    '............',
  ],
  morale: [
    '...oooooo...',
    '..o######o..',
    '.o########o.',
    'o##oo##oo##o',
    'o##oo##oo##o',
    'o##########o',
    'o#o######o#o',
    'o##o####o##o',
    '.o##oooo##o.',
    '..o######o..',
    '...oooooo...',
    '............',
  ],
  morale_bad: [
    '...oooooo...',
    '..o######o..',
    '.o########o.',
    'o##oo##oo##o',
    'o##oo##oo##o',
    'o##########o',
    'o###oooo###o',
    'o##o####o##o',
    '.o########o.',
    '..o######o..',
    '...oooooo...',
    '............',
  ],
  weight: [
    '...oooooo...',
    '..o......o..',
    '..o.oooo.o..',
    '...o####o...',
    '..o######o..',
    '.o#w######o.',
    '.o#w######o.',
    '.o########o.',
    '.od######do.',
    '..od####do..',
    '...oooooo...',
    '............',
  ],
  danger: [
    '...oooooo...',
    '..o######o..',
    '.o########o.',
    '.o#oo##oo#o.',
    '.o#oo##oo#o.',
    '.o########o.',
    '..o##oo##o..',
    '...o####o...',
    '...o#o#o#o..',
    '....ooooo...',
    '............',
    '............',
  ],
  sun: [
    '.....#......',
    '.#...#...#..',
    '..#.ooo.#...',
    '...o###o....',
    '..o#w###o...',
    '##o#####o##.',
    '..o#####o...',
    '...o###o....',
    '..#.ooo.#...',
    '.#...#...#..',
    '.....#......',
    '............',
  ],
  moon: [
    '....oooo....',
    '..oo###o....',
    '.o###oo.....',
    '.o##o.......',
    'o##o........',
    'o##o........',
    'o##o........',
    'o###o.......',
    '.o###oo..o..',
    '.o######o...',
    '..oo####o...',
    '....oooo....',
  ],
  cloud: [
    '............',
    '............',
    '....oooo....',
    '...o####o...',
    '..o#w####oo.',
    '.o#w#######o',
    'o##########o',
    'o##########o',
    '.o########o.',
    '..oooooooo..',
    '............',
    '............',
  ],
  rain: [
    '....oooo....',
    '...o####o...',
    '..o#w####oo.',
    '.o#w#######o',
    'o##########o',
    '.o########o.',
    '..oooooooo..',
    '..w...w...w.',
    '.w...w...w..',
    '...w...w....',
    '..w...w.....',
    '............',
  ],
  snow: [
    '.....w......',
    '...w.w.w....',
    '....www.....',
    '.wwwwwwwww..',
    '....www.....',
    '...w.w.w....',
    '.....w......',
    '.........w..',
    '..w.....www.',
    '.www.....w..',
    '..w.........',
    '............',
  ],
  bleed: [
    '..o...',
    '.o#o..',
    'o###o.',
    'o#w#o.',
    '.ooo..',
  ],
  eye: [
    '............',
    '............',
    '...oooooo...',
    '..o######o..',
    '.o##oooo##o.',
    'o##o#ww#o##o',
    'o##o####o##o',
    '.o##oooo##o.',
    '..o######o..',
    '...oooooo...',
    '............',
    '............',
  ],
};

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k));
  return `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
}

const cache = new Map<string, string>();

/** Data URL of an icon drawn in `color` (#rrggbb) at 1 art px = 1 canvas px. */
export function iconURL(name: string, color: string): string {
  const key = `${name}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const bm = ICONS[name];
  if (!bm) throw new Error(`pixelart: no icon ${name}`);
  const c = document.createElement('canvas');
  c.width = bm[0].length;
  c.height = bm.length;
  const g = c.getContext('2d')!;
  const col: Record<string, string> = { o: '#07080c', '#': color, w: shade(color, 0.45), d: shade(color, -0.35) };
  bm.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === '.') return;
      g.fillStyle = col[ch] ?? color;
      g.fillRect(x, y, 1, 1);
    }),
  );
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

/**
 * An <img> of an icon sized `k` CSS px per art pixel (pass a calc() using --u so it snaps), e.g.
 * pixelIcon('thirst', '#6aa0d0', 'calc(var(--u) * 2)').
 */
export function pixelIcon(name: string, color: string, k: string): HTMLImageElement {
  const img = document.createElement('img');
  img.className = 'px-icon';
  img.alt = '';
  img.draggable = false;
  const bm = ICONS[name];
  img.src = iconURL(name, color);
  img.style.width = `calc(${bm[0].length} * ${k})`;
  img.style.height = `calc(${bm.length} * ${k})`;
  return img;
}

// ------------------------------------------------------------------ body silhouette

/**
 * Front view, so the survivor's right side is on the viewer's left (like a paper doll).
 * h head, t torso, r/R right arm/hand, l/L left arm/hand, q/Q right leg/foot, p/P left leg/foot.
 * Hands and feet belong to their limb (CDDA keeps HP per main part).
 */
export const BODY_MAP: string[] = [
  '......hhhhh......',
  '.....hhhhhhh.....',
  '.....hhhhhhh.....',
  '.....hhhhhhh.....',
  '.....hhhhhhh.....',
  '......hhhhh......',
  '.......hhh.......',
  '.................',
  '...r.ttttttt.l...',
  '..rr.ttttttt.ll..',
  '.rrr.ttttttt.lll.',
  '.rrr.ttttttt.lll.',
  '.rrr.ttttttt.lll.',
  '.rr..ttttttt..ll.',
  '.rr..ttttttt..ll.',
  '.rr..ttttttt..ll.',
  '.rr..ttttttt..ll.',
  '.rr..ttttttt..ll.',
  '.rr...ttttt...ll.',
  '.RR...........LL.',
  '.RR...........LL.',
  '......qqq.ppp....',
  '.....qqqq.pppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '.....qqq...ppp...',
  '....QQQQ...PPPP..',
  '....QQQ.....PPP..',
];

export type BodyKey = 'head' | 'torso' | 'arm_l' | 'arm_r' | 'leg_l' | 'leg_r';

const PART_OF: Record<string, BodyKey> = { h: 'head', t: 'torso', r: 'arm_r', R: 'arm_r', l: 'arm_l', L: 'arm_l', q: 'leg_r', Q: 'leg_r', p: 'leg_l', P: 'leg_l' };

/** Which main part is at art pixel (x, y) of the silhouette, or null. */
export function bodyPartAt(x: number, y: number): BodyKey | null {
  const row = BODY_MAP[Math.floor(y)];
  const ch = row?.[Math.floor(x)];
  return ch ? PART_OF[ch] ?? null : null;
}

export interface BodyPaint {
  fill: Record<BodyKey, string>;
  /** Overlays per part. */
  bleeding?: Partial<Record<BodyKey, boolean>>;
  bandaged?: Partial<Record<BodyKey, boolean>>;
  broken?: Partial<Record<BodyKey, boolean>>;
  infected?: Partial<Record<BodyKey, boolean>>;
  /** Blink phase for bleeding drops (0/1). */
  phase?: number;
  /** Colours for overlays. */
  outline?: string;
  bandage?: string;
  blood?: string;
  crack?: string;
}

export const PART_BOX: Record<BodyKey, { x0: number; y0: number; x1: number; y1: number }> = (() => {
  const box = {} as Record<BodyKey, { x0: number; y0: number; x1: number; y1: number }>;
  BODY_MAP.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const p = PART_OF[ch];
      if (!p) return;
      const b = (box[p] ??= { x0: x, y0: y, x1: x, y1: y });
      b.x0 = Math.min(b.x0, x), b.y0 = Math.min(b.y0, y), b.x1 = Math.max(b.x1, x), b.y1 = Math.max(b.y1, y);
    }),
  );
  return box;
})();

export const BODY_W = BODY_MAP[0].length + 2;
export const BODY_H = BODY_MAP.length + 2;

/**
 * Draw the silhouette into `c` (resized to the art size + a 1px outline margin): each part
 * filled with its colour, a dark outline around the figure, then bandage stripes, cracks on
 * broken limbs and blood drops beside bleeding parts.
 */
export function paintBody(c: HTMLCanvasElement, p: BodyPaint): void {
  c.width = BODY_W;
  c.height = BODY_H;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, c.width, c.height);
  const at = (x: number, y: number) => PART_OF[BODY_MAP[y]?.[x] ?? '.'];
  const outline = p.outline ?? '#07080c';
  // Outline: every empty pixel touching a part pixel (8-neighbourhood).
  g.fillStyle = outline;
  for (let y = -1; y <= BODY_MAP.length; y++)
    for (let x = -1; x <= BODY_MAP[0].length; x++) {
      if (at(x, y)) continue;
      let near = false;
      for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1; dx++) if (at(x + dx, y + dy)) (near = true);
      if (near) g.fillRect(x + 1, y + 1, 1, 1);
    }
  BODY_MAP.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const part = PART_OF[ch];
      if (!part) return;
      g.fillStyle = p.fill[part];
      g.fillRect(x + 1, y + 1, 1, 1);
    }),
  );
  const px = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x + 1, y + 1, 1, 1);
  };
  for (const part of Object.keys(PART_BOX) as BodyKey[]) {
    const b = PART_BOX[part];
    const cy = Math.round((b.y0 + b.y1) / 2);
    if (p.bandaged?.[part]) {
      // A two-row wrap across the middle of the part.
      for (let x = b.x0; x <= b.x1; x++) for (const y of [cy, cy + 1]) if (at(x, y) === part) px(x, y, p.bandage ?? '#e8e2d0');
    }
    if (p.broken?.[part]) {
      // A zig-zag crack down the part.
      let x = Math.round((b.x0 + b.x1) / 2);
      for (let y = b.y0 + 1; y < b.y1; y++) {
        x += (y % 2 ? 1 : -1) * (b.x1 - b.x0 > 2 ? 1 : 0);
        if (at(x, y) === part) px(x, y, p.crack ?? '#07080c');
      }
    }
    if (p.infected?.[part]) {
      for (const [dx, dy] of [[0, -2], [1, 1], [-1, 2]]) {
        const x = Math.round((b.x0 + b.x1) / 2) + dx, y = cy + dy;
        if (at(x, y) === part) px(x, y, '#6e8a2a');
      }
    }
    if (p.bleeding?.[part]) {
      // Blood drips down from the part; they move a pixel each blink so they read as running.
      const x = part === 'head' ? b.x1 - 1 : Math.round((b.x0 + b.x1) / 2);
      const y = Math.min(b.y1, cy + 2 + (p.phase ?? 0));
      const blood = p.blood ?? '#c8281e';
      if (at(x, y) === part) px(x, y, blood);
      if (at(x, y - 2) === part) px(x, y - 2, blood);
      if (at(x - 1, y - 1) === part) px(x - 1, y - 1, blood);
    }
  }
}
