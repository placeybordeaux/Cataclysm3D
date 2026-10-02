// Deliberately separate from the game's GLSL/MRT pipeline: this measures backend
// submission overhead, not the cost or appearance of a migrated game renderer.
import * as GL from 'three';
import * as GPU from 'three/webgpu';

const params = new URLSearchParams(location.search);
const mode = params.get('backend') ?? 'webgl';
const instanced = params.get('batch') === '1';
const count = Number(params.get('count') ?? 1000);
const ratio = Number(params.get('ratio') ?? 1);
const THREE = mode === 'webgl' ? GL : GPU;
const renderer = mode === 'webgl'
  ? new GL.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' })
  : new GPU.WebGPURenderer({ antialias: false, forceWebGL: mode === 'webgl-fallback' });
const result = window as unknown as { probeResult?: unknown; probeError?: string };
try {
  if (renderer instanceof GPU.WebGPURenderer) {
    await renderer.init();
    if (mode === 'webgpu' && !(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('WebGPU unavailable: automatic WebGL fallback rejected');
  }
  renderer.setPixelRatio(ratio);
  renderer.setSize(innerWidth, innerHeight);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);
  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 200);
  camera.position.set(0, 0, 55);
  const geometry = new THREE.BoxGeometry(0.7, 0.7, 0.7);
  const material = new THREE.MeshBasicMaterial({ color: 0x76ad87 });
  const matrix = new THREE.Matrix4();
  const side = Math.ceil(Math.sqrt(count));
  const batch = instanced ? new THREE.InstancedMesh(geometry, material, count) : null;
  for (let i = 0; i < count; i++) {
    const x = (i % side - side / 2) * 1.1, y = (Math.floor(i / side) - side / 2) * 1.1;
    if (batch) batch.setMatrixAt(i, matrix.makeTranslation(x, y, 0));
    else {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(x, y, 0);
      mesh.updateMatrix();
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
    }
  }
  if (batch) { batch.instanceMatrix.needsUpdate = true; scene.add(batch); }
  const cpu: number[] = [], intervals: number[] = [];
  let last = 0;
  for (let i = 0; i < 210; i++) {
    const now = await new Promise<number>((resolve) => requestAnimationFrame(resolve));
    const start = performance.now();
    renderer.render(scene, camera);
    const elapsed = performance.now() - start;
    if (i >= 60) { cpu.push(elapsed); intervals.push(now - last); }
    last = now;
  }
  const stats = (a: number[]) => {
    const sorted = [...a].sort((a, b) => a - b);
    return { mean: a.reduce((a, b) => a + b, 0) / a.length, p50: sorted[Math.floor(a.length * .5)], p95: sorted[Math.floor(a.length * .95)] };
  };
  result.probeResult = { mode, instanced, count, ratio, canvas: [renderer.domElement.width, renderer.domElement.height], cpuSubmitMs: stats(cpu), frameIntervalMs: stats(intervals), userAgent: navigator.userAgent };
  renderer.dispose(); geometry.dispose(); material.dispose();
} catch (e) { result.probeError = String(e); renderer.dispose(); }
