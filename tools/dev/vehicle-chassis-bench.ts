import { performance } from 'node:perf_hooks';
import { readFileSync } from 'node:fs';
import { Game } from '../../src/game/game';
import { VehicleSystem } from '../../src/game/vehicles';
import { chassisFootprint, startChassis } from '../../src/game/vehicleChassis';
import { loadNodeData } from '../lib/node_data';
import { L, spawnItem } from '../../src/game/moves';
import { createItem } from '../../src/game/item';
import { chunkOf } from '../../src/world/coords';
const data=loadNodeData().game;
const game=new Game(data,1,{held:new Set(),captured:false,onPress(){},consumeMouse:()=>[0,0]} as any);
game.vehicles=new VehicleSystem(game,JSON.parse(readFileSync('public/data/vehicles.json','utf8')));
game.player.inv.volumeCapacity=()=>1e9;game.player.inv.weightCapacity=()=>1e9;
const x=game.player.tileX+2,y=game.player.tileY,z=0;
const plan={template:'rig' as const,frame:'frame_wood_light_cross',name:'Bench rig',elapsed:0};
for(const [tx,ty]of chassisFootprint(game,plan,x,y,z)){game.map.setTer(tx,ty,z,'t_floor');game.map.setFurn(tx,ty,z,'f_null');game.map.chunk(chunkOf(tx),chunkOf(ty),z)!.omt={id:'s_garage',source:'bench'};}
for(let i=0;i<50;i++)for(const id of ['frame_wood_light','rope_6'])spawnItem(createItem(data,id),L.inv(game.player),{force:true});
for(let i=0;i<500;i++){const item=createItem(data,'rock');item.damage=i;spawnItem(item,L.inv(game.player),{force:true});}
if(!startChassis(game,plan,x,y,z))throw new Error('Bench chassis did not start');
for(let i=0;i<10;i++)game.activities.update(game,1/30,120);
const samples:number[]=[];
for(let i=0;i<100;i++){const t=performance.now();game.activities.update(game,1/30,120);samples.push(performance.now()-t);}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({frames:50,inventory:game.player.inv.allItems().length,gameSecondsPerTick:120,p50:samples[50],p95:samples[95],max:samples[99]}));
