// The quick-start Evacuee's walking speed: speed stat, leg/foot encumbrance and tiles per
// second on flat ground (compare: a speed-70 zombie walks 2.1 tiles/s).
//   tsx tools/dev/probe_speed.ts
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../lib/node_data';
import { Game } from '../../src/game/game';
import type { Input } from '../../src/core/input';
import { applyBuild, defaultBuild } from '../../src/ui/chargen';
import type { UiContext } from '../../src/ui/context';

const { game: data } = loadNodeData();
const game = new Game(data, 1, { held: new Set(), onPress() {}, capture: () => () => {} } as unknown as Input);
const ctx = { game, data: { names: JSON.parse(readFileSync('public/data/ui.json', 'utf8')).names } } as unknown as UiContext;
const b = defaultBuild(ctx);
b.density = undefined;
applyBuild(ctx, b);
const p = game.player;
const enc = Object.fromEntries(['leg_l', 'leg_r', 'foot_l', 'foot_r', 'torso'].map((bp) => [bp, p.inv.encumbrance(bp as never)]));
console.log('worn', p.inv.worn.map((i) => i.typeId).join(' '));
console.log('speed', p.speed, 'encumbrance', enc, 'walk tiles/s', p.moveSpeed(100).toFixed(2));
p.running = true;
console.log('run tiles/s', p.moveSpeed(100).toFixed(2));
