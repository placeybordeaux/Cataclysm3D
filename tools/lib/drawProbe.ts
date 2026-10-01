// Page-side draw-call census (tools/perf-bench.ts --calls, docs/PERF.md): wraps three's
// renderBufferDirect for one frame and attributes every draw call to what drew it — the main
// pass or a shadow map, and the scene group (chunks by level relative to the player, sprites,
// characters, grass, skyline...). Installs window.__drawCensus(): Promise<census>.
export const DRAW_PROBE = `(() => {
  const r = cdda.renderer;
  const three = r.three;
  const LH = 2.6;
  const cat = (o) => {
    let top = o, chunk = null;
    while (top.parent && top.parent !== r.scene) {
      if (/^chunk /.test(top.name)) chunk = top;
      top = top.parent;
    }
    if (chunk) {
      const z = Number(chunk.name.split(' ')[1].split(',')[2]);
      const dz = z - cdda.game.player.z;
      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const what = window.__drawDetail ? ' ' + (o.parent === chunk ? '' : (o.parent?.name || 'sub') + '/') + (o.name || (mat?.type ?? '') + (mat?.map ? '#' + mat.map.id : '')) : '';
      return 'chunks dz' + (dz > 0 ? '+' : '') + dz + (o.isInstancedMesh ? ' instanced' : o.isPoints ? ' points' : '') + what;
    }
    return (top.name || top.type) + (o.isInstancedMesh ? ' (instanced)' : '');
  };
  window.__drawCensus = () => new Promise((resolve) => {
    const counts = {};
    const orig = three.renderBufferDirect.bind(three);
    let pass = 'main';
    const origShadow = three.shadowMap.render.bind(three.shadowMap);
    three.shadowMap.render = (...a) => { pass = 'shadow'; try { return origShadow(...a); } finally { pass = 'main'; } };
    three.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
      const k = pass + ' | ' + cat(object);
      const c = (counts[k] ??= { calls: 0, tris: 0 });
      c.calls++;
      const n = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0;
      c.tris += Math.round(n / 3) * (object.isInstancedMesh ? object.count : 1);
      return orig(camera, scene, geometry, material, object, group);
    };
    // force every shadow map to redraw in the measured frame (the census shows its cost)
    r.lights.shadows.invalidate();
    requestAnimationFrame(() => {
      three.renderBufferDirect = orig;
      three.shadowMap.render = origShadow;
      resolve(counts);
    });
  });
})()`;
