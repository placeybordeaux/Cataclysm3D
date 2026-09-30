// Real-input reload-help scenario, run from tools/realinput.ts:
//   --only reloadhelp   wield a flashlight with no battery, press the reload key: the message names
//                       the light batteries it takes (not "no ammo"); look at a pile holding two
//                       light batteries, look away, press reload again: the message says where
//                       you saw them (src/game/reloadhelp.ts, docs/ADAPTATION.md "Reload help")
//
// Keys and mouse are OS-level input; cdda.* only hands out the flashlight, drops the pile,
// clears monsters and reads the log.

import type { XInput } from './lib/realinput';

export interface ReloadCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  shot: (name: string) => Promise<void>;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

/** A floor tile 3–6 tiles away with nothing opaque on the straight line to it. */
const FIND_SPOT = `(() => {
  const g = cdda.game, m = g.map, p = g.player, z = p.z;
  const clear = (x1, y1) => {
    const n = Math.max(Math.abs(x1 - p.tileX), Math.abs(y1 - p.tileY));
    for (let i = 1; i < n; i++) {
      const x = Math.round(p.tileX + ((x1 - p.tileX) * i) / n), y = Math.round(p.tileY + ((y1 - p.tileY) * i) / n);
      if (m.opaque(x, y, z)) return false;
    }
    return true;
  };
  for (let r = 3; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
    const x = p.tileX + dx, y = p.tileY + dy;
    if (!m.passable(x, y, z) || m.furnAt(x, y, z).id !== 'f_null' || m.itemsAt(x, y, z).length || !clear(x, y)) continue;
    return { dx, dy };
  }
  return null;
})()`;

export function reloadScenarios(c: ReloadCtx): Scenario[] {
  const { js, check, shot, toGameplay, sleep } = c;
  const logTail = (n = 3) => js<string[]>(`cdda.ui.log().slice(-${n})`);
  /** Turn with the real mouse to face (dx, dy) from the survivor, pitched to look at the floor there. */
  const face = async (dx: number, dy: number, h = 0.1) => {
    for (let i = 0; i < 4; i++) {
      const d = await js<{ dyaw: number; dpitch: number; sens: number }>(`(() => {
        const g = cdda.game, p = g.player;
        const tx = p.tileX + ${dx} + 0.5, ty = p.tileY + ${dy} + 0.5;
        const yaw = Math.atan2(tx - p.x, -(ty - p.y));
        const pitch = Math.atan2(${h} - 1.6, Math.hypot(tx - p.x, ty - p.y));
        let dyaw = yaw - p.yaw; dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
        return { dyaw, dpitch: pitch - p.pitch, sens: g.mouseSensitivity };
      })()`);
      if (Math.abs(d.dyaw) < 0.04 && Math.abs(d.dpitch) < 0.04) break;
      await c.x().move(d.dyaw / d.sens, -d.dpitch / d.sens, 6);
      await sleep(150);
    }
  };
  /** Look up at the sky: the reload key is "Take all" while the loot card is up. */
  const lookUp = async () => {
    const d = await js<{ dpitch: number; sens: number }>(`({ dpitch: 0.9 - cdda.game.player.pitch, sens: cdda.game.mouseSensitivity })`);
    await c.x().move(0, -d.dpitch / d.sens, 6);
    await sleep(300);
  };
  const pressReload = async () => {
    const key = await js<string>(`cdda.game.keys.keysFor('reload')[0]`);
    await c.x().key(key);
    await sleep(500);
    return (await logTail(3)).join(' | ');
  };

  return [
    ['reloadhelp', 'flashlight with no battery: reload names the light batteries it takes; after looking at a pile of them, reload says where they are', async () => {
      await toGameplay();
      const setup = await js<string>(`(() => {
        cdda.godMode(true); cdda.setHour(12); cdda.clearMonsters(60);
        const p = cdda.game.player;
        // No batteries on the survivor: the start kit mustn't answer the question for us.
        for (const it of p.inv.allItems()) if (it.isMagazine() && it.ammoTypes().includes('battery')) throw new Error('start kit has a battery: ' + it.typeId);
        cdda.giveItem('backpack', { wear: true });
        return cdda.giveItem('flashlight', { wield: true });
      })()`);
      check('wielding a flashlight with no battery in it', /flashlight/.test(setup) && (await js<boolean>(`!cdda.game.player.inv.wielded.magazine`)), setup);
      await lookUp();
      const before = await pressReload();
      await shot('reloadhelp_1_no_battery');
      check('reload names what it takes: a light disposable battery or a light battery', /Your flashlight takes a light disposable battery or a light battery\. You have none\./.test(before), before);
      check('…not "no ammo" / "You don\'t have a magazine"', !/no ammo|don't have a magazine/i.test(before), before);

      const spot = await js<{ dx: number; dy: number } | null>(FIND_SPOT);
      check('found a clear floor tile in sight for the pile', !!spot, spot);
      if (!spot) return;
      await js(`(() => { cdda.spawnItem('light_battery_cell', ${spot.dx}, ${spot.dy}); cdda.spawnItem('light_battery_cell', ${spot.dx}, ${spot.dy}); })()`);
      await face(spot.dx, spot.dy);
      await sleep(1600); // the seen-items scan runs once a second
      await shot('reloadhelp_2_looking_at_pile');
      const seen = await js<{ s: [string, number][] }>(`cdda.loot.seenItems()`);
      check('the pile is remembered', seen.s.some(([id, n]) => id === 'light_battery_cell' && n === 2), seen.s.slice(0, 5));
      await lookUp();
      const after = await pressReload();
      await shot('reloadhelp_3_says_where');
      check('reload now says where you saw them', /You saw 2 light batteries on the (floor|ground) \d+ m (north|south|east|west|northeast|northwest|southeast|southwest)\./.test(after), after);

      // The same line on the item's tooltip: open the inventory (frees the cursor), hover the
      // flashlight's hotbar slot with the real mouse.
      await c.x().key(await js<string>(`cdda.game.keys.keysFor('inventory2')[0]`));
      await sleep(700);
      const slot = await js<{ x: number; y: number } | null>(`(() => {
        const el = [...document.querySelectorAll('.ui2-hot-slot')].find((s) => /flashl/.test(s.textContent || ''));
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      })()`);
      check('the flashlight is on the hotbar', !!slot, slot);
      if (!slot) return;
      await c.x().moveTo(slot.x, slot.y, 4);
      await sleep(1200);
      const tip = await js<string>(`document.querySelector('[data-testid="item-takes"]')?.textContent ?? ''`);
      await shot('reloadhelp_4_tooltip');
      check('its tooltip says what it takes and where you saw some', /^Takes: a light disposable battery or a light battery\. You saw 2 light batteries/.test(tip), tip);
    }],
  ];
}
