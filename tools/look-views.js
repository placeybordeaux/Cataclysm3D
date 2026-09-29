// The six comparison viewpoints for docs/LOOKS.md (seed=1). Evaluated in the page by
// tools/look-shots.sh: defines window.lookView(name) which sets the scene up and settles.
// Kept as plain JS so it can be pasted into `drive.ts eval` too.
window.lookViews = ['shelter', 'street', 'house', 'forest', 'night', 'top'];
window.lookView = async (name) => {
  const c = window.cdda;
  c.godMode(true);
  c.setWeather('clear');
  c.flashlight(false);
  c.setCameraMode('first');
  // hide every DOM overlay: the comparison is about the 3D image
  for (const el of document.body.querySelectorAll('body > *')) if (el.tagName !== 'CANVAS' && !el.querySelector('canvas')) el.style.visibility = 'hidden';
  const s = c.startLocation();
  const town = c.cities().filter((t) => t.size >= 4).sort((a, b) => Math.hypot(a.x - s.omx, a.y - s.omy) - Math.hypot(b.x - s.omx, b.y - s.omy))[0];
  if (name === 'shelter') {
    c.setHour(11);
    c.teleport(s.x + 0.5, s.y + 0.5, s.z);
    c.look(200, -8);
  } else if (name === 'street') {
    c.setHour(15.5);
    c.teleportOmt(town.x, town.y, 0, 12, 20);
    c.look(0, -4);
  } else if (name === 'house') {
    c.setHour(11);
    c.teleportOmt(town.x, town.y);
    const h = c.findOmt('house', 20);
    c.teleportOmt(h.x, h.y, 0, 12, 12);
    c.look(-120, -6);
  } else if (name === 'forest') {
    c.setHour(15);
    const f = c.findOmt('forest', 60);
    c.teleportOmt(f.x, f.y, 0, 12, 22);
    c.look(-20, -3);
  } else if (name === 'night') {
    c.setHour(23.2);
    c.teleportOmt(town.x, town.y, 0, 12, 20);
    c.look(0, -6);
    c.flashlight(true);
  } else if (name === 'top') {
    c.setHour(13);
    c.teleportOmt(town.x, town.y);
    c.setCameraMode('top');
    c.renderer.rig.topDistance = 40;
  } else if (name.startsWith('at:')) {
    // probe form for picking viewpoints: at:<omt text|town>:<lx>:<ly>:<yaw>:<pitch>:<hour>[:top]
    const [, what, lx, ly, yaw, pitch, hour, mode] = name.split(':');
    c.setHour(Number(hour));
    c.teleportOmt(town.x, town.y);
    const o = what === 'town' ? town : c.findOmt(what, 40);
    c.teleportOmt(o.x, o.y, 0, Number(lx), Number(ly));
    c.look(Number(yaw), Number(pitch));
    if (mode === 'top') { c.setCameraMode('top'); c.renderer.rig.topDistance = 60; }
  } else throw new Error(`unknown view ${name}`);
  c.settle();
  // let the light map, exposure and shadows converge
  await new Promise((r) => setTimeout(r, 1500));
  c.settle();
  return name;
};
