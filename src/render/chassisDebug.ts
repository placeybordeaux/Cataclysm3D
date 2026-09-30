import * as THREE from 'three';
import { chassisBodyRect, chassisOf, chassisSeats, layoutOf, socketPos, type SocketKind } from '../game/chassis';
import type { Game } from '../game/game';
import type { Vehicle } from '../game/vehicle';
import { LEVEL_HEIGHT } from '../world/coords';
import type { Renderer } from './renderer';

// Debug overlay for vehicles v3 chassis templates (`cdda.chassisOverlay(true)`): each nearby
// vehicle's template body (= its collision outline) as a yellow box on the ground and at roof
// height, its sockets as coloured posts at their body positions, seats as white posts with
// the cushion height, and overflow parts (no socket on the template) as red crosses at their
// cells. Drawn on top of everything so it reads through the bodywork.

const KIND_COLOR: Record<SocketKind, number> = {
  frame: 0x808080, wheel: 0x303030, cabin: 0x40c0ff, panel: 0xff9020, roof: 0x80ff80, engine: 0xff40c0, interior: 0x4060ff,
};
const RADIUS = 45;

export class ChassisOverlay {
  readonly group = new THREE.Group();
  private built = new Map<Vehicle, { version: number; obj: THREE.Object3D }>();
  private mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.95 });
  enabled = false;

  constructor(private renderer: Renderer, private game: Game) {
    this.group.name = 'chassis-overlay';
    this.group.renderOrder = 999;
    renderer.scene.add(this.group);
    renderer.beforeRender.push(() => this.update());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.group.visible = on;
    if (!on) for (const v of [...this.built.keys()]) this.drop(v);
  }

  private drop(v: Vehicle): void {
    const b = this.built.get(v);
    if (!b) return;
    this.group.remove(b.obj);
    b.obj.traverse((o) => (o as THREE.LineSegments).geometry?.dispose());
    this.built.delete(v);
  }

  private update(): void {
    if (!this.enabled) return;
    const vs = this.game.vehicles;
    if (!vs) return;
    const p = this.game.player;
    const near = new Set(vs.list.filter((v) => v.z === p.z && Math.hypot(v.x - p.x, v.y - p.y) < RADIUS));
    for (const v of [...this.built.keys()]) if (!near.has(v)) this.drop(v);
    for (const v of near) {
      let b = this.built.get(v);
      if (!b || b.version !== v.version) {
        this.drop(v);
        b = { version: v.version, obj: this.build(v) };
        this.built.set(v, b);
        this.group.add(b.obj);
      }
      b.obj.position.set(v.x, v.z * LEVEL_HEIGHT, v.y);
      b.obj.rotation.y = (-v.facing * Math.PI) / 180;
    }
  }

  /** Line segments in mount space (x along, three.js z = mount y), y up. */
  private build(v: Vehicle): THREE.Object3D {
    const pos: number[] = [], col: number[] = [];
    const c = new THREE.Color();
    const seg = (a: [number, number, number], b: [number, number, number], color: number) => {
      c.setHex(color);
      pos.push(...a, ...b);
      col.push(c.r, c.g, c.b, c.r, c.g, c.b);
    };
    const L = layoutOf(v);
    const ch = chassisOf(v);
    const body = chassisBodyRect(v);
    const top = L.family === 'frame' ? 1 : L.style === 'bicycle' || L.style === 'motorcycle' ? 1.2 : L.p.box || L.p.roof;
    if (body) {
      for (const h of [0.05, top]) {
        const cs: [number, number, number][] = [[body.x0, h, body.y0], [body.x1, h, body.y0], [body.x1, h, body.y1], [body.x0, h, body.y1]];
        for (let i = 0; i < 4; i++) seg(cs[i], cs[(i + 1) % 4], 0xffe040);
      }
      for (const [x, y] of [[body.x0, body.y0], [body.x1, body.y0], [body.x1, body.y1], [body.x0, body.y1]]) seg([x, 0.05, y], [x, top, y], 0xffe040);
    } else {
      // frame templates collide with their cells
      const cells = new Set(v.parts.map((q) => `${q.mx},${q.my}`));
      for (const k of cells) {
        const [mx, my] = k.split(',').map(Number);
        const cs: [number, number, number][] = [[mx - 0.5, 0.05, my - 0.5], [mx + 0.5, 0.05, my - 0.5], [mx + 0.5, 0.05, my + 0.5], [mx - 0.5, 0.05, my + 0.5]];
        for (let i = 0; i < 4; i++) seg(cs[i], cs[(i + 1) % 4], 0xffe040);
      }
    }
    const heights: Record<SocketKind, number> = { frame: 0.25, wheel: 0.1, cabin: 0.7, panel: 0.9, roof: top, engine: 0.8, interior: 0.6 };
    for (const s of ch.sockets) {
      const [x, y] = socketPos(L, s);
      const h = heights[s.kind];
      const d = s.kind === 'panel' ? 0.12 : 0.07;
      seg([x, h - 0.2, y], [x, h + 0.2, y], KIND_COLOR[s.kind]);
      seg([x - d, h, y], [x + d, h, y], KIND_COLOR[s.kind]);
      seg([x, h, y - d], [x, h, y + d], KIND_COLOR[s.kind]);
    }
    for (const s of chassisSeats(v)) {
      seg([s.x, 0.05, s.y], [s.x, s.h, s.y], 0xffffff);
      seg([s.x - 0.2, s.h, s.y], [s.x + 0.2, s.h, s.y], s.driver ? 0xff4040 : 0xffffff);
    }
    for (const o of ch.overflow) {
      const { mx, my } = o.part;
      seg([mx - 0.3, 1, my - 0.3], [mx + 0.3, 1, my + 0.3], 0xff0000);
      seg([mx - 0.3, 1, my + 0.3], [mx + 0.3, 1, my - 0.3], 0xff0000);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const lines = new THREE.LineSegments(g, this.mat);
    lines.renderOrder = 999;
    lines.frustumCulled = false;
    const obj = new THREE.Group();
    obj.add(lines);
    return obj;
  }
}
