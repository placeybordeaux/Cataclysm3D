import * as THREE from 'three';
import type { SkyState } from './lights';

// Sky dome drawn inside the low-res scene pass (so it gets pixelated, dithered and
// palette-graded like everything else). A camera-centred sphere, depthWrite off, drawn
// first; the post pass treats depth == 1 as sky and skips fog/outlines there.

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p;
}`;

const FRAG = /* glsl */ `
layout(location = 1) out highp vec4 gNormal;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uNight;
uniform float uTime;
uniform float uCloud;
varying vec3 vDir;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // warm glow toward the sun near the horizon (dawn/dusk)
  float sunAmt = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sunAmt, 8.0) * 0.35 * (1.0 - uNight);
  if (h < 0.0) col = mix(uHorizon, uGround, clamp(-h * 6.0, 0.0, 1.0));

  // stars: one cell of a lat/long grid lights up; cells are small enough to be ~1 px
  if (uNight > 0.01 && h > 0.0) {
    vec2 sp = vec2(atan(d.z, d.x) * 180.0, asin(h) * 180.0);
    vec2 cell = floor(sp);
    float r = hash(cell);
    if (r > 0.9965) {
      float tw = 0.6 + 0.4 * sin(uTime * (1.0 + r * 4.0) + r * 100.0);
      col += vec3(0.75, 0.8, 1.0) * tw * uNight * smoothstep(0.0, 0.15, h);
    }
  }
  // sun disc (hard edge = pixel-art disc after quantization)
  float sd = dot(d, uSunDir);
  if (sd > 0.9985 && uSunDir.y > -0.05) col = mix(col, vec3(1.0, 0.95, 0.8) * 2.0, 1.0 - uNight * 0.8);
  // moon disc with a darker mare blotch
  float md = dot(d, uMoonDir);
  if (md > 0.9992 && uNight > 0.0) {
    vec3 moon = vec3(0.85, 0.88, 0.95);
    vec3 side = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    float off = dot(d - uMoonDir, side) * 800.0;
    if (off > 0.2) moon *= 0.72;
    col = mix(col, moon, uNight);
  }
  // sparse drifting cloud bands, darker at night
  if (h > 0.02) {
    vec2 cp = d.xz / (h + 0.15) * 1.6 + vec2(uTime * 0.01, 0.0);
    float c = noise(cp) * 0.6 + noise(cp * 2.3) * 0.4;
    float cover = smoothstep(0.75 - uCloud * 0.5, 0.95 - uCloud * 0.4, c);
    vec3 cloudCol = mix(uHorizon * 1.05, uZenith * 0.6, uNight);
    col = mix(col, cloudCol, cover * 0.6 * smoothstep(0.02, 0.2, h));
  }
  gl_FragColor = vec4(col, 1.0);
  gNormal = vec4(0.5, 0.5, 1.0, 0.0);
}`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  cloudiness = 0.2;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uZenith: { value: new THREE.Color() },
        uHorizon: { value: new THREE.Color() },
        uGround: { value: new THREE.Color() },
        uSunDir: { value: new THREE.Vector3() },
        uSunColor: { value: new THREE.Color() },
        uMoonDir: { value: new THREE.Vector3() },
        uNight: { value: 0 },
        uTime: { value: 0 },
        uCloud: { value: 0.2 },
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
    });
    (this.material.userData as any).mrt = true;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 24, 12), this.material);
    this.mesh.name = 'sky';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
  }

  update(sky: SkyState, camPos: THREE.Vector3, time: number): void {
    const u = this.material.uniforms;
    u.uZenith.value.copy(sky.zenith);
    u.uHorizon.value.copy(sky.horizon);
    u.uGround.value.copy(sky.fog).multiplyScalar(0.6);
    u.uSunDir.value.copy(sky.sunDir);
    u.uSunColor.value.copy(sky.sunColor);
    u.uMoonDir.value.copy(sky.moonDir);
    u.uNight.value = sky.night;
    u.uTime.value = time;
    u.uCloud.value = this.cloudiness;
    this.mesh.position.copy(camPos);
  }
}
