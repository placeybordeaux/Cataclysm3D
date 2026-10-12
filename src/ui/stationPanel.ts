import type { Game } from '../game/game';
import { chassisBodyRect } from '../game/chassis';
import { stationRole, type Station } from '../game/vehwalk';
import type { Vehicle } from '../game/vehicle';
import type { Renderer } from '../render/renderer';
import { c, cssColor, getUiRoot } from './framework';
import { has, turretGun } from '../game/vehicle';
import { aimError, ammoChoices, ammoPref, turretAim, turretAt, turretSession, turretStatus } from '../game/turret';
import { currentMode, gunModes, isJammed, upsDrain } from '../game/gunmods';

// Where you are inside a tank, RV or bus (game/vehwalk.ts stations), drawn so it's never a
// guess: a small top-down plan of the vehicle (front up) with every station, yours lit, and
// the W/A/S/D letters on the stations those keys would take you to *as you're looking now*
// (hops follow the camera, so the letters move as you turn your head). Under it, the list of
// stations by crew role with what each one is for. Cars (in-or-out, no stations to hop
// between) don't get it.

const W = 132, H = 150, PAD = 14;

function plan(v: Vehicle, list: Station[], cur: number, keys: { key: string; to: number | 'out' }[]): string {
  // The drawn body when it has one, else the whole part grid (frame hulls: the Abrams' stations
  // only span its turret, so their spread would draw the tank sideways).
  const body = chassisBodyRect(v);
  const xs = v.parts.map((p) => p.mx), ys = v.parts.map((p) => p.my);
  const x0 = body ? body.x0 : Math.min(...xs) - 0.5, x1 = body ? body.x1 : Math.max(...xs) + 0.5;
  const y0 = body ? body.y0 : Math.min(...ys) - 0.5, y1 = body ? body.y1 : Math.max(...ys) + 0.5;
  // Mount space: +x is the vehicle's front (drawn up), +y its right side (drawn right).
  const k = Math.min((W - 2 * PAD) / Math.max(0.5, y1 - y0), (H - 2 * PAD) / Math.max(0.5, x1 - x0));
  const ox = (W - (y1 - y0) * k) / 2, oy = (H - (x1 - x0) * k) / 2;
  const px = (y: number) => ox + (y - y0) * k, py = (x: number) => oy + (x1 - x) * k;
  const fg = cssColor('c_light_gray'), dim = cssColor('c_dark_gray'), hi = cssColor('c_yellow'), cyan = cssColor('c_light_cyan');
  const parts: string[] = [];
  parts.push(`<rect x="${px(y0).toFixed(1)}" y="${py(x1).toFixed(1)}" width="${((y1 - y0) * k).toFixed(1)}" height="${((x1 - x0) * k).toFixed(1)}" rx="4" style="fill:rgba(255,255,255,.06);stroke:${dim}"/>`);
  parts.push(`<text x="${W / 2}" y="9" style="fill:${dim}" font-size="8" text-anchor="middle">▲ front</text>`);
  list.forEach((s, i) => {
    const X = px(s.y), Y = py(s.x), on = i === cur;
    const r = s.kind === 'hatch' ? 5 : 6;
    const shape = s.kind === 'hatch'
      ? `<rect x="${(X - r).toFixed(1)}" y="${(Y - r).toFixed(1)}" width="${2 * r}" height="${2 * r}" style="fill:${on ? hi : 'none'};stroke:${on ? hi : fg}"/>`
      : `<circle cx="${X.toFixed(1)}" cy="${Y.toFixed(1)}" r="${r}" style="fill:${on ? hi : 'none'};stroke:${on ? hi : fg}"/>`;
    parts.push(shape, `<text x="${X.toFixed(1)}" y="${(Y + 3).toFixed(1)}" style="fill:${on ? '#000' : fg}" font-size="8" text-anchor="middle">${i + 1}</text>`);
  });
  // Key letters beside the station each key goes to; 'out' sits on the plan's edge nearest you.
  const curS = list[cur];
  for (const { key, to } of keys) {
    let X: number, Y: number;
    if (to === 'out') {
      const sx = px(curS.y), sy = py(curS.x);
      const edges = [[px(y0) - 8, sy], [px(y1) + 8, sy], [sx, py(x1) - 6], [sx, py(x0) + 8]];
      [X, Y] = edges.sort((a, b) => Math.hypot(a[0] - sx, a[1] - sy) - Math.hypot(b[0] - sx, b[1] - sy))[0];
    } else {
      X = px(list[to].y) + 10;
      Y = py(list[to].x) - 6;
    }
    parts.push(`<text x="${X.toFixed(1)}" y="${Y.toFixed(1)}" style="fill:${cyan}" font-size="9" font-weight="bold" text-anchor="middle">${key}${to === 'out' ? '↗' : ''}</text>`);
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block;margin:2px auto">${parts.join('')}</svg>`;
}

function panelHtml(game: Game): string {
  const vs = game.vehicles;
  const at = vs?.stations.view();
  if (!vs || !at || at.cabin === 'wheel' || game.player.dead) return '';
  const list = vs.stations.stations(at.v);
  const cur = list.indexOf(at.station);
  if (cur < 0) return '';
  const keys = vs.stations.keyTargets();
  const keyFor = (i: number | 'out') => keys.filter((k) => k.to === i).map((k) => k.key).join('');
  // Where you are, then where each key goes; the plan above numbers every station.
  const here = stationRole(at.v, at.station, list);
  const rows = [`${c('c_yellow', `▶ ${cur + 1}. ${here.title}`)}`, `&nbsp;&nbsp;&nbsp;${c('c_light_gray', here.detail)}`];
  const seen = new Set<number>();
  for (const { to } of keys) {
    if (to === 'out' || seen.has(to)) continue;
    seen.add(to);
    rows.push(`${c('c_light_cyan', `[${keyFor(to)}]`)} ${c('c_light_gray', `${to + 1}. ${stationRole(at.v, list[to], list).title}`)}`);
  }
  const out = keyFor('out');
  const e = game.keys.keyFor('interact');
  const a = vs.stations.action();
  // On a gun: just the gun (what's in it, what's in reach, the keys); the hops come back when you stand down.
  if (turretSession(game) && at.station.turret) {
    const foot2 = a ? `${c('c_light_cyan', `[${e}]`)} ${a.label}` : '';
    return `${c('c_white', at.v.name)}<br>${turretHtml(game, at.v, at.station)}${foot2}`;
  }
  const foot = [
    a ? `${c('c_light_cyan', `[${e}]`)} ${a.label}` : '',
    out ? `${c('c_light_cyan', `[${out}]`)} step out` : '',
    c('c_dark_gray', 'W/A/S/D hop the way you look'),
  ].filter(Boolean).join('<br>');
  return `${c('c_white', at.v.name)}${plan(at.v, list, cur, keys)}${rows.join('<br>')}<br>${turretHtml(game, at.v, at.station)}${foot}`;
}

/**
 * At a gunner station: the gun, what's in it, the rounds within reach (carried or in the cargo
 * beside it), power, the reload clock, and the keys (src/turrets.ts).
 */
function turretHtml(game: Game, v: Vehicle, st: Station): string {
  if (!st.turret) return '';
  const p = turretAt(v, st.mx, st.my);
  const gun = p ? turretGun(p, game.data) : null;
  if (!p || !gun) return '';
  const s = turretSession(game);
  const manned = s?.part === p;
  const status = turretStatus(v, p, game.data);
  const k = (id: string) => c('c_light_cyan', `[${game.keys.label(id)}]`);
  const lines: string[] = [];
  lines.push(`${c(manned ? 'c_light_green' : 'c_light_gray', manned ? '■ ON THE GUN' : '□ gun not manned')} ${c('c_white', p.def.name)}`);
  const ammo = gun.ammoData();
  const left = gun.ammoRemaining(), cap = gun.ammoCapacity();
  const feed = gun.magazine ? `${gun.magazine.baseName()} ` : '';
  if (has(p, 'USE_TANKS')) lines.push(c('c_light_gray', "feeds from the vehicle's tanks"));
  else if (cap > 0 || gun.magazine) lines.push(`${c('c_light_gray', 'Loaded:')} ${c(left > 0 ? 'c_yellow' : 'c_light_red', left > 0 ? `${feed}${left}/${cap} ${ammo?.name ?? ''}` : 'EMPTY')}`);
  const choices = ammoChoices(v, p, gun, game.player);
  const pref = ammoPref(p);
  if (choices.length) lines.push(`${c('c_light_gray', 'In reach:')} ${choices.map((ch) => c(ch.id === pref ? 'c_light_green' : 'c_light_gray', `${ch.name} ×${ch.count}`)).join(', ')}`);
  else if (!has(p, 'USE_TANKS') && cap > 0) lines.push(c('c_dark_gray', 'no rounds for it carried or in the cargo beside it'));
  const ups = upsDrain(gun);
  if (ups > 0) lines.push(`${c('c_light_gray', 'Power:')} ${c(status === 'no_power' ? 'c_light_red' : 'c_light_gray', `${ups} kJ/shot, battery ${Math.round(v.fuelLeft('battery'))} kJ`)}`);
  if (isJammed(gun)) lines.push(`${c('c_light_red', 'JAMMED')} ${c('c_light_gray', `${game.keys.label('reload')} clears it`)}`);
  if (gunModes(gun).length > 1) lines.push(`${c('c_light_gray', 'Mode:')} ${c('c_white', currentMode(gun).name)}`);
  if (manned && s.reloadLeft > 0) {
    const f = 1 - s.reloadLeft / Math.max(0.01, s.reloadTotal);
    const n = 12, on = Math.round(f * n);
    lines.push(`${c('c_yellow', 'Reloading')} ${c('c_yellow', '█'.repeat(on))}${c('c_dark_gray', '░'.repeat(n - on))}`);
  } else if (manned && aimError(turretAim(v, p)) > 0.05) lines.push(c('c_yellow', 'traversing…'));
  const keys = manned
    ? [`${c('c_light_cyan', '[LMB]')} fire`, `${k('reload')} reload`, `${k('fire_mode')} ${gunModes(gun).length > 1 ? 'fire mode' : 'next round'}`]
    : [];
  if (keys.length) lines.push(keys.join('  '));
  return `${lines.join('<br>')}<br>`;
}

export function installStationPanel(game: Game, renderer: Renderer): void {
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;right:.5em;top:14%;max-width:30vw;background:rgba(0,0,0,.72);padding:4px 10px;' +
    `font-family:var(--ui-font);font-size:var(--ui-size);color:${cssColor('c_light_gray')};pointer-events:none;z-index:5;display:none;line-height:1.35`;
  getUiRoot().appendChild(el);
  let last = '';
  renderer.beforeRender.push(() => {
    const html = panelHtml(game);
    if (html === last) return;
    last = html;
    el.innerHTML = html;
    el.style.display = html ? '' : 'none';
  });
}
