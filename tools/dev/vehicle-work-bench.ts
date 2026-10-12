import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { Game } from '../../src/game/game';
import { Vehicle } from '../../src/game/vehicle';
import { vehicleWorkReasons, adoptVehicle } from '../../src/game/vehicleWork';
import { loadNodeData } from '../lib/node_data';
import { L, spawnItem } from '../../src/game/moves';
import { createItem } from '../../src/game/item';
const data = loadNodeData().game;
const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
const vd = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8'));
const v = new Vehicle(vd, 'car');
v.x = game.player.x; v.y = game.player.y; v.z = game.player.z;
v.addPart(vd.parts.frame_vertical, 0, 0); v.addPart(vd.parts.solar_panel, 0, 0);
adoptVehicle(game, v); game.player.setSkill('mechanics', 2);
spawnItem(createItem(data, 'wrench'), L.inv(game.player), { force: true });
game.player.inv.volumeCapacity = () => 1e9;
game.player.inv.weightCapacity = () => 1e9;
for (let i = 0; i < 500; i++) { const item = createItem(data, 'rock'); item.damage = i; const result = spawnItem(item, L.inv(game.player), { force: true }); if (!result.ok) throw new Error(result.msg); }
const order = { kind: 'removal' as const, part: 'solar_panel', mx: 0, my: 0, elapsed: 0 };
for (let i = 0; i < 10; i++) vehicleWorkReasons(game, v, order);
const samples = [];
for (let i = 0; i < 100; i++) { const t = performance.now(); vehicleWorkReasons(game, v, order); samples.push(performance.now() - t); }
samples.sort((a,b) => a-b);
console.log(JSON.stringify({ inventory: game.player.inv.allItems().length, samples: 100, p50: samples[50], p95: samples[95], max: samples[99] }));
