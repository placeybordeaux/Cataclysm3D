import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { craftingInventory, startCraft, findRecipe, continueCraft } from '../src/game/crafting';
import { evaluateRequirements, consumeRequirements } from '../src/game/requirements';
import { createItem } from '../src/game/item';
import { L, spawnItem, transaction } from '../src/game/moves';
let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup(energy = 10) {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  game.vehicles = new VehicleSystem(game, vd);
  const v = new Vehicle(vd, 'car'); v.x = game.player.x; v.y = game.player.y; v.z = game.player.z; v.locked = false;
  const kitchen = v.addPart(Object.values(vd.parts).find(p => p.integratedTools?.includes('hotplate'))!, 0, 0);
  const rig = v.addPart(Object.values(vd.parts).find(p => p.integratedTools?.includes('welder'))!, 0, 0);
  const battery = v.addPart(vd.parts.battery_car, 0, 0); battery.charges = energy;
  game.vehicles.add(v);
  return { game, v, kitchen, rig, battery };
}
describe('finite vehicle crafting facilities', () => {
  it('pays the real cooked-meat recipe once, retains escrow on interruption, and resumes without paying again', () => {
    const { game, battery } = setup(10);
    game.player.setSkill('cooking', 10); game.player.learnedRecipes.add('meat_cooked');
    const meat = createItem(data, 'meat'); spawnItem(meat, L.inv(game.player), { force: true });
    const recipe = findRecipe(data, 'meat_cooked')!;
    const result = startCraft(game, recipe);
    expect(result.ok).toBe(true); expect(battery.charges).toBe(3);
    expect(result.craft!.contents).toContain(meat);
    game.activities.cancel('interrupted');
    expect(result.craft!.contents).toContain(meat);
    expect(continueCraft(game, result.craft!, { instant: true }).ok).toBe(true);
    expect(battery.charges).toBe(3);
    expect(game.player.inv.allItems().filter(i => i.typeId === 'meat_cooked')).toHaveLength(1);
  });
  it('preserves a larger shared battery for the next tool when a smaller carried source covers cooking', () => {
    const { game, battery } = setup(10);
    const hotplate = createItem(data, 'hotplate'); hotplate.ammoId = 'battery'; hotplate.charges = 6;
    spawnItem(hotplate, L.inv(game.player), { force: true });
    const req = { tools: [[{ id: 'hotplate', count: 6 }], [{ id: 'welder', count: 10 }]] };
    expect(evaluateRequirements(data, req, craftingInventory(game)).ok).toBe(true);
    transaction(() => consumeRequirements(req, craftingInventory(game)));
    expect(hotplate.ammoRemaining()).toBe(0); expect(battery.charges).toBe(0);
  });
  it('retains an equivalent surviving facility when the first duplicate provider is invalidated', () => {
    const { game, v, kitchen } = setup();
    const duplicate = v.addPart(kitchen.def, 0, 0);
    const inv = craftingInventory(game);
    expect(inv.toolSources('hotplate')).toHaveLength(1);
    kitchen.hp = 0;
    expect(inv.hasTool('hotplate')).toBe(true); expect(inv.maxQuality('COOK')).toBeGreaterThan(0);
    v.removePart(kitchen);
    expect(inv.toolChargesOf('hotplate')).toBe(10);
    duplicate.hp = 0;
    expect(inv.hasTool('hotplate')).toBe(false); expect(inv.maxQuality('COOK')).toBe(0);
  });
  it('extracts real integrated tools, exposes tools and qualities but never components', () => {
    const { game, v, kitchen } = setup();
    const inv = craftingInventory(game);
    expect(kitchen.def.integratedTools).toEqual(['pot', 'pan', 'hotplate']);
    expect(inv.hasTool('hotplate')).toBe(true); expect(inv.maxQuality('COOK')).toBeGreaterThan(0);
    expect(inv.countOf('pot')).toBe(0); expect(inv.componentSources('hotplate')).toEqual([]);
    v.addPart(kitchen.def, 0, 0);
    expect(craftingInventory(game).toolSources('hotplate')).toHaveLength(1);
  });
  it('does not promise the same vehicle battery to multiple charged tool groups', () => {
    const { game, battery } = setup(10);
    const req = { tools: [[{ id: 'hotplate', count: 6 }], [{ id: 'welder', count: 6 }]] };
    const result = evaluateRequirements(data, req, craftingInventory(game));
    expect(result.ok).toBe(false); expect(result.tools[1].alts[0].avail).toBe(4);
    expect(battery.charges).toBe(10);
    req.tools[1][0].count = 4;
    expect(evaluateRequirements(data, req, craftingInventory(game)).ok).toBe(true);
    transaction(() => consumeRequirements(req, craftingInventory(game)));
    expect(battery.charges).toBe(0);
  });
  it('selects an available alternative and mixes carried power with the finite vehicle pool', () => {
    const { game, battery } = setup(5);
    const hotplate = createItem(data, 'hotplate'); hotplate.ammoId = 'battery'; hotplate.charges = 10;
    spawnItem(hotplate, L.inv(game.player), { force: true });
    const req = { tools: [[{ id: 'hotplate', count: 12 }], [{ id: 'welder', count: 4 }, { id: 'pot', count: -1 }]] };
    expect(evaluateRequirements(data, req, craftingInventory(game)).ok).toBe(true);
    transaction(() => consumeRequirements(req, craftingInventory(game)));
    expect(hotplate.ammoRemaining()).toBe(0); expect(battery.charges).toBe(3);
  });
  it('restores shared battery energy, version and component locations after failure, including nested transactions', () => {
    const { game, v, battery } = setup(10);
    const rock = createItem(data, 'rock'); spawnItem(rock, L.inv(game.player), { force: true });
    const version = v.version;
    const req = { components: [[{ id: 'rock', count: 1 }]], tools: [[{ id: 'hotplate', count: 7 }], [{ id: 'welder', count: 7 }]] };
    expect(() => transaction(() => consumeRequirements(req, craftingInventory(game)))).toThrow();
    expect(battery.charges).toBe(10); expect(v.version).toBe(version); expect(game.player.inv.items).toContain(rock);
    transaction(() => { transaction(() => consumeRequirements({ tools: [[{ id: 'hotplate', count: 3 }]] }, craftingInventory(game))); return false; });
    expect(battery.charges).toBe(10); expect(v.version).toBe(version);
    expect(() => transaction(() => { consumeRequirements({ tools: [[{ id: 'hotplate', count: 4 }]] }, craftingInventory(game)); throw new Error('later step'); })).toThrow('later step');
    expect(battery.charges).toBe(10); expect(v.version).toBe(version);
  });
  it('revalidates cached tool qualities after damage, lock, leaving reach, part removal and vehicle removal', () => {
    for (const change of ['broken', 'locked', 'far', 'part', 'vehicle']) {
      const { game, v, kitchen } = setup(); const inv = craftingInventory(game);
      expect(inv.maxQuality('COOK')).toBeGreaterThan(0); expect(inv.hasTool('hotplate')).toBe(true);
      if (change === 'broken') kitchen.hp = 0;
      if (change === 'locked') v.locked = true;
      if (change === 'far') game.player.x += 20;
      if (change === 'part') v.removePart(kitchen);
      if (change === 'vehicle') game.vehicles!.remove(v);
      expect(inv.maxQuality('COOK')).toBe(0); expect(inv.hasTool('hotplate')).toBe(false);
      expect(inv.toolChargesOf('hotplate')).toBe(0);
    }
  });
  it('uses the same saved finite battery from the seat while moving across a long chassis', () => {
    const { game, v, kitchen, battery } = setup(10);
    v.velocity = 4; kitchen.mx = 10;
    expect(craftingInventory(game).hasTool('hotplate')).toBe(false);
    game.vehicles!.driving = v;
    const req = { tools: [[{ id: 'hotplate', count: 3 }]] };
    transaction(() => consumeRequirements(req, craftingInventory(game)));
    expect(battery.charges).toBe(7);
    const restored = Vehicle.fromJSON(vd, data, v.toJSON());
    expect(restored.fuelLeft('battery')).toBe(7);
  });
});
