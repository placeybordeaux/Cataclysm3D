import { charSettings } from './index';
import type { CharInstance, CharLayer, Skin } from './charLayer';
import { HUM, quirk, type PoseIn, type Rig } from './rig';

// Animation driver for one procedural creature (monster or NPC): turns simulation state into
// stepped poses (charSettings.fps), a facing that follows movement/target rather than the
// camera, lying down, and the death fall. monsterView.ts / npcView.ts own the combat-feel
// logic (telegraphs, kicks, hit-stop) and hand the results in here.

export interface CreatureState {
  x: number;
  y: number;
  z: number;
  /** Monster/Npc facing: radians, 0 = north, clockwise */
  facing: number;
  /** Look at this point instead (winding up a blow, fighting at arm's length) */
  target: { x: number; y: number } | null;
  moving: boolean;
  walkPhase: number;
  windup: { elapsed: number; total: number; kind: 'melee' | 'heavy' | 'leap' } | null;
  /** 0..1 */
  flinch: number;
  /** 0 standing .. 1 lying */
  down: number;
  visible: boolean;
  /** hostile: 1 (distance readability), else 0 */
  emph: number;
  /** 0 solid .. 1 invisible (far figures at the draw distance) */
  fade?: number;
  /** horizontal distance to the camera (m) */
  camDist: number;
  /** telegraph stretch / knock-back squash */
  sy: number;
  sxz: number;
  /** metres above the level floor (walking a flight: render/stairs) */
  lift?: number;
}

const TURN_RATE = 9; // rad/s
const STRIKE_TIME = 0.28;
/**
 * Idle life of a zombie standing about (and of dormant far figures, which the simulation never
 * moves): a slow rock from foot to foot big enough to read at 50 m, a lolling head, and every
 * few seconds a couple of shuffle steps in place with a slow turn. Render-only. The rock grows by
 * up to farBoost over the FAR_LOD range: 4° moves a head only 2-3 pixels at 50 m.
 */
export const IDLE_LIFE = { rock: 0.075, sway: 0.045, pitch: 0.035, head: 0.14, gait: 0.35, shuffle: [1.0, 1.8], gap: [3, 9], turn: 0.7, turnRate: 0.6, farBoost: 0.8 };
/** Far-LOD silhouette thickening: starts / full (m). Keeps limbs a few pixels wide at range. */
export const FAR_LOD = { near: 22, far: 55 };

function step(t: number): number {
  const f = charSettings.fps;
  return f > 0 ? Math.floor(t * f) / f : t;
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const smooth = (a: number, b: number, x: number) => {
  const k = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return k * k * (3 - 2 * k);
};

export class CreatureModel {
  readonly inst: CharInstance;
  private yawR: number;
  private gait = 0;
  private lastX: number;
  private lastY: number;
  private strikeT = 0;
  private clock = 0;
  private readonly pin: PoseIn;
  /** Zombie-style humanoids idle with IDLE_LIFE. */
  private readonly lively: boolean;
  private idleK = 0;
  private idlePhase = 0;
  private idleYaw = 0;
  private idleYawTo = 0;
  private shuffleT = 0;
  private shuffleDur = 0;
  private nextShuffle: number;
  private shuffles = 0;

  constructor(layer: CharLayer, readonly rig: Rig, skin: Skin, readonly seed: number, x: number, y: number, facing: number) {
    this.inst = layer.add(rig, skin);
    this.yawR = facing;
    this.lastX = x;
    this.lastY = y;
    this.clock = seed * 10;
    this.pin = { t: 0, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 0, dead: false, seed };
    this.lively = rig.shape.arch === 'humanoid' && (rig.shape.zombie || !!rig.zlook);
    this.nextShuffle = IDLE_LIFE.gap[0] * quirk(seed, 21) * 2;
  }

  /** A blow landed or whiffed: play the follow-through. */
  strike(): void {
    this.strikeT = STRIKE_TIME;
  }

  update(dt: number, s: CreatureState): void {
    const c = this.inst;
    this.clock += dt;
    // gait from how fast it actually moved (walk ~1.3 m/s = 1, sprinting dogs = 2)
    const v = dt > 0 ? Math.hypot(s.x - this.lastX, s.y - this.lastY) / dt : 0;
    this.lastX = s.x;
    this.lastY = s.y;
    const target = s.moving ? Math.min(2, v / 1.3) : 0;
    this.gait += (target - this.gait) * Math.min(1, dt * 8);
    if (!s.moving && this.gait < 0.05) this.gait = 0;
    // facing: toward the target when fighting, else where it walks
    const want = s.target ? Math.atan2(s.target.x - s.x, -(s.target.y - s.y)) : s.facing;
    const d = wrapAngle(want - this.yawR);
    this.yawR = wrapAngle(this.yawR + Math.sign(d) * Math.min(Math.abs(d), TURN_RATE * dt));
    this.strikeT = Math.max(0, this.strikeT - dt);

    const p = this.pin;
    p.t = step(this.clock);
    // walkPhase advances 3 per tile and bobs with sin(walkPhase·π): one stride cycle = 2
    const f = charSettings.fps;
    const phase = s.walkPhase / 2;
    p.phase = f > 0 ? Math.floor(phase * 8) / 8 : phase;
    p.gait = this.gait;
    if (s.windup) {
      p.windup = Math.min(1, step(s.windup.elapsed) / Math.max(1e-3, s.windup.total));
      p.windKind = s.windup.kind;
    } else p.windup = null;
    p.strike = this.strikeT > 0 ? Math.ceil(step(this.strikeT) / STRIKE_TIME * 4) / 4 : 0;
    p.down = s.down;
    p.flinch = s.flinch;
    p.dead = false;
    const idle = this.lively && !s.moving && !s.target && !s.windup && s.down < 0.05 && s.flinch < 0.05 && this.gait < 0.05;
    this.idleK += ((idle ? 1 : 0) - this.idleK) * Math.min(1, dt * 2);
    if (this.idleK > 0.01) this.idleLife(dt, p);
    c.setPose(p);
    if (this.idleK > 0.01) this.idleRock(c, s.camDist);

    c.x = s.x;
    c.y = s.y;
    c.z = s.z;
    c.yaw = this.yawR + this.idleYaw * this.idleK;
    c.sy = s.sy;
    c.sxz = s.sxz;
    c.emph = s.emph;
    c.far = smooth(FAR_LOD.near, FAR_LOD.far, s.camDist);
    const fade = s.fade ?? 0;
    if (fade !== c.fade) (c.fade = fade, c.dirty = true);
    c.setVisible(s.visible);
    // lying down: topple over (backwards, or onto the side for animals)
    const lie = this.rig.lie;
    const fall = lie.angle * s.down;
    c.fall = fall;
    const back = this.yawR + (lie.side ? Math.PI / 2 : Math.PI);
    c.fallDx = Math.sin(back);
    c.fallDy = -Math.cos(back);
    c.lift = liftFor(this.rig, fall) + this.rig.hover * (1 - s.down) + (s.lift ?? 0);
  }

  /** Shuffle steps in place and a slow turn now and then (feeds the walk cycle). */
  private idleLife(dt: number, p: PoseIn): void {
    const L = IDLE_LIFE, k = this.idleK;
    this.nextShuffle -= dt;
    if (this.nextShuffle <= 0 && this.shuffleT <= 0) {
      const n = ++this.shuffles;
      this.shuffleT = this.shuffleDur = L.shuffle[0] + (L.shuffle[1] - L.shuffle[0]) * quirk(this.seed, 30 + (n % 50));
      this.nextShuffle = L.gap[0] + (L.gap[1] - L.gap[0]) * quirk(this.seed, 90 + (n % 50));
      this.idleYawTo = (quirk(this.seed, 150 + (n % 50)) * 2 - 1) * L.turn;
    }
    if (this.shuffleT > 0) {
      this.shuffleT -= dt;
      this.idlePhase += dt * 0.9;
      const d = this.idleYawTo - this.idleYaw;
      this.idleYaw += Math.sign(d) * Math.min(Math.abs(d), L.turnRate * dt);
      const f = charSettings.fps;
      p.phase = f > 0 ? Math.floor(this.idlePhase * 8) / 8 : this.idlePhase;
      // ease the steps in and out so the feet don't snap
      p.gait = Math.max(p.gait, L.gait * k * Math.min(1, this.shuffleT * 3, (this.shuffleDur - this.shuffleT) * 3));
    }
  }

  /** The foot-to-foot rock and head loll on top of the rig's own pose. */
  private idleRock(c: CharInstance, camDist: number): void {
    const L = IDLE_LIFE, k = this.idleK * (1 + L.farBoost * smooth(FAR_LOD.near, FAR_LOD.far, camDist));
    // each zombie rocks at its own pace (0.3-0.55 Hz) so a horde doesn't sway in step
    const ph = step(this.clock) * Math.PI * 2 * (0.3 + 0.25 * quirk(this.seed, 17)) + this.seed * 40;
    const amp = k * (0.7 + 0.6 * quirk(this.seed, 18));
    const o = c.pose, sc = this.rig.shape.scale;
    o.lean[2] += Math.sin(ph) * L.rock * amp;
    o.pos[0] += Math.sin(ph) * L.sway * amp * sc;
    o.lean[0] += Math.sin(ph * 0.5 + this.seed * 7) * L.pitch * amp;
    o.rot[HUM.head * 3 + 2] -= Math.sin(ph - 0.6) * L.head * amp;
    o.rot[HUM.head * 3] += Math.sin(ph * 0.5 + 1.3) * L.head * 0.5 * amp;
  }

  flash(color: number, seconds: number): void {
    this.inst.flash(color, seconds);
  }

  remove(): void {
    this.inst.remove();
  }
}

function liftFor(rig: Rig, fall: number): number {
  const a = rig.lie.angle;
  if (a <= 0 || fall <= 0) return 0;
  return rig.lie.lift * (1 - Math.cos(fall)) / (1 - Math.cos(a));
}

/** Death: stagger along the blow, topple, bounce, then lie still (charLayer "dead" layer). */
export const DEATH = { stagger: 0.1, fall: 0.32, bounce: 0.14 };
export const DEATH_TOTAL = DEATH.stagger + DEATH.fall + DEATH.bounce;

export class FallingBody {
  readonly inst: CharInstance;
  t: number;
  private readonly pin: PoseIn;
  landed = false;
  private fallDir: { x: number; y: number };

  /**
   * (dx, dy): the killing blow's push (tiles, may be 0). A body with no push falls backwards
   * (people) or onto a side (animals). `done` = already lying (loaded corpses).
   */
  constructor(layer: CharLayer, readonly rig: Rig, skin: Skin, readonly seed: number, readonly x0: number, readonly y0: number, readonly z: number, facing: number, readonly dx: number, readonly dy: number, done: boolean) {
    this.inst = layer.add(rig, skin);
    this.t = done ? DEATH_TOTAL : 0;
    this.pin = { t: seed * 3, phase: 0, gait: 0, windup: null, windKind: 'melee', strike: 0, down: 0, flinch: 1, dead: false, seed };
    const push = Math.hypot(dx, dy);
    let ang: number;
    if (rig.lie.side) ang = facing + (seed < 0.5 ? 1 : -1) * Math.PI / 2;
    else if (push > 0.01) {
      // People fall flat on their back or front, whichever is nearer the blow: toppling
      // sideways left the spread arms sticking up out of the pile.
      const blow = Math.atan2(dx, -dy);
      const diff = Math.atan2(Math.sin(blow - facing), Math.cos(blow - facing));
      ang = Math.abs(diff) < Math.PI / 2 ? facing : facing + Math.PI;
    } else ang = facing + Math.PI;
    this.fallDir = { x: Math.sin(ang), y: -Math.cos(ang) };
    this.inst.yaw = facing;
    this.inst.z = z;
    this.apply();
  }

  /** Advance; returns true on the frame the body hits the floor. */
  update(dt: number): boolean {
    if (this.t >= DEATH_TOTAL) return false;
    this.t = Math.min(DEATH_TOTAL, this.t + dt);
    return this.apply();
  }

  private apply(): boolean {
    const t = this.t;
    const c = this.inst;
    const lie = this.rig.lie;
    let slide: number, fall: number;
    if (t < DEATH.stagger) (slide = (t / DEATH.stagger) * 0.5, fall = 0);
    else if (t < DEATH.stagger + DEATH.fall) {
      const k = (t - DEATH.stagger) / DEATH.fall;
      slide = 0.5 + 0.5 * k;
      fall = lie.angle * k * k; // accelerates like a body toppling
    } else {
      const b = Math.min(1, (t - DEATH.stagger - DEATH.fall) / DEATH.bounce);
      slide = 1;
      fall = lie.angle * (1 - 0.1 * Math.sin(b * Math.PI));
    }
    const wasLanded = this.landed;
    this.landed = t >= DEATH.stagger + DEATH.fall;
    this.pin.dead = this.landed;
    this.pin.flinch = this.landed ? 0 : 1;
    this.pin.down = this.landed ? 1 : Math.min(1, fall / Math.max(0.01, lie.angle));
    c.setPose(this.pin);
    c.x = this.x0 + this.dx * slide;
    c.y = this.y0 + this.dy * slide;
    c.fall = fall;
    c.fallDx = this.fallDir.x;
    c.fallDy = this.fallDir.y;
    c.lift = liftFor(this.rig, fall);
    c.dirty = true;
    return this.landed && !wasLanded;
  }

  remove(): void {
    this.inst.remove();
  }
}
