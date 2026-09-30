// Shot list for the official-screenshot recreations (recreate-scenes.js). Used by
//   blog-shots.ts --shots notes/blog-post/scripts/recreate-shots.js --gpu --raw <dir>
// Per scene: a straight-down view over the original's panel (rc-<scene>-top) and a first-person
// view from the ground in the same place (rc-<scene>-fp). Compose the comparisons afterwards with
// recreate-compose.py, which crops the top views from the full-size PNGs in --raw.
// Game time is paused before capture (after the scene has settled) so short-lived fields like
// electricity and the fire's smoke hold still while the chunk meshes rebuild.

const HIDE = `{ const hide = (root) => { for (const el of root.children) { if (el.id === 'view') continue; if (el.querySelector('#view')) hide(el); else el.style.visibility = 'hidden'; } }; hide(document.body); c.renderer.hideViewmodel = true; }`;
const SETTLE = `c.settle(); await new Promise((r) => setTimeout(r, 1800)); c.settle(); await new Promise((r) => setTimeout(r, 600));`;

const SCENES = ['bn_fire', 'bn_horde', 'bn_lab', 'bn_temple', 'dda_street', 'dda_forest', 'dda_farm', 'dda_lab'];
const HEROES = new Set(['bn_fire', 'bn_horde', 'dda_street', 'dda_farm']);

/** @type {import('./shots.js').Shot[]} */
export const shots = SCENES.flatMap((s) => [
  {
    id: `rc-${s}-top`, note: `${s}: top-down over the original's panel`,
    js: `c.game.paused = false; c.godMode(true); const r = recreate.stamp('${s}'); ${SETTLE} const t = recreate.top('${s}'); ${SETTLE} c.game.paused = true; recreate.clean('${s}'); c.settle(); await new Promise((r) => setTimeout(r, 1500)); c.settle(); ${HIDE} return { r, t };`,
  },
  {
    id: `rc-${s}-fp`, hero: HEROES.has(s), note: `${s}: the same place in first person`,
    js: `c.game.paused = false; const f = recreate.fp('${s}'); ${SETTLE} c.game.paused = true; recreate.clean('${s}'); c.settle(); await new Promise((r) => setTimeout(r, 1500)); c.settle(); ${HIDE} return f;`,
  },
]).concat(
  // the "full" look for the hero views, to compare with the default (voxel)
  ['bn_fire', 'dda_street'].flatMap((s) => [{
    id: `rc-${s}-fp-full`, params: 'look=full', note: `${s}: first person, full look`,
    js: `c.game.paused = false; c.godMode(true); recreate.stamp('${s}'); ${SETTLE} const f = recreate.fp('${s}'); ${SETTLE} c.game.paused = true; recreate.clean('${s}'); c.settle(); await new Promise((r) => setTimeout(r, 1500)); c.settle(); ${HIDE} return f;`,
  }]),
);
