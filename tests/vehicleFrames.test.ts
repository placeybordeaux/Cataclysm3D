import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { VehicleSystem } from '../src/game/vehicles';
import { Item } from '../src/game/item';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { adoptVehicle, structuralRemovalReasons, queueVehicleWork, startVehicleWork, vehicleWorkReasons } from '../src/game/vehicleWork';
import { chunkOf } from '../src/world/coords';
let data: ReturnType<typeof loadNodeData>['game'],vd:VehicleDataFile;
beforeAll(()=>{data=loadNodeData().game;vd=JSON.parse(readFileSync('public/data/vehicles.json','utf8'));});
function setup(cells:[number,number][]=[[0,0]]){
  const game=new Game(data,1,{held:new Set(),captured:false,onPress(){},consumeMouse:()=>[0,0]} as any);
  game.vehicles=new VehicleSystem(game,vd);
  const v=new Vehicle(vd,'car');v.x=game.player.x;v.y=game.player.y;v.z=game.player.z;v.template='frame';
  for(const [mx,my]of cells)v.addPart(vd.parts.frame_wood_light_cross,mx,my);
  game.vehicles.add(v);adoptVehicle(game,v);
  const garage=()=>{for(const p of v.parts){const [x,y]=v.mountToWorld(p.mx,p.my);game.map.chunk(chunkOf(x),chunkOf(y),v.z)!.omt={id:'s_garage',source:'test'};}};
  return {game,v,garage};
}
describe('garage frame dismantling',()=>{
  it('requires garage and attached fittings to be removed first',()=>{
    const {game,v,garage}=setup();const p=v.parts[0];
    expect(structuralRemovalReasons(game,v,p)).toContain('Dismantle chassis frames at a ground-level vehicle garage');
    garage();v.addPart(vd.parts.solar_panel,0,0);
    expect(structuralRemovalReasons(game,v,p)).toContain('Remove all attached fittings from this part first');
  });
  it('prevents splitting a chassis but permits a redundant path around the removed square',()=>{
    const {game,v,garage}=setup([[-1,0],[0,0],[1,0]]);garage();
    expect(structuralRemovalReasons(game,v,v.parts[1])).toContain('Removing this part would split the vehicle');
    for(const [mx,my]of [[-1,1],[0,1],[1,1]])v.addPart(vd.parts.frame_wood_light_cross,mx,my);garage();
    expect(structuralRemovalReasons(game,v,v.parts[1])).toEqual([]);
  });
  it('applies BN structural checks to the real EXTENDABLE buoyancy-cell bridge',()=>{
    const {game,v}=setup([]);const def=vd.parts.gas_sac_buoyancy_cell_external;
    expect(def.flags).toContain('EXTENDABLE');expect(def.location).toBe('under');
    const cells=[[-1,0],[0,0],[1,0]].map(([mx,my])=>v.addPart(def,mx,my));
    const reasons=vehicleWorkReasons(game,v,{kind:'removal',part:def.id,mx:0,my:0,elapsed:0});
    expect(reasons).toContain('Removing this part would split the vehicle');
    expect(reasons).not.toContain('Dismantle chassis frames at a ground-level vehicle garage');
    v.addPart(vd.parts.solar_panel,0,0);
    expect(structuralRemovalReasons(game,v,cells[1])).toContain('Remove all attached fittings from this part first');
  });
  it('interrupts and resumes the last frame, preserving condition and unregistering exactly once',()=>{
    const {game,v,garage}=setup();garage();const p=v.parts[0];p.hp=p.def.durability*0.75;
    const order={kind:'removal' as const,part:p.def.id,mx:0,my:0};
    expect(queueVehicleWork(game,v,order)).toContain('Queued');expect(startVehicleWork(game,v)).toBe(true);
    game.activities.update(game,1,100);game.activities.cancel('movement');
    expect(game.vehicles!.list).toContain(v);expect(v.parts).toContain(p);expect(v.workOrders[0].elapsed).toBe(100);
    expect(startVehicleWork(game,v)).toBe(true);game.activities.update(game,1,10000);
    expect(v.parts).toHaveLength(0);expect(game.vehicles!.list).not.toContain(v);
    expect(game.vehicles!.at(game.player.tileX,game.player.tileY,v.z)).toBeNull();
    const items=game.map.itemsAt(game.player.tileX,game.player.tileY,v.z);
    expect(items.filter(i=>i.typeId==='frame_wood_light')).toHaveLength(1);
    expect((items.find(i=>i.typeId==='frame_wood_light')! as Item).damage).toBe(1000);
    expect(startVehicleWork(game,v)).toBe(false);expect(game.map.itemsAt(game.player.tileX,game.player.tileY,v.z)).toHaveLength(items.length);
  });
});
