import type { Renderer } from '../render/renderer';

// Frames for the gallery's A/B and Matrix modes. The WebGL canvas has no preserveDrawingBuffer
// (it costs every frame in normal play), so a capture renders a frame and copies it onto a 2D
// canvas in the same task, before the browser composites and clears the buffer. The copy is
// the final image: world, first-person layer, post-processing; the HUD is DOM and not in it.

/** Render now and copy the frame, scaled to at most `maxW` px wide. */
export function captureFrame(renderer: Renderer, maxW = Infinity): HTMLCanvasElement {
  renderer.render(0);
  const src = renderer.three.domElement;
  const k = Math.min(1, maxW / src.width);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(src.width * k));
  out.height = Math.max(1, Math.round(src.height * k));
  const g = out.getContext('2d');
  if (!g) throw new Error('gallery: no 2D context for captures');
  // the image is already low-res pixel art upscaled: keep it crisp when shrinking
  g.imageSmoothingEnabled = k < 0.75;
  g.drawImage(src, 0, 0, out.width, out.height);
  return out;
}

/** Blob URL (for <img>) of a capture; JPEG keeps a matrix of 2500 px frames light. */
export function toUrl(c: HTMLCanvasElement, type: 'image/png' | 'image/jpeg' = 'image/png'): Promise<string> {
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('gallery: toBlob failed'))), type, 0.9));
}

/**
 * Share of pixels that differ visibly between two captures (0..1), compared at 320 px wide.
 * "Visibly": summed RGB difference over 24, i.e. more than dither noise.
 */
export function pixelDiff(a: HTMLCanvasElement, b: HTMLCanvasElement): number {
  const W = 320;
  const H = Math.max(1, Math.round((a.height / a.width) * W));
  const read = (c: HTMLCanvasElement) => {
    const t = document.createElement('canvas');
    t.width = W;
    t.height = H;
    const g = t.getContext('2d', { willReadFrequently: true })!;
    g.imageSmoothingEnabled = true;
    g.drawImage(c, 0, 0, W, H);
    return g.getImageData(0, 0, W, H).data;
  };
  const da = read(a), db = read(b);
  let n = 0;
  for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) n++;
  return n / (W * H);
}
