import { readFileSync } from 'node:fs';
import { loadNodeData } from '../lib/node_data';
import { Game } from '../../src/game/game';
import { Vehicle } from '../../src/game/vehicle';
import { VehicleSystem } from '../../src/game/vehicles';
import type { VehicleDataFile } from '../../src/game/vehicle_data';
import { createItem } from '../../src/game/item';
import { spawnItem, L } from '../../src/game/moves';
import { craftingInventory, recipeRequirements } from '../../src/game/crafting';
import { evaluateRequirements } from '../../src/game/requirements';
const { game: data } = loadNodeData();
const vd: VehicleDataFile = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8'));
const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
game.vehicles = new VehicleSystem(game, vd);
for (let i = 0; i < 500; i++) { const item = createItem(data, 'rock'); item.damage = i; spawnItem(item, L.inv(game.player), { force: true }); }
const kitchen = Object.values(vd.parts).find(p => p.integratedTools?.includes('hotplate'))!;
for (let i = 0; i < 30; i++) {
  const v = new Vehicle(vd, 'car'); v.x = game.player.x + i * 10; v.y = game.player.y; v.z = game.player.z; v.locked = false;
  for (let n = 0; n < 50; n++) v.addPart(vd.parts.frame_wood_light_cross, n % 10, Math.floor(n / 10));
  v.addPart(kitchen, 0, 0); v.addPart(vd.parts.battery_car, 0, 0).charges = 10000; game.vehicles.add(v);
}
const recipes = data.recipes.slice(0, 750);
const samples: number[] = [];
for (let i = 0; i < 110; i++) {
  const t = performance.now(), inv = craftingInventory(game);
  for (const recipe of recipes) evaluateRequirements(data, recipeRequirements(recipe), inv);
  if (i >= 10) samples.push(performance.now() - t);
}
samples.sort((a, b) => a - b);
console.log(JSON.stringify({ items: game.player.inv.items.length, vehicles: game.vehicles.list.length, partsPerVehicle: 52, recipes: recipes.length, p50Ms: samples[50], p95Ms: samples[95], maxMs: samples[99] }));
