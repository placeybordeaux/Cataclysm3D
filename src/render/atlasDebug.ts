// ?debug=atlas — a sprite sheet rendered from the compiled atlas through three.js with the
// game's texture settings, to eyeball crispness, offsets, multitile connection logic, and
// seams/bleeding. Replaces the normal boot (main.ts branches before loading the game).
// window.cdda = { ready, atlas, layout } for tools/shot.ts.

import * as THREE from 'three';
import { loadAtlas, CONN, pointSeed, type Atlas, type AtlasHit, type FrameRef, type LookupOpts } from './atlas';

type Cell = { hit: AtlasHit | null; label?: string };

// A small map exercising multitile connections: walls (#), floor (.), door (+), window (w),
// table (T), counter (C) and grass outside.
const ROOM = [
  '~~~~~~~~~~~',
  '~#####w##~~',
  '~#...#..#~~',
  '~#.TT+..#~~',
  '~#...#CC#~~',
  '~##+######~',
  '~~~~~~~~~#~',
];
const ROOM_KEY: Record<string, { ter: string; furn?: string }> = {
  '~': { ter: 't_grass' },
  '#': { ter: 't_wall' },
  '.': { ter: 't_floor' },
  '+': { ter: 't_door_c' },
  w: { ter: 't_window' },
  T: { ter: 't_floor', furn: 'f_table' },
  C: { ter: 't_floor', furn: 'f_counter' },
};

export async function runAtlasDebug(canvas: HTMLCanvasElement): Promise<void> {
  const atlas = await loadAtlas();
  const scale = Number(new URLSearchParams(location.search).get('scale') ?? 2);
  const W = window.innerWidth, H = window.innerHeight;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202028);
  // Pixel-space ortho camera, y down.
  const camera = new THREE.OrthographicCamera(0, W, 0, -H, -10, 10);

  const ui = document.getElementById('ui')!;
  const label = (text: string, x: number, y: number, color = '#ccc') => {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = `position:absolute;left:${x}px;top:${y}px;color:${color};font:12px monospace;white-space:nowrap;`;
    ui.appendChild(d);
  };

  const materials = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
  const mat = (t: THREE.Texture) => {
    let m = materials.get(t);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: t, transparent: true, alphaTest: 0.01, depthTest: false, depthWrite: false });
      materials.set(t, m);
    }
    return m;
  };
  let order = 0;
  // Draw a sprite for the 32×32 cell whose top-left is at (cx, cy) px on screen.
  const drawRef = (r: FrameRef, cx: number, cy: number, s: number) => {
    const g = new THREE.PlaneGeometry(r.w * s, r.h * s);
    const uv = g.getAttribute('uv') as THREE.BufferAttribute;
    // PlaneGeometry uv order: (0,1) (1,1) (0,0) (1,0)
    uv.setXY(0, r.uv.u0, r.uv.v1);
    uv.setXY(1, r.uv.u1, r.uv.v1);
    uv.setXY(2, r.uv.u0, r.uv.v0);
    uv.setXY(3, r.uv.u1, r.uv.v0);
    const m = new THREE.Mesh(g, mat(r.texture));
    m.position.set(cx + (r.ox + r.w / 2) * s, -(cy + (r.oy + r.h / 2) * s), 0);
    m.rotation.z = (-r.rotate * Math.PI) / 2;
    m.renderOrder = order++;
    scene.add(m);
  };
  const draw = (hit: AtlasHit | null, cx: number, cy: number, s = scale) => {
    if (!hit) return;
    if (hit.bg) drawRef(hit.bg, cx, cy, s);
    if (hit.fg) drawRef(hit.fg, cx, cy, s);
  };

  const TS = atlas.tileSize * scale;
  const PADX = 12;
  let y = 8;
  const layout: Record<string, { x: number; y: number }> = {};
  const row = (title: string, cells: Cell[], rowH = 2) => {
    label(title, PADX, y);
    y += 16;
    // Tall sprites extend upward from the cell; leave headroom.
    const top = y + TS * (rowH - 1);
    cells.forEach((c, i) => {
      const x = PADX + i * (TS + 6);
      draw(c.hit, x, top);
      if (c.label) {
        label(c.label.slice(0, 11), x, top + TS + 1, c.hit ? '#9a9' : '#e66');
        layout[c.label] = { x, y: top };
      }
    });
    y = top + TS + 18;
  };
  const L = (id: string, opts?: LookupOpts): Cell => ({ hit: atlas.lookup(id, opts), label: id });

  // --- the room: every cell resolves its multitile subtile from same-terrain neighbours
  label('multitile room (connections computed from neighbours, seasonal grass = winter at right)', PADX, y);
  y += 16;
  const roomY = y;
  const at = (x: number, yy: number) => ROOM[yy]?.[x];
  for (const season of ['summer', 'winter'] as const) {
    const ox = PADX + (season === 'winter' ? (ROOM[0].length + 1) * TS : 0);
    for (let ry = 0; ry < ROOM.length; ry++)
      for (let rx = 0; rx < ROOM[ry].length; rx++) {
        const k = ROOM_KEY[at(rx, ry)];
        const same = (dx: number, dy: number) => {
          const n = at(rx + dx, ry + dy);
          // walls connect to doors/windows like CDDA's WALL connect group
          const grp = (c?: string) => (c === '#' || c === '+' || c === 'w' ? '#' : c === 'T' || c === 'C' || c === '.' ? '.' : c);
          return n !== undefined && grp(n) === grp(at(rx, ry));
        };
        const conn = (same(0, -1) ? CONN.N : 0) | (same(1, 0) ? CONN.E : 0) | (same(0, 1) ? CONN.S : 0) | (same(-1, 0) ? CONN.W : 0);
        const seed = pointSeed(rx, ry);
        draw(atlas.lookup(k.ter, { connections: conn, variantSeed: seed, season }), ox + rx * TS, roomY + ry * TS);
        if (k.furn) {
          const fc = (at(rx - 1, ry) === at(rx, ry) ? CONN.W : 0) | (at(rx + 1, ry) === at(rx, ry) ? CONN.E : 0);
          draw(atlas.lookup(k.furn, { connections: fc, variantSeed: seed }), ox + rx * TS, roomY + ry * TS);
        }
      }
    // A zombie and an item standing in the room
    draw(atlas.lookup('mon_zombie', { variantSeed: season === 'winter' ? 3 : 1 }), ox + 7 * TS, roomY + 3 * TS);
    draw(atlas.lookup('hammer'), ox + 2 * TS, roomY + 2 * TS);
  }
  y = roomY + ROOM.length * TS + 8;

  const w = atlas.index.tiles.t_wall.multitile!;
  row('t_wall subtiles (every rotation) + t_connection/corner/edge/end_piece', [
    L('t_wall'),
    ...(['center', 'edge', 'corner', 't_connection', 'end_piece', 'unconnected'] as const).flatMap((k) =>
      (w[k]?.fg?.[0].sprites ?? []).map((f, i) => ({ hit: { id: k, fg: atlas.frameRef(f) }, label: `${k}${i}` })),
    ),
  ], 1);
  row('terrain & furniture', [
    'f_chair', 'f_table', 'f_fridge', 'f_bed', 'f_toilet', 'f_bookcase', 'f_sofa', 'f_locker', 'f_dumpster', 't_tree',
    't_tree_pine', 't_shrub', 't_door_o', 't_window_domestic',
  ].map((id) => L(id)), 3);
  row('monsters (32x48, 64x64, 96x96 frames)', [
    ...[1, 2, 3, 4, 5].map((s) => ({ hit: atlas.lookup('mon_zombie', { variantSeed: s * 977 }), label: `mon_zombie#${s}` })),
    ...['mon_zombie_fat', 'mon_zombie_child', 'mon_zombie_soldier', 'mon_zombie_brute', 'mon_zombie_dog', 'mon_dog', 'mon_deer', 'mon_moose',
      'mon_zombie_hulk', 'mon_triffid'].map((id) => L(id)),
  ], 3);
  row('items (20x20 small sheet + 32x32)', [
    'hammer', '2x4', 'glock_19', 'can_beans', 'backpack', 'jeans', 'tshirt', 'corpse', 'fd_fire', 'fd_smoke', 'fd_blood',
  ].map((id) => L(id)), 1);
  row('ASCII fallback glyphs (CDDA colours) + rotation of single sprites', [
    { hit: { id: '@', fg: atlas.glyph('@', 'c_white') }, label: '@ white' },
    { hit: { id: 'Z', fg: atlas.glyph('Z', 'c_green') }, label: 'Z green' },
    { hit: { id: '#', fg: atlas.glyph('#', 'c_light_gray') }, label: '# lt gray' },
    { hit: { id: '+', fg: atlas.glyph('+', 'c_brown') }, label: '+ brown' },
    { hit: { id: '~', fg: atlas.glyph('~', 'c_light_blue') }, label: '~ lt blue' },
    { hit: { id: '&', fg: atlas.glyph('&', 'c_red') }, label: '& red' },
    { hit: { id: 'd', fg: atlas.glyph('d', 'c_yellow') }, label: 'd yellow' },
    { hit: { id: '│', fg: atlas.glyph('LINE_XOXO', 'c_cyan') }, label: 'LINE_XOXO' },
    { hit: atlas.lookupOrGlyph('no_such_monster', 'M', 'c_pink'), label: 'missing→M' },
    ...[0, 1, 2, 3].map((r) => ({ hit: atlas.lookup('hammer', { rotation: r, alwaysRotate: true }), label: `hammer r${r}` })),
  ], 1);

  // Seam/bleed stress test: grass/floor tiles abutting at a non-integer scale with a
  // sub-pixel offset. With edge extrusion there must be no dark lines between tiles.
  label('bleed test: t_floor / t_grass tiled at scale 2.37, +0.4px offset', PADX, y);
  y += 16;
  const s2 = 2.37, t2 = atlas.tileSize * s2;
  for (let yy = 0; yy < 3; yy++)
    for (let xx = 0; xx < 12; xx++)
      draw(atlas.lookup(xx < 6 ? 't_floor' : 't_grass', { connections: 15, variantSeed: pointSeed(xx, yy) }), PADX + 0.4 + xx * t2, y + 0.4 + yy * t2, s2);
  y += 3 * t2 + 8;

  // Glyph textures are canvas-backed: redraw them after all glyphs were generated.
  renderer.render(scene, camera);
  const loop = () => {
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  (window as any).cdda = { ready: true, atlas, layout, contentHeight: y };
}
