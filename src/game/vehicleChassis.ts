import type { Game } from './game';
import { Item, createItem, MAX_ITEM_DAMAGE } from './item';
import { CraftingInventory } from './crafting_inv';
import { addVehicleCraftingSources } from './vehicleFacilities';
import { consumeRequirements, evaluateRequirements } from './requirements';
import { consumeItem, L, moveItem, spawnOnGround, transaction } from './moves';
import { Vehicle } from './vehicle';
import type { VPartWorkRequirement } from './vehicle_data';
import { TEMPLATES, type TemplateId } from './chassis/templates';
import { chassisBodyRect } from './chassis';
import { obbBounds, obbHitsTile, rectObb } from './vehicleShape';
import type { VehicleDataFile } from './vehicle_data';
import { isVehicleGarage } from './vehicleGarage';
export { isVehicleGarage } from './vehicleGarage';
import { vehiclePartPractice, vehicleWorkSeconds } from './vehicleWork';
import { constructionPractice } from './practice';
import type { ConstructionDef } from './construction';

export interface ChassisPlan { template: TemplateId; frame: string; name: string; elapsed: number }
export function chassisCells(template: TemplateId): [number, number][] {
  const t = TEMPLATES[template];
  if (!t) return [];
  const cells: [number, number][] = [];
  for (let mx = 0; mx < t.rows[0]; mx++) for (let my = 0; my < t.cols[0]; my++) cells.push([mx, my]);
  return cells;
}
const previews = new WeakMap<VehicleDataFile, Map<string, Vehicle>>();
export function chassisFootprint(game: Game, plan: ChassisPlan, x: number, y: number, z: number): [number, number][] {
  const vd = game.vehicles?.vdata;
  if (!vd?.parts[plan.frame] || !chassisCells(plan.template).length) return [];
  const cache = previews.get(vd) ?? new Map<string, Vehicle>(); previews.set(vd, cache);
  const key = `${plan.template}:${plan.frame}`;
  let view = cache.get(key);
  if (!view) {
    // A layout-only view has no gameplay identity. Browsing templates must not allocate UIDs.
    view = Object.assign(Object.create(Vehicle.prototype), { vdata: vd, protoId: 'car', uid: -1,
      name: 'Chassis preview', x: 0, y: 0, z: 0, facing: 0, velocity: 0, steer: 0, cruiseVelocity: 0,
      engineOn: false, lightsOn: false, locked: false, alarmOn: false, paint: 0x8a8f96,
      parts: [], byMount: new Map(), adopted: false, workOrders: [], version: 0,
      template: plan.template, chassis: null }) as Vehicle;
    for (const [mx, my] of chassisCells(plan.template)) view.addPart(vd.parts[plan.frame],mx,my);
    cache.set(key,view);
  }
  view.x=x+0.5;view.y=y+0.5;view.z=z;
  const tiles = new Map(chassisCells(plan.template).map(([mx,my]) => [`${x+mx},${y+my}`, [x+mx,y+my] as [number,number]]));
  const body = chassisBodyRect(view);
  if (body) {
    const obb=rectObb(view,body), [x0,y0,x1,y1]=obbBounds(obb);
    for(let tx=Math.floor(x0);tx<=Math.floor(x1);tx++)for(let ty=Math.floor(y0);ty<=Math.floor(y1);ty++)
      if(obbHitsTile(obb,tx,ty))tiles.set(`${tx},${ty}`,[tx,ty]);
  }
  return [...tiles.values()];
}
export function chassisRequirement(game: Game, plan: ChassisPlan): VPartWorkRequirement | null {
  const def = game.vehicles?.vdata.parts[plan.frame];
  const raw = def?.requirements?.install;
  if (!raw || def.location !== 'structure' || !def.flags.includes('INITIAL_PART') || !chassisCells(plan.template).length) return null;
  const n = chassisCells(plan.template).length;
  return { ...raw, seconds: 600 + vehicleWorkSeconds(game,raw) * Math.max(0, n - 1),
    components: raw.components.map(g => g.map(c => ({ ...c, count: c.count * n }))),
    tools: raw.tools.map(g => g.map(c => ({ ...c, count: c.count > 0 ? c.count * n : c.count }))) };
}
function inventory(game: Game, frameItem?: string) {
  const inv = addVehicleCraftingSources(game, CraftingInventory.gather(game.data, game.player, game.map, game.player));
  if (frameItem) for (let i=inv.sources.length-1;i>=0;i--) {
    const item=inv.sources[i].item;
    if (item.typeId===frameItem && (item.ammoRemaining()>0 || item.contents.length || item.magazine || item.gunmods.length || item.damage>=MAX_ITEM_DAMAGE)) inv.sources.splice(i,1);
  }
  return inv;
}
export function chassisSitePlan(site: Item): ChassisPlan | null {
  if (!site.isCraft() || typeof site.vars.vehicle_chassis !== 'string') return null;
  try {
    const p = JSON.parse(site.vars.vehicle_chassis) as ChassisPlan;
    return TEMPLATES[p.template] && typeof p.frame === 'string' && typeof p.name === 'string' && Number.isFinite(p.elapsed) && p.elapsed >= 0 ? p : null;
  } catch { return null; }
}
export function chassisReasons(game: Game, plan: ChassisPlan, x: number, y: number, z: number, site?: Item): string[] {
  const reasons: string[] = [];
  const req = chassisRequirement(game, plan);
  if (!game.vehicles || !req) return ['Select a supported initial frame and chassis.'];
  if (!isVehicleGarage(game, x, y, z)) reasons.push('Build chassis at a ground-level vehicle garage.');
  if (game.player.z !== z || Math.hypot(game.player.x - x - 0.5, game.player.y - y - 0.5) > 4) reasons.push('Stand within four metres of the build site.');
  for (const [tx,ty] of chassisFootprint(game,plan,x,y,z)) {
    if (!isVehicleGarage(game, tx, ty, z) || !game.map.passable(tx, ty, z) || game.map.furnAt(tx, ty, z).id !== 'f_null' || game.vehicles.at(tx, ty, z) || game.creatureAt(tx, ty, z)) {
      reasons.push(`Clear the garage footprint at ${tx},${ty}.`); break;
    }
    if (game.map.itemsAt(tx, ty, z).some(item => item !== site)) { reasons.push(`Clear loose items from ${tx},${ty}.`); break; }
  }
  for (const [skill, level] of req.skills) if (game.player.getSkill(skill) < level) reasons.push(`${game.player.skillName(skill)} ${level} required`);
  const checkReq = site ? { ...req, components: [], tools: req.tools.map(g => g.map(t => ({ ...t, count: -1 }))) } : req;
  reasons.push(...evaluateRequirements(game.data, checkReq, inventory(game,game.vehicles.vdata.parts[plan.frame].item)).missing);
  if (site) {
    if (!game.map.itemsAt(x, y, z).includes(site)) reasons.push('The unfinished chassis is no longer at this site.');
    const frameItem = game.vehicles.vdata.parts[plan.frame].item;
    const frames = site.contents.filter(item => item.typeId === frameItem);
    if (frames.length !== chassisCells(plan.template).length || frames.some(item=>item.damage>=MAX_ITEM_DAMAGE || item.contents.length || item.ammoRemaining()>0 || item.magazine || item.gunmods.length)) reasons.push('Reserved usable empty frames are missing.');
    const reserved = new CraftingInventory(game.data,game.player,game.map,game.player);
    for (const item of site.contents) reserved.sources.push({item,kind:'map',loc:L.in(site),parent:site,x,y,z});
    for (const missing of evaluateRequirements(game.data,{components:req.components,tools:[],qualities:[]},reserved).missing)
      reasons.push(`Reserved supplies missing: ${missing}`);
  }
  return [...new Set(reasons)];
}

export function startChassis(game: Game, plan: ChassisPlan, x: number, y: number, z: number): Item | null {
  const reasons = chassisReasons(game, plan, x, y, z);
  if (reasons.length) { game.message(reasons.join('; '), 'c_yellow'); return null; }
  const site = createItem(game.data, 'craft');
  site.vars.vehicle_chassis = JSON.stringify({ ...plan, elapsed: 0 });
  site.vars.craft_label = `unfinished ${plan.name || TEMPLATES[plan.template].name} chassis`;
  const inv = inventory(game,game.vehicles!.vdata.parts[plan.frame].item);
  const ammo = new Map(inv.sources.flatMap(s => [...s.item.walk()]).map(i => [i, { charges: i.charges, ammoId: i.ammoId }]));
  try {
    transaction(() => {
      consumeRequirements(chassisRequirement(game, plan)!, inv, 1, L.in(site));
      spawnOnGround(game.map, x, y, z, site);
    });
  } catch {
    for (const [item, before] of ammo) { item.charges = before.charges; item.ammoId = before.ammoId; }
    game.message('Chassis supplies changed; nothing was reserved.', 'c_yellow'); return null;
  }
  continueChassis(game, site, x, y, z);
  return site;
}

export function continueChassis(game: Game, site: Item, x: number, y: number, z: number): boolean {
  const plan = chassisSitePlan(site);
  if (!plan) return false;
  const reasons = chassisReasons(game, plan, x, y, z, site);
  if (reasons.length) { game.message(reasons.join('; '), 'c_yellow'); return false; }
  const req = chassisRequirement(game, plan)!;
  let aborted = false;
  return game.activities.start({ name: `building ${plan.name || TEMPLATES[plan.template].name} chassis`, kind: 'vehicle_chassis', target: site,
    duration: Math.max(0.01, req.seconds - plan.elapsed), at: { x, y, z },
    onProgress: dt => {
      const errors = chassisReasons(game, plan, x, y, z, site);
      if (errors.length) { aborted = true; game.activities.cancel(errors.join('; ')); return; }
      plan.elapsed = Math.min(req.seconds, plan.elapsed + dt); site.vars.vehicle_chassis = JSON.stringify(plan);
    },
    onComplete: () => {
      if (aborted || chassisReasons(game, plan, x, y, z, site).length) return;
      const vd = game.vehicles!.vdata;
      const vehicle = new Vehicle(vd, Object.keys(vd.vehicles)[0]);
      vehicle.name = plan.name || TEMPLATES[plan.template].name; vehicle.template = plan.template;
      vehicle.x = x + 0.5; vehicle.y = y + 0.5; vehicle.z = z; vehicle.adopted = true;
      const frames = site.contents.filter(i => i.typeId === vd.parts[plan.frame].item);
      chassisCells(plan.template).forEach(([mx, my], index) => {
        const part = vehicle.addPart(vd.parts[plan.frame], mx, my);
        part.hp = part.def.durability * (1 - Math.min(MAX_ITEM_DAMAGE, Math.max(0, frames[index].damage)) / MAX_ITEM_DAMAGE);
        part.installedItem = frames[index].toJSON();
      });
      transaction(() => { for (const item of [...site.contents]) consumeItem(item, L.in(site)); consumeItem(site, L.ground(game.map, x, y, z)); });
      game.vehicles!.add(vehicle);
      const initial = game.data.misc.construction?.constr_veh as ConstructionDef | undefined;
      if (initial) for (const p of constructionPractice(initial)) game.player.practice(p.skill,p.amount,p.cap);
      for (let i=1;i<chassisCells(plan.template).length;i++) vehiclePartPractice(game,vd.parts[plan.frame],'install');
      game.message(`Finished ${vehicle.name} chassis. Adopted and ready for fittings.`, 'c_light_green');
    },
    onCancel: () => game.message('Unfinished chassis, reserved supplies and progress remain at the build site.'),
  });
}
export function cancelChassis(game: Game, site: Item, x: number, y: number, z: number): boolean {
  if (!chassisSitePlan(site) || !game.map.itemsAt(x, y, z).includes(site) || game.player.z !== z || Math.hypot(game.player.x-x-0.5, game.player.y-y-0.5) > 4) return false;
  if (game.activities.current?.spec.target === site) game.activities.cancel('cancelled chassis');
  transaction(() => {
    for (const item of [...site.contents]) if (!moveItem(item, L.in(site), L.ground(game.map, x, y, z), { force: true, quiet: true }).ok) throw new Error('Cannot return chassis supplies');
    consumeItem(site, L.ground(game.map, x, y, z));
  });
  return true;
}
