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

/**
 * The cloudless sky colour along a world direction. Shared with the post pass, whose
 * distance fade dissolves far geometry into exactly the sky behind it (a grey fog wall in
 * front of a blue/orange horizon read as a wall, not as distance). Needs uZenith, uHorizon,
 * uGround, uSunDir, uSunColor, uNight.
 */
export const SKY_GRADIENT = /* glsl */ `
vec3 skyGradient(vec3 d) {
  float h = d.y;
  vec3 col = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.55));
  // warm glow toward the sun, strong only when it is low (dawn/dusk): at midday the full
  // glow washed a third of the sky out to white around the sun
  float sunAmt = max(dot(d, uSunDir), 0.0);
  float low = 0.3 + 0.7 * (1.0 - smoothstep(0.08, 0.45, uSunDir.y));
  col += uSunColor * pow(sunAmt, 8.0) * 0.35 * low * (1.0 - uNight);
  if (h < 0.0) col = mix(col, uGround, clamp(-h * 6.0, 0.0, 1.0));
  return col;
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
${SKY_GRADIENT}
uniform float uTime;
uniform float uCloud;
uniform float uSunVis;
uniform float uOvercast;
varying vec3 vDir;

// Integer hash of a lattice cell. The old fract(sin(dot(p, k)) * 43758.5) hash was the real
// cause of the "angular slabs": sin() of a ~1e4 argument amplifies a 1-ulp difference, and
// the GPU compiler evaluates hash(i + (1,0)) and the neighbour cell's hash(i') with
// different rounding, so the noise jumped along every lattice line.
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(floor(p))) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8) * (1.0 / 16777215.0);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}

// fbm with each octave rotated (~37 deg) so no two share lattice axes
float fbm(vec2 p) {
  const mat2 R = mat2(1.28, 0.96, -0.96, 1.28);
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = R * p + 1.7;
    a *= 0.5;
  }
  return s / 0.97;
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 col = skyGradient(d);

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
  // (1.6: just over the bloom threshold, so a small halo; at 2.0 the bloom washed a third
  // of the sky out around the sun)
  if (sd > 0.9985 && uSunDir.y > -0.05) col = mix(col, vec3(1.0, 0.95, 0.8) * 1.6, (1.0 - uNight * 0.8) * uSunVis);
  // moon disc with a darker mare blotch
  float md = dot(d, uMoonDir);
  if (md > 0.9992 && uNight > 0.0 && uSunVis > 0.5) {
    vec3 moon = vec3(0.85, 0.88, 0.95);
    vec3 side = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
    float off = dot(d - uMoonDir, side) * 800.0;
    if (off > 0.2) moon *= 0.72;
    col = mix(col, moon, uNight);
  }
  // Drifting clouds on a plane overhead. Value noise alone has visible lattice cells: two
  // octaves thresholded by a steep smoothstep drew its cell edges as long straight lines,
  // "angular slabs" across the sky. Rotated fbm with a domain warp breaks the lattice up,
  // and a wide threshold leaves soft edges for the post pass's ordered dither to turn
  // into pixel-art stipple. Undersides are shaded so the forms read as volumes.
  if (h > 0.0) {
    vec2 cp = d.xz / (h + 0.12) * 0.85 + vec2(uTime * 0.008, uTime * 0.003);
    vec2 warp = vec2(fbm(cp * 0.7 + 3.1), fbm(cp * 0.7 + 7.7)) - 0.5;
    float c = fbm(cp + warp * 1.3);
    float lo = 0.6 - uCloud * 0.3;
    float cover = smoothstep(lo, lo + 0.2, c);
    float core = smoothstep(lo + 0.08, lo + 0.34, c);
    vec3 lit = mix(mix(uHorizon, vec3(1.0), 0.25) * 1.08 + uSunColor * 0.12, uZenith * 0.7, uNight);
    vec3 cloudCol = mix(lit, lit * vec3(0.8, 0.82, 0.88), core);
    // rain clouds: darker, heavier undersides (a white sky over a downpour read as fog)
    cloudCol *= 1.0 - uOvercast * (0.22 + 0.2 * core);
    col = mix(col, cloudCol, cover * 0.8 * smoothstep(0.0, 0.18, h));
  }
  gl_FragColor = vec4(col, 1.0);
  gNormal = vec4(0.5, 0.5, 1.0, 0.0);
}`;

export class Sky {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  cloudiness = 0.2;
  /** 0..1 from the game weather (atmosphere.ts): raises the cloud cover */
  overcast = 0;

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
        uSunVis: { value: 1 },
        uOvercast: { value: 0 },
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
    u.uCloud.value = Math.max(this.cloudiness, 0.2 + 0.75 * this.overcast);
    u.uSunVis.value = sky.sunVisible;
    u.uOvercast.value = this.overcast;
    this.mesh.position.copy(camPos);
  }
}
