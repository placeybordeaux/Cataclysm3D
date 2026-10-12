import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { Game } from '../../src/game/game';
import { Vehicle } from '../../src/game/vehicle';
import { updateVehiclePower } from '../../src/game/vehiclePower';
import { loadNodeData } from '../lib/node_data';
import { L, spawnItem } from '../../src/game/moves';
import { createItem } from '../../src/game/item';
const d = loadNodeData().game;
const game = new Game(d,1,{held:new Set(),captured:false,onPress(){},consumeMouse:()=>[0,0]} as any);
const data = JSON.parse(readFileSync('public/data/vehicles.json','utf8'));
game.clock.seconds=12*3600;
game.map.terAt=()=>({flags:[]}) as any;
game.map.hasFloor=()=>false;
const fleet=Array.from({length:30},()=>{const v=new Vehicle(data,'car');v.addPart(data.parts.battery_car,0,0).charges=100;v.addPart(data.parts.solar_panel,0,0);v.addPart(data.parts.recharge_station,0,0).enabled=true;const cargo=v.addPart(data.parts.trunk,0,0);spawnItem(createItem(d,'medium_battery_cell'),L.cargo(cargo,v));return v;});
if (process.argv.includes('--cold')) for (const v of fleet) { const fridge=v.addPart(data.parts.fridge,1,0);fridge.enabled=true;for(let n=0;n<20;n++){const food=createItem(d,'meat');food.damage=n;spawnItem(food,L.cargo(fridge,v),{force:true});} }
for(let k=0;k<5;k++)for(const v of fleet)updateVehiclePower(game,v,120);
const results=[];
for(let k=0;k<25;k++){const t=performance.now();for(const v of fleet)updateVehiclePower(game,v,120);results.push(performance.now()-t);}
results.sort((a,b)=>a-b);
console.log(JSON.stringify({cold:process.argv.includes('--cold'),vehicles:30,gameSeconds:120,samples:25,p50:results[12],p95:results[23],max:results[24]}));
