// Debug spawn menu (src/ui/debug_spawn.ts) with real keys: Esc > d opens it; c puts a working
// car ahead of you, C a working car with you at the wheel, and W drives it; the Monsters tab
// filters as you type and Enter spawns. `cdda.*` only reads state (vehicles, monsters, panels).
// Plugged into tools/realinput.ts (--only debugspawn).

import type { XInput } from './lib/realinput';

export interface DebugSpawnCtx {
  x: () => XInput;
  js: <T>(code: string) => Promise<T>;
  check: (name: string, ok: boolean, detail?: unknown) => boolean;
  toGameplay: () => Promise<unknown>;
  sleep: (ms: number) => Promise<unknown>;
  shot: (name: string) => Promise<unknown>;
}

type Scenario = [name: string, what: string, run: () => Promise<void>];

export function debugSpawnScenarios(c: DebugSpawnCtx): Scenario[] {
  const { js, check, sleep } = c;
  const panels = () => js<string[]>(`[...document.querySelectorAll('#ui2 .ui2-win')].map((w) => w.dataset.id ?? '')`);
  const openMenu = async () => {
    await c.x().key('Escape');
    await sleep(500);
    await c.x().key('d');
    await sleep(500);
    return (await js<boolean>(`!!document.querySelector('#ui2 .dbg-body')`));
  };
  return [
    ['debugspawn', 'Esc > Debug spawn: a working car ahead, one at the wheel that drives off with W, a zombie from the filtered list', async () => {
      await c.toGameplay();
      await js(`(() => { const vs = cdda.vehicleSystem; for (const v of [...vs.list]) if (Math.hypot(v.x - cdda.game.player.x, v.y - cdda.game.player.y) < 30) vs.remove(v); cdda.clearMonsters(40); })()`);
      if (!check('Esc then d opens the debug spawn menu', await openMenu(), await panels())) return;
      await c.shot('debugspawn_quick');
      const before = await js<number>(`cdda.vehicleSystem.list.length`);
      await c.x().key('c');
      await sleep(400);
      const car = await js<{ d: number; locked: boolean; fuel: number; dmg: number } | null>(`(() => {
        const p = cdda.game.player, list = cdda.vehicleSystem.list;
        const v = list[list.length - 1];
        if (!v) return null;
        let fuel = 0, cap = 0, dmg = 0;
        for (const q of v.parts) { if (q.def.capacity && q.fuelType) { fuel += q.charges; cap += q.def.capacity; } if (q.hp < q.def.durability) dmg++; }
        return { d: +Math.hypot(v.x - p.x, v.y - p.y).toFixed(1), locked: !!v.locked, fuel: cap ? +(fuel / cap).toFixed(2) : 0, dmg };
      })()`);
      check('c: a car appeared a few metres ahead', (await js<number>(`cdda.vehicleSystem.list.length`)) === before + 1 && !!car && car.d < 16, car);
      check('…in working order (unlocked, tanks full, no damaged parts)', !!car && !car.locked && car.fuel > 0.99 && car.dmg === 0, car);
      // the list tabs: → to Monsters (Quick, Vehicles, Monsters), type, Enter
      await c.x().key('Right');
      await c.x().key('Right');
      await sleep(300);
      await c.x().type('zombie cop');
      await sleep(300);
      const first = await js<string>(`document.querySelector('#ui2 .dbg-tab .ui2-list-row.selected')?.textContent ?? ''`);
      check('typing filters the monster list', /cop/i.test(first), first);
      const n0 = await js<number>(`cdda.monsters().length`);
      await c.x().key('Return');
      await sleep(400);
      const n1 = await js<number>(`cdda.monsters().length`);
      check('Enter spawned it', n1 === n0 + 1, { n0, n1 });
      await c.shot('debugspawn_monsters');
      await c.x().key('Escape');
      await sleep(400);
      await js(`cdda.clearMonsters(40)`);
      // the car with you at the wheel, then drive (closing menus frees the mouse: back in first)
      await c.toGameplay();
      if (!check('the menu again', await openMenu())) return;
      await c.x().key('C');
      await sleep(800);
      const driving = await js<boolean>(`!!cdda.vehicleSystem.driving`);
      check('C: at the wheel of a working car, menu closed', driving && !(await js<boolean>(`!!document.querySelector('#ui2 .dbg-body')`)));
      // taking the wheel starts the engine; k only if it didn't (k toggles it)
      if (!(await js<boolean>(`!!cdda.vehicleSystem.driving?.engineOn`))) {
        await c.x().key('k');
        await sleep(1200);
      }
      await c.x().hold('w', 2500);
      const v = await js<number>(`Math.abs(cdda.vehicleSystem.driving?.velocity ?? 0)`);
      check('W drives it away', v > 2, v);
      await c.shot('debugspawn_drive');
      await js(`(() => { const d = cdda.vehicleSystem.driving; if (d) d.velocity = 0; cdda.exitVehicle(); })()`);
    }],
  ];
}
