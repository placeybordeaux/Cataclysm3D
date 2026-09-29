import * as THREE from 'three';
import { normalOutputChunk } from './materials';

// Precipitation as GPU-animated particles in a box that wraps around the camera: the CPU
// only updates two uniforms per frame. Rain = short streaks (line segments), snow = single
// points; both land on the low-res grid so they read as pixel particles.
// Known gap: no roof occlusion, it rains indoors too (needs a roof mask texture).

export type WeatherKind = 'clear' | 'rain' | 'storm' | 'snow';

const BOX = 24; // metres, horizontal wrap size
const HEIGHT = 14;

const VERT = /* glsl */ `
attribute float aEnd; // 0 = streak head, 1 = tail
uniform vec3 uCam;
uniform float uTime;
uniform float uSpeed;
uniform float uLen;
uniform vec2 uWind;
varying float vAlpha;
void main() {
  vec3 p = position;
  float fall = uTime * uSpeed * (0.85 + 0.3 * fract(p.x * 13.7));
  p.y = mod(p.y - fall, ${HEIGHT.toFixed(1)});
  p.xz += uWind * (${HEIGHT.toFixed(1)} - p.y) * 0.15;
  // wrap into a box centred on the camera
  vec3 o = uCam - vec3(${(BOX / 2).toFixed(1)}, ${(HEIGHT / 2).toFixed(1)}, ${(BOX / 2).toFixed(1)});
  p.xz = o.xz + mod(p.xz - o.xz, ${BOX.toFixed(1)});
  p.y += o.y;
  p.y += aEnd * uLen;
  p.xz -= aEnd * uWind * uLen * 0.3;
  vAlpha = 1.0;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  gl_PointSize = 1.0;
}`;

const FRAG = /* glsl */ `
layout(location = 1) out highp vec4 gNormal;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, vAlpha);
  ${normalOutputChunk(false, 0)}
}`;

export class Weather {
  readonly group = new THREE.Group();
  kind: WeatherKind = 'clear';
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private rainMat: THREE.ShaderMaterial;
  private snowMat: THREE.ShaderMaterial;
  private time = 0;

  constructor() {
    this.group.name = 'weather';
    this.rainMat = this.material(0x8a9aae, 11, 0.5);
    this.snowMat = this.material(0xe8eef4, 1.2, 0);
    this.rain = new THREE.LineSegments(this.geometry(1800, true), this.rainMat);
    this.snow = new THREE.Points(this.geometry(2500, false), this.snowMat);
    for (const o of [this.rain, this.snow]) {
      o.frustumCulled = false;
      o.visible = false;
      o.renderOrder = 10;
      this.group.add(o);
    }
  }

  private material(color: number, speed: number, len: number): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uCam: { value: new THREE.Vector3() }, uTime: { value: 0 }, uSpeed: { value: speed },
        uLen: { value: len }, uWind: { value: new THREE.Vector2(0.6, 0.2) }, uColor: { value: new THREE.Color(color) },
      },
      transparent: false,
      depthWrite: false,
    });
    (m.userData as any).mrt = true;
    return m;
  }

  private geometry(n: number, streaks: boolean): THREE.BufferGeometry {
    const verts = streaks ? n * 2 : n;
    const pos = new Float32Array(verts * 3);
    const end = new Float32Array(verts);
    // deterministic scatter (golden-ratio sequences) so screenshots are reproducible
    for (let i = 0; i < n; i++) {
      const x = ((i * 0.618034) % 1) * BOX, z = ((i * 0.7548777) % 1) * BOX, y = ((i * 0.5698403) % 1) * HEIGHT;
      for (let k = 0; k < (streaks ? 2 : 1); k++) {
        const v = streaks ? i * 2 + k : i;
        pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
        end[v] = k;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    return g;
  }

  set(kind: WeatherKind): void {
    this.kind = kind;
    this.rain.visible = kind === 'rain' || kind === 'storm';
    this.snow.visible = kind === 'snow';
    this.rainMat.uniforms.uSpeed.value = kind === 'storm' ? 16 : 11;
    this.rain.geometry.setDrawRange(0, kind === 'storm' ? Infinity : 1800);
  }

  update(dt: number, cam: THREE.Vector3): void {
    this.time += dt;
    for (const m of [this.rainMat, this.snowMat]) {
      m.uniforms.uCam.value.copy(cam);
      m.uniforms.uTime.value = this.time;
    }
    this.snowMat.uniforms.uWind.value.set(Math.sin(this.time * 0.3) * 0.5, 0.2);
  }
}
