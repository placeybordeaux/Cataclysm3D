// A top-down "classic Cataclysm tiles" view of the live game map, drawn with the same UltiCa
// atlas the 3D renderer uses, into a full-window 2D canvas over the game. Evaluated in the page
// by blog-shots.ts (shots.js "tiles" entries): defines window.tilesTopDown(opts).
//
// It is an approximation of what the 2D game draws, for side-by-side comparisons only:
// terrain, then furniture, then the top item, then monsters and NPCs, 32 px per tile, with
// multitile connections from same-id / wall-group neighbours (CDDA's connect groups are richer:
// fences, rails and counters that connect to other ids fall back to the unconnected sprite).
// No lighting, no vehicles (vehicle parts are their own multitile system), no fields.
window.tilesTopDown = ({ cx, cy, z = 0, cols = 60, rows = 34, scale = 1 } = {}) => {
  const c = window.cdda, m = c.game.map, data = c.game.data;
  const atlas = c.renderer.source.atlas;
  if (!atlas) throw new Error('tilesTopDown: renderer is not on the atlas texture source');
  const looksLike = (id) => data.terrain[id]?.looks_like ?? data.furniture[id]?.looks_like ?? data.items[id]?.looks_like ?? data.monsters?.[id]?.looks_like;
  const TS = 32 * scale;
  let cv = document.getElementById('blog-tiles');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'blog-tiles';
    Object.assign(cv.style, { position: 'fixed', left: '0', top: '0', zIndex: 99999, imageRendering: 'pixelated', background: '#000' });
    document.body.appendChild(cv);
  }
  cv.width = window.innerWidth;
  cv.height = window.innerHeight;
  cv.style.width = `${cv.width}px`;
  cv.style.height = `${cv.height}px`;
  cv.style.display = '';
  const g = cv.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.fillStyle = '#000';
  g.fillRect(0, 0, cv.width, cv.height);
  const x0 = Math.round(cx - cols / 2), y0 = Math.round(cy - rows / 2);
  // screen offset so (cx, cy) lands mid-canvas even when cols*TS != width
  const offX = Math.round(cv.width / 2 - (cx - x0) * TS), offY = Math.round(cv.height / 2 - (cy - y0) * TS);
  const draw = (fr, tx, ty) => {
    if (!fr) return;
    const px = offX + (tx - x0) * TS, py = offY + (ty - y0) * TS;
    g.save();
    g.translate(px + TS / 2, py + TS / 2);
    if (fr.rotate) g.rotate((fr.rotate * Math.PI) / 2);
    g.drawImage(fr.image, fr.px.x, fr.px.y, fr.px.w, fr.px.h, -TS / 2 + fr.ox * scale, -TS / 2 + fr.oy * scale, fr.w * scale, fr.h * scale);
    g.restore();
  };
  const wallish = (t) => t && (t.flags?.includes('WALL') || t.flags?.includes('CONNECT_TO_WALL') || t.flags?.includes('DOOR') || t.flags?.includes('WINDOW') || /^t_(wall|door|window)/.test(t.id));
  const conn = (x, y, get, grp) => {
    const me = get(x, y);
    const same = (dx, dy) => { const o = get(x + dx, y + dy); return o && (o.id === me.id || (grp && grp(me) && grp(o))); };
    return (same(0, -1) ? 1 : 0) | (same(1, 0) ? 2 : 0) | (same(0, 1) ? 4 : 0) | (same(-1, 0) ? 8 : 0);
  };
  // CONN bit order from src/render/atlasIndex.ts (N=1? checked below)
  const CONN = c.CONN ?? { N: 1, E: 2, S: 4, W: 8 };
  const toConn = (b) => (b & 1 ? CONN.N : 0) | (b & 2 ? CONN.E : 0) | (b & 4 ? CONN.S : 0) | (b & 8 ? CONN.W : 0);
  const ter = (x, y) => m.terAt(x, y, z);
  const furn = (x, y) => m.furnAt(x, y, z);
  const seedOf = (x, y) => ((x * 73856093) ^ (y * 19349663)) >>> 0;
  let missing = new Set();
  for (let ty = y0; ty < y0 + rows; ty++)
    for (let tx = x0; tx < x0 + cols; tx++) {
      const t = ter(tx, ty);
      const hit = atlas.lookupWithLooksLike(t.id, looksLike, { connections: toConn(conn(tx, ty, ter, wallish)), variantSeed: seedOf(tx, ty) });
      if (!hit) missing.add(t.id);
      draw(hit?.bg, tx, ty);
      draw(hit?.fg, tx, ty);
      const f = furn(tx, ty);
      if (f && f.id !== 'f_null') {
        const fh = atlas.lookupWithLooksLike(f.id, looksLike, { connections: toConn(conn(tx, ty, furn)), variantSeed: seedOf(tx, ty) });
        if (!fh) missing.add(f.id);
        draw(fh?.bg, tx, ty);
        draw(fh?.fg, tx, ty);
      }
      const items = m.itemsAt(tx, ty, z);
      if (items.length && !(f && f.id !== 'f_null')) {
        const ih = atlas.lookupWithLooksLike(items[items.length - 1].typeId, looksLike, {});
        draw(ih?.fg, tx, ty);
      }
    }
  for (const mon of c.monsterSystem?.all ?? []) {
    if (mon.z !== z || mon.dead) continue;
    const tx = Math.floor(mon.x), ty = Math.floor(mon.y);
    if (tx < x0 || ty < y0 || tx >= x0 + cols || ty >= y0 + rows) continue;
    const h = atlas.lookupWithLooksLike(mon.type.id, looksLike, { variantSeed: mon.uid ?? 1 });
    draw(h?.fg, tx, ty);
  }
  const p = c.game.player;
  const ph = atlas.lookup('player_male') ?? atlas.lookup('player_female');
  if (ph && p.z === z) draw(ph.fg, Math.floor(p.x), Math.floor(p.y));
  return { x0, y0, cols, rows, missing: [...missing].slice(0, 20) };
};
window.tilesHide = () => {
  const cv = document.getElementById('blog-tiles');
  if (cv) cv.style.display = 'none';
};
