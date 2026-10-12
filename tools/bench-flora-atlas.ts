// First-use flora palette upload spike (docs/IMPLEMENTATION_GAPS.md, docs/FLORA.md "Known
// gaps"). Walking into a fresh biome/season paints many distinct leaf/bark/fringe/twig
// palettes into FloraAtlas's single shared 2048^2 page (src/render/floraArt.ts). Before the
// fix, every new paint called `texture.needsUpdate = true` with no update ranges queued, so
// Three re-uploads the WHOLE page (texSubImage2D of 2048*2048*4 bytes) the next time it
// renders -- not just the handful of rows the paint actually touched. This counts bytes
// *requested* of the GPU (what WebGLTextures.updateTexture will texSubImage2D), not GPU
// time; it needs no WebGL context. Run inside Nix/heavy:
// nix-shell --run '~/claude-stuff/bin/heavy --mem 1 --name flora-atlas-bench -- npx tsx tools/bench-flora-atlas.ts'
import { FloraAtlas, paintBark, paintFringe, paintLeaves, paintNeedles, paintTwigs, type BarkKind, type Ramp4 } from '../src/render/floraArt';
import type { RGB } from '../src/render/colors';

const PAGE = 2048;
const FULL_PAGE_BYTES = PAGE * PAGE * 4;
const BARKS: BarkKind[] = ['furrow', 'birch', 'plates', 'smooth'];

/** A distinct-looking ramp/bark per index, standing in for a distinct species x season
 *  sprite (what actually varies `pal.key` in flora.ts's real paletteOf()). */
function paletteOf(i: number): { leaf: Ramp4; bark: RGB } {
  const h = (i * 47) % 360, lift = (v: number) => Math.round(40 + (v / 360) * 140 + (i % 5) * 6);
  const leaf: Ramp4 = [[20, lift(h) * 0.5, 15], [40, lift(h), 30], [60, lift(h) * 1.3, 45], [90, lift(h) * 1.5, 60]];
  const bark: RGB = [60 + (i % 7) * 8, 45 + (i % 5) * 6, 30 + (i % 3) * 5];
  return { leaf, bark };
}

/** One tree's atlas requests, mirroring flora.ts buildFloraSteps: leaf + bark always, fringe
 *  for near crowns, twigs for bare/dead crowns -- 2-4 distinct keys per newly-seen species. */
function paintTree(atlas: FloraAtlas, i: number, bare: boolean): void {
  const { leaf, bark } = paletteOf(i);
  const barkKind = BARKS[i % BARKS.length];
  const conifer = i % 6 === 0;
  atlas.frame(`leaf|${conifer}|${i}`, true, () => (conifer ? paintNeedles(leaf, 11) : paintLeaves(leaf, 7)));
  atlas.frame(`bark|${barkKind}|${i}`, true, () => paintBark(barkKind, bark, 3));
  if (!bare) atlas.frame(`fringe|${i}`, false, () => paintFringe(leaf, 7));
  else atlas.frame(`twig|${i}`, false, () => paintTwigs(bark, 9));
}

function runSpike(treeCount: number): number {
  const atlas = new FloraAtlas(); // partialUpload defaults true: the fixed path
  let requestedBytes = 0;
  for (let i = 0; i < treeCount; i++) {
    const before = atlas.texture.updateRanges.length;
    paintTree(atlas, i, i % 5 === 0);
    requestedBytes += atlas.texture.updateRanges.slice(before).reduce((s, r) => s + r.count, 0);
    atlas.texture.clearUpdateRanges();
  }
  return requestedBytes;
}

/** Full-mode total bytes depend on render cadence (Three dedupes to one upload per render,
 *  however many needsUpdate calls happened since); report both ends of that range. */
function fullModeBytes(treeCount: number, distinctEvents: number): { worst: number; best: number } {
  return { worst: distinctEvents * FULL_PAGE_BYTES, best: treeCount > 0 ? FULL_PAGE_BYTES : 0 };
}

for (const treeCount of [12, 60]) {
  // Count how many of the trees introduce at least one genuinely new atlas key, by
  // running once against a disposable atlas (same for both modes -- it's about the keys,
  // not the upload strategy).
  const probe = new FloraAtlas();
  let distinctEvents = 0;
  for (let i = 0; i < treeCount; i++) {
    const before = probe.texture.updateRanges.length;
    paintTree(probe, i, i % 5 === 0);
    if (probe.texture.updateRanges.length > before) distinctEvents++;
    probe.texture.clearUpdateRanges();
  }
  const requestedBytes = runSpike(treeCount);
  const full = fullModeBytes(treeCount, distinctEvents);
  console.log(JSON.stringify({
    treeCount,
    distinctPaletteEvents: distinctEvents,
    partialUploadRequestedBytes: requestedBytes,
    fullUpload_oneRenderPerTree_bytes: full.worst,
    fullUpload_oneRenderTotal_bytes: full.best,
    reductionVsWorstCase: `${(100 * (1 - requestedBytes / full.worst)).toFixed(3)}%`,
    reductionVsBestCase: `${(100 * (1 - requestedBytes / full.best)).toFixed(3)}%`,
  }));
}
