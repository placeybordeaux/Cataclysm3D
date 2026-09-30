import * as THREE from 'three';
import { normalOutputChunk, shared } from '../materials';
import { puddleUniforms } from '../props';

// Window and cabinet glass for the modelled look: a faint sky reflection (Fresnel: more at
// grazing angles, a sun glint) drawn as ordered-dither screen-door transparency in the
// low-res image, so it reads as glass (not an empty hole, not floating texels) and needs no
// sorting: it writes depth like everything else in the pixel pipeline. Double-sided.

let mat: THREE.ShaderMaterial | null = null;

export function glassMaterial(): THREE.ShaderMaterial {
  if (mat) return mat;
  mat = new THREE.ShaderMaterial({
    uniforms: { ...puddleUniforms, uCutFloor: shared.uCutFloor, uCutTo: shared.uCutTo },
    side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      attribute float cut;
      uniform float uCutFloor;
      uniform float uCutTo;
      varying vec3 vWorld;
      varying vec3 vN;
      void main() {
        vec3 p = position;
        // top-down cut mode lowers walls: glass inside them goes down with them
        bool inCut = p.y > uCutFloor + 0.01 && p.y < uCutFloor + 3.0;
        if (cut > 0.5 && inCut) p.y = min(p.y, uCutTo);
        vec4 w = modelMatrix * vec4(p, 1.0);
        vWorld = w.xyz;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      layout(location = 1) out highp vec4 gNormal;
      uniform vec3 uZenith, uHorizon, uSunDir, uSunColor;
      uniform float uNight;
      varying vec3 vWorld;
      varying vec3 vN;
      float bayer4(vec2 p) {
        ivec2 i = ivec2(mod(p, 4.0));
        int k = i.x + i.y * 4;
        int m[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5);
        return (float(m[k]) + 0.5) / 16.0;
      }
      void main() {
        vec3 v = normalize(cameraPosition - vWorld);
        vec3 n = normalize(vN);
        if (dot(n, v) < 0.0) n = -n;
        float fres = pow(1.0 - clamp(dot(n, v), 0.0, 1.0), 3.0);
        vec3 r = reflect(-v, n);
        vec3 sky = mix(uHorizon, uZenith, pow(clamp(r.y, 0.0, 1.0), 0.6));
        float day = 1.0 - uNight;
        vec3 col = mix(vec3(0.16, 0.2, 0.22), sky, 0.55) * (0.25 + 0.75 * day);
        col += uSunColor * pow(max(dot(r, uSunDir), 0.0), 60.0) * 1.5 * day;
        // diagonal streaks: the classic pixel-art "this is glass" cue, fixed to the pane
        float streak = step(0.8, fract((vWorld.x + vWorld.z) * 2.2 + vWorld.y * 2.2));
        float a = 0.2 + 0.45 * fres + 0.25 * streak;
        if (bayer4(gl_FragCoord.xy) > a) discard;
        gl_FragColor = vec4(col + streak * 0.12 * (0.3 + 0.7 * day), 1.0);
        vec3 normal = n;
        ${normalOutputChunk(true, 0)}
      }`,
  });
  (mat.userData as { mrt?: boolean }).mrt = true;
  return mat;
}
