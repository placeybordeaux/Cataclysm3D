import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { VehicleSystem } from '../src/game/vehicles';
import { Vehicle } from '../src/game/vehicle';
import { chassisBodyRect } from '../src/game/chassis';
import { vehiclePartPractice, vehicleWorkSeconds } from '../src/game/vehicleWork';
import { constructionPractice } from '../src/game/practice';
import type { ConstructionDef } from '../src/game/construction';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { createItem, Item } from '../src/game/item';
import { consumeItem, L, spawnItem } from '../src/game/moves';
import { cancelChassis, chassisCells, chassisFootprint, chassisReasons, chassisRequirement, chassisSitePlan, continueChassis, isVehicleGarage, startChassis, type ChassisPlan } from '../src/game/vehicleChassis';
import { chunkOf } from '../src/world/coords';
let data: ReturnType<typeof loadNodeData>['game'], vd: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vd = JSON.parse(readFileSync('public/data/vehicles.json','utf8')); });
function setup() {
  const game = new Game(data,1,{ held:new Set(),captured:false,onPress(){},consumeMouse:()=>[0,0] } as any);
  game.vehicles = new VehicleSystem(game,vd);
  const x = game.player.tileX+2, y = game.player.tileY, z=0;
  const chunk = game.map.chunk(chunkOf(x),chunkOf(y),z)!; chunk.omt={id:'s_garage',source:'test'};
  for(let dx=0;dx<3;dx++)for(let dy=0;dy<3;dy++){game.map.setTer(x+dx,y+dy,z,'t_floor');game.map.setFurn(x+dx,y+dy,z,'f_null');}
  const frame=createItem(data,'frame_wood_light'); frame.damage=1000;
  spawnItem(frame,L.inv(game.player),{force:true});
  spawnItem(createItem(data,'rope_6'),L.inv(game.player),{force:true});
  const plan: ChassisPlan={template:'frame',frame:'frame_wood_light_cross',name:'My chassis',elapsed:0};
  return {game,x,y,z,frame,plan};
}
describe('garage chassis construction',()=>{
  it('requires a real ground-level garage and clear footprint',()=>{
    const {game,x,y,z,plan}=setup();
    expect(chassisReasons(game,plan,x,y,z)).toEqual([]);
    expect(isVehicleGarage(game,x,y,1)).toBe(false);
    game.map.setFurn(x,y,z,'f_chair');
    expect(chassisReasons(game,plan,x,y,z).some(r=>r.includes('Clear'))).toBe(true);
    game.map.setFurn(x,y,z,'f_null');game.map.chunk(chunkOf(x),chunkOf(y),z)!.omt={id:'house_01',source:'test'};
    expect(startChassis(game,plan,x,y,z)).toBeNull();
    expect(game.player.inv.allItems().some(i=>i.typeId==='frame_wood_light')).toBe(true);
  });
  it('escrows actual frames, resumes saved progress and creates exactly one owned chassis',()=>{
    const {game,x,y,z,plan,frame}=setup();
    const site=startChassis(game,plan,x,y,z)!;
    expect(site).toBeTruthy();expect(site.contents).toContain(frame);
    expect(game.player.inv.allItems()).not.toContain(frame);
    game.activities.update(game,1,120);game.activities.cancel('movement');
    expect(chassisSitePlan(site)!.elapsed).toBe(120);
    const restored=Item.fromJSON(data,site.toJSON());
    expect(chassisSitePlan(restored)!.elapsed).toBe(120);
    consumeItem(site,L.ground(game.map,x,y,z));spawnItem(restored,L.ground(game.map,x,y,z));
    expect(continueChassis(game,restored,x,y,z)).toBe(true);
    game.activities.update(game,1,10000);
    expect(game.vehicles!.list).toHaveLength(1);
    const v=game.vehicles!.list[0];expect(v.name).toBe('My chassis');expect(v.adopted).toBe(true);expect(v.template).toBe('frame');
    expect(v.parts).toHaveLength(1);expect(v.parts[0].installedItem?.damage).toBe(1000);
    expect(game.map.itemsAt(x,y,z)).not.toContain(site);
    expect(continueChassis(game,site,x,y,z)).toBe(false);
  });
  it('does not publish a partial chassis when the player leaves or an obstruction appears',()=>{
    const {game,x,y,z,plan}=setup();const site=startChassis(game,plan,x,y,z)!;
    game.activities.update(game,1,100);const elapsed=chassisSitePlan(site)!.elapsed;
    game.player.x+=10;game.activities.update(game,1,10000);
    expect(game.vehicles!.list).toHaveLength(0);expect(chassisSitePlan(site)!.elapsed).toBe(elapsed);
    game.player.x-=10;expect(continueChassis(game,site,x,y,z)).toBe(true);
    game.map.setTer(x,y,z,'t_wall');game.activities.update(game,1,10000);
    expect(game.vehicles!.list).toHaveLength(0);expect(game.map.itemsAt(x,y,z)).toContain(site);expect(chassisSitePlan(site)!.elapsed).toBe(elapsed);
    game.map.setTer(x,y,z,'t_floor');expect(continueChassis(game,site,x,y,z)).toBe(true);game.activities.update(game,1,10000);
    expect(game.vehicles!.list).toHaveLength(1);
  });
  it('returns the actual reserved frames on cancellation without duplication',()=>{
    const {game,x,y,z,plan,frame}=setup();const site=startChassis(game,plan,x,y,z)!;
    expect(cancelChassis(game,site,x,y,z)).toBe(true);
    expect(game.map.itemsAt(x,y,z)).toContain(frame);
    expect(game.map.itemsAt(x,y,z).filter(i=>i instanceof Item&&i.typeId==='rope_6')).toHaveLength(1);
    expect(cancelChassis(game,site,x,y,z)).toBe(false);expect(game.vehicles!.list).toHaveLength(0);
  });
  it('restores frame components and shared tool ammunition if reservation fails',()=>{
    const {game,x,y,z,plan,frame}=setup();
    const def=vd.parts[plan.frame];
    const req={...def.requirements!.install!,tools:[[{id:'soldering_iron',count:10}],[{id:'soldering_iron',count:10}]]};
    game.vehicles=new VehicleSystem(game,{...vd,parts:{...vd.parts,[plan.frame]:{...def,requirements:{...def.requirements,install:req}}}});
    const iron=createItem(data,'soldering_iron',{ammo:'battery',ammoCount:15});spawnItem(iron,L.inv(game.player),{force:true});
    expect(startChassis(game,plan,x,y,z)).toBeNull();
    expect(game.player.inv.allItems()).toContain(frame);expect(iron.ammoRemaining()).toBe(15);
    expect(game.map.itemsAt(x,y,z)).toHaveLength(0);
  });
  it('returns components but preserves actually spent tool energy on cancellation',()=>{
    const {game,x,y,z,plan,frame}=setup();const def=vd.parts[plan.frame];
    const req={...def.requirements!.install!,tools:[[{id:'soldering_iron',count:5}]]};
    game.vehicles=new VehicleSystem(game,{...vd,parts:{...vd.parts,[plan.frame]:{...def,requirements:{...def.requirements,install:req}}}});
    const iron=createItem(data,'soldering_iron',{ammo:'battery',ammoCount:15});spawnItem(iron,L.inv(game.player),{force:true});
    const site=startChassis(game,plan,x,y,z)!;expect(site).toBeTruthy();expect(iron.ammoRemaining()).toBe(10);
    expect(cancelChassis(game,site,x,y,z)).toBe(true);expect(game.map.itemsAt(x,y,z)).toContain(frame);expect(iron.ammoRemaining()).toBe(10);
  });
  it('rejects unknown templates and fully broken initial frames without consuming them',()=>{
    const {game,x,y,z,plan,frame}=setup();
    expect(startChassis(game,{...plan,template:'missing' as any},x,y,z)).toBeNull();
    frame.damage=4000;expect(startChassis(game,plan,x,y,z)).toBeNull();expect(game.player.inv.allItems()).toContain(frame);
  });
  it('cannot finish if a reserved non-frame component goes missing',()=>{
    const {game,x,y,z,plan}=setup();const site=startChassis(game,plan,x,y,z)!;
    const rope=site.contents.find(i=>i.typeId==='rope_6')!;consumeItem(rope,L.in(site));
    game.activities.update(game,1,10000);
    expect(game.vehicles!.list).toHaveLength(0);expect(chassisReasons(game,plan,x,y,z,site).some(r=>r.includes('Reserved supplies missing'))).toBe(true);
  });
  it('keeps authored minimum footprints for the rig and other templates',()=>{
    expect(chassisCells('rig')).toHaveLength(50);expect(chassisCells('sedan')).toHaveLength(15);
  });
  it('never consumes gameplay vehicle identities when browsing previews',()=>{
    const {game,x,y,z,plan}=setup();const before=new Vehicle(vd,'car');
    for(let i=0;i<20;i++){chassisFootprint(game,{...plan,template:i%2?'rig':'sedan'},x,y,z);chassisReasons(game,plan,x,y,z);}
    expect(new Vehicle(vd,'car').uid).toBe(before.uid+1);
  });
  it('matches sequential frame practice and discounted additional-frame work time',()=>{
    const {game,x,y,z,plan}=setup();const expected=setup().game;plan.template='hatch';
    game.player.setSkill('mechanics',3);expected.player.setSkill('mechanics',3);
    const n=chassisCells(plan.template).length;
    for(let i=1;i<n;i++)for(const id of ['frame_wood_light','rope_6'])spawnItem(createItem(data,id),L.inv(game.player),{force:true});
    for(const [tx,ty]of chassisFootprint(game,plan,x,y,z)){game.map.setTer(tx,ty,z,'t_floor');game.map.setFurn(tx,ty,z,'f_null');game.map.chunk(chunkOf(tx),chunkOf(ty),z)!.omt={id:'s_garage',source:'test'};}
    const raw=vd.parts[plan.frame].requirements!.install!;
    expect(chassisRequirement(game,plan)!.seconds).toBe(600+vehicleWorkSeconds(game,raw)*(n-1));
    const site=startChassis(game,plan,x,y,z);expect(site).toBeTruthy();game.activities.update(game,1,100000);
    const initial=data.misc.construction.constr_veh as ConstructionDef;
    for(const p of constructionPractice(initial))expected.player.practice(p.skill,p.amount,p.cap);
    for(let i=1;i<n;i++)vehiclePartPractice(expected,vd.parts[plan.frame],'install');
    expect(game.player.skills).toEqual(expected.player.skills);expect(game.player.focus).toBe(expected.player.focus);
  });
  it('uses the actual body outline to reject an obstruction at the authored body edge',()=>{
    const {game,x,y,z,plan}=setup(); plan.template='sedan';
    const view=new Vehicle(vd,'car');view.template=plan.template;view.x=x+0.5;view.y=y+0.5;
    for(const [mx,my]of chassisCells(plan.template))view.addPart(vd.parts[plan.frame],mx,my);
    const body=chassisBodyRect(view)!;expect(body).toBeTruthy();
    const [wx,wy]=view.mountToWorld(body.x1-1e-5,(body.y0+body.y1)/2);
    const edge:[number,number]=[Math.floor(wx),Math.floor(wy)];
    expect(chassisFootprint(game,plan,x,y,z)).toContainEqual(edge);
    for(const [tx,ty]of chassisFootprint(game,plan,x,y,z)){game.map.setTer(tx,ty,z,'t_floor');game.map.setFurn(tx,ty,z,'f_null');game.map.chunk(chunkOf(tx),chunkOf(ty),z)!.omt={id:'s_garage',source:'test'};}
    game.map.setTer(edge[0],edge[1],z,'t_wall');
    expect(chassisReasons(game,plan,x,y,z).some(r=>r.includes('Clear the garage footprint'))).toBe(true);
  });
});
