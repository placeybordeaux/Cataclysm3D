import type { Game } from './game';
import type { VPartDef, VPartWorkRequirement } from './vehicle_data';
import { chassisOf, mapChassis } from './chassis';
import { CraftingInventory } from './crafting_inv';
import { consumeRequirements, evaluateRequirements } from './requirements';
import { createItem, Item, MAX_ITEM_DAMAGE } from './item';
import { spawnOnGround, transaction } from './moves';
import { has, type Vehicle, type VehiclePart } from './vehicle';
import { isVehicleGarage } from './vehicleGarage';
import { addVehicleCraftingSources } from './vehicleFacilities';

export interface VehicleWorkOrder {
  kind: 'install' | 'removal' | 'repair';
  part: string;
  mx: number;
  my: number;
  elapsed: number;
}
function target(v: Vehicle, order: VehicleWorkOrder): VehiclePart | undefined {
  return v.partsAt(order.mx, order.my).find(p => p.def.id === order.part);
}
function inventory(game: Game) { return addVehicleCraftingSources(game, CraftingInventory.gather(game.data, game.player, game.map, game.player)); }
function workInventory(game: Game, v: Vehicle, order: VehicleWorkOrder): CraftingInventory {
  const inv = inventory(game);
  if (order.kind !== 'install') return inv;
  const baseId = v.vdata.parts[order.part]?.item;
  // Filter BEFORE any query/cache: consumeRequirements uses this same deterministic set.
  for (let i = inv.sources.length - 1; i >= 0; i--) {
    const it = inv.sources[i].item;
    if (it.typeId === baseId && (it.ammoRemaining() > 0 || it.contents.length || it.magazine || it.gunmods.length)) inv.sources.splice(i, 1);
  }
  return inv;
}
export function vehicleWorkSeconds(game: Game, raw: VPartWorkRequirement): number {
  const excess = raw.skills.reduce((sum, [skill, level]) => sum + Math.max(0, Math.min(10, game.player.getSkill(skill)) - level), 0);
  const speed = raw.skills.length ? 1 - Math.min(0.5, excess / raw.skills.length / 10) : 1;
  return raw.seconds * speed;
}
export function vehicleWorkRequirement(game: Game, v: Vehicle, order: VehicleWorkOrder): VPartWorkRequirement | undefined {
  const raw = v.vdata.parts[order.part]?.requirements?.[order.kind];
  if (!raw) return undefined;
  if (order.kind !== 'repair') return { ...raw, seconds: vehicleWorkSeconds(game, raw) };
  const part = target(v, order);
  const fraction = part ? 1 - part.hp / part.def.durability : 1;
  const damage = Math.round(fraction * MAX_ITEM_DAMAGE);
  const level = damage > 0 ? Math.floor(3 * (damage - 1) / (MAX_ITEM_DAMAGE - 1)) + 1 : 0;
  return { ...raw, seconds: vehicleWorkSeconds(game, raw) * fraction,
    components: raw.components.map(group => group.map(c => ({ ...c, count: c.count * level }))),
    tools: raw.tools.map(group => group.map(c => ({ ...c, count: c.count > 0 ? c.count * level : c.count }))),
  };
}
export function vehiclePartPractice(game: Game, def: VPartDef, kind: VehicleWorkOrder['kind']): void {
  const install = def.requirements?.install;
  const skills = kind === 'repair' ? def.requirements?.repair?.skills : install?.skills;
  for (const [skill] of skills ?? []) {
    const required = install?.skills.find(([id]) => id === skill)?.[1];
    if (required === undefined || !install) continue;
    const excess = Math.max(game.player.getSkill(skill) - required, 1);
    const amount = Math.ceil(install.seconds / (60 * excess * excess) * Math.max(required, 1));
    game.player.practice(skill, kind === 'removal' ? Math.floor(amount / 2) : amount);
  }
}

/** Every failure remains visible in the work panel. */
export function vehicleWorkReasons(game: Game, v: Vehicle, order: VehicleWorkOrder, planning = false): string[] {
  const errors: string[] = [];
  const def = v.vdata.parts[order.part];
  if (!def) return ['Unknown part'];
  if (!v.adopted) errors.push('Adopt this vehicle first');
  if (v.locked) errors.push('Unlock the vehicle first');
  if (Math.abs(v.velocity) > 0.05 || v.engineOn || game.vehicles?.driving?.uid === v.uid) errors.push('Park, stop the engine and release the controls first');
  const [x, y] = v.mountToWorld(order.mx, order.my);
  if (!planning && (game.player.z !== v.z || Math.hypot(game.player.x - x, game.player.y - y) > 4)) errors.push('Move within four metres of this square');
  const inv = workInventory(game, v, order);
  const req = vehicleWorkRequirement(game, v, order);
  if (!req) errors.push('This part has no supported work requirements');
  else {
    for (const [skill, level] of req.skills) if (game.player.getSkill(skill) < level) errors.push(`${game.player.skillName(skill)} ${level} required`);
    errors.push(...evaluateRequirements(game.data, req, inv).missing);
  }
  if (def.flags.includes('NEEDS_JACKING')) {
    const rating = Math.ceil(Math.min(v.mass(), 8500) / 500);
    if (!inv.hasQuality('JACK', rating) && !v.withFlag('SELF_JACK', true).length) errors.push(`Need JACK ${rating} (${rating * 500} kg rating) for this chassis`);
  }
  if (order.kind === 'install') {
    errors.push(...mountReasons(v, def, order.mx, order.my));
    if (inventory(game).sources.some(s => s.item.typeId === def.item && s.loc && !s.worn) && !inv.componentSources(def.item).length) errors.push('Unload and empty the part before installing it');
  }
  else {
    const p = target(v, order);
    if (!p) errors.push('That part is no longer installed');
    // A tow cable links two vehicles (towing.ts): detaching takes both parts off and gives the cable back once.
    else if (has(p, 'TOW_CABLE')) errors.push('Detach the tow cable from the vehicle menu instead');
    else if (order.kind === 'removal') {
      if (p.charges > 0) errors.push('Empty the fuel or battery before removing it');
      if (p.items.length) errors.push('Empty the cargo before removing it');
      if (p.def.location === 'structure' || has(p,'EXTENDABLE')) errors.push(...structuralRemovalReasons(game,v,p));
      for (const attached of v.partsAt(p.mx, p.my)) if (attached !== p && attached.def.anchors?.some(flag => has(p, flag))) errors.push(`Remove the attached ${attached.def.name} first`);
      if (!game.data.items[p.def.item]) errors.push('The removed item definition is unavailable');
      if (p.hp <= 0 && p.def.breaksInto?.some(y => !game.data.items[y.item])) errors.push('A salvage item definition is unavailable');
      if (p.hp <= 0 && !p.def.breaksInto?.length) errors.push('No supported salvage yield for this broken part');
    } else {
      if (p.hp <= 0) errors.push('Broken parts must be replaced');
      if (p.hp >= p.def.durability) errors.push('This part is already fully repaired');
      if (has(p, 'NO_REPAIR')) errors.push('This part cannot be repaired');
    }
  }
  return [...new Set(errors)];
}

/** BN can_unmount: fittings first, then preserve paths between the removed square's neighbours. */
export function structuralRemovalReasons(game: Game, v: Vehicle, part: VehiclePart): string[] {
  const reasons: string[]=[];
  const [x,y]=v.mountToWorld(part.mx,part.my);
  if (part.def.location==='structure' && !isVehicleGarage(game,Math.floor(x),Math.floor(y),v.z)) reasons.push('Dismantle chassis frames at a ground-level vehicle garage');
  const here=v.partsAt(part.mx,part.my);
  if(here.some(p=>p!==part&&p.def.location!=='structure'&&!has(p,'EXTENDABLE'))) reasons.push('Remove all attached fittings from this part first');
  if(here.length>1) return reasons;
  const cells=new Set(v.parts.filter(p=>p!==part).map(p=>`${p.mx},${p.my}`));
  const neighbours=([[-1,0],[1,0],[0,-1],[0,1]] as const).map(([dx,dy])=>`${part.mx+dx},${part.my+dy}`).filter(k=>cells.has(k));
  if(neighbours.length>1){
    const visited=new Set<string>([neighbours[0]]), todo=[neighbours[0]];
    for(let i=0;i<todo.length;i++){
      const [mx,my]=todo[i].split(',').map(Number);
      for(const [dx,dy]of [[-1,0],[1,0],[0,-1],[0,1]]){
        const key=`${mx+dx},${my+dy}`;
        if(cells.has(key)&&!visited.has(key)){visited.add(key);todo.push(key);}
      }
    }
    if(neighbours.some(k=>!visited.has(k))) reasons.push('Removing this part would split the vehicle');
  }
  return reasons;
}

export function mountReasons(v: Vehicle, def: VPartDef, mx: number, my: number): string[] {
  const parts = v.partsAt(mx, my);
  const reasons: string[] = [];
  if (def.flags.includes('NOINSTALL')) reasons.push('This part cannot be installed');
  if (!parts.some(p => p.def.location === 'structure' && p.hp > 0)) reasons.push('A chassis frame is needed at this square');
  if (parts.some(p => p.def.id === def.id || (def.location && p.def.location === def.location))) reasons.push('This location is occupied');
  if (def.flags.includes('CARGO') && parts.some(p => has(p, 'CARGO'))) reasons.push('This square already has cargo');
  if (parts.some(p => has(p, 'PROTRUSION') || has(p, 'NOCOLLIDE') || has(p, 'ANIMAL_CTRL') || has(p,'EXTENDABLE'))) reasons.push('This square cannot hold attachments');
  if(def.engineExcludes?.length) for(const engine of v.withFlag('ENGINE')) {
    const conflict=def.engineExcludes.find(c=>engine.def.engineExcludes?.includes(c));
    if(conflict) {reasons.push(`Conflicts with ${engine.def.name} (${conflict} engine class)`);break;}
  }
  if(def.flags.includes('VISION')&&!def.flags.includes('CAMERA')&&parts.some(p=>has(p,'OPAQUE'))) reasons.push('A mirror cannot share a square with an opaque part');
  if(def.flags.includes('OPAQUE')&&parts.some(p=>has(p,'VISION')&&!has(p,'CAMERA'))) reasons.push('An opaque part cannot share a square with a mirror');
  if(def.flags.includes('TURRET_MOUNT')&&parts.some(p=>has(p,'TURRET_MOUNT'))) reasons.push('This square already has a turret mount');
  if((def.flags.includes('TURRET_CONTROLS')||def.flags.includes('LASER_DESIGNATOR'))&&parts.some(p=>has(p,'MANUAL'))) reasons.push('Manual-only turrets cannot use turret controls or laser designators');
  for (const anchor of def.anchors ?? []) if (!parts.some(p => p.hp > 0 && has(p, anchor))) reasons.push(`Needs an intact ${anchor.toLowerCase().replaceAll('_', ' ')} mount`);
  const candidate = { def, mx, my, hp: def.durability } as VehiclePart;
  const view = Object.assign(Object.create(Object.getPrototypeOf(v)), v, { parts: [...v.parts, candidate] }) as Vehicle;
  const overflow = mapChassis(view, chassisOf(v).template, 'saved').overflow.find(o => o.part === candidate);
  if (overflow) reasons.push(overflow.reason);
  return reasons;
}

export function adoptVehicle(game: Game, v: Vehicle): string {
  if (v.locked) return 'Unlock the vehicle before adopting it.';
  v.adopted = true;
  chassisOf(v);
  return `You adopt the ${v.name}. You can now plan work on its chassis.`;
}

/** A disposable geometry view. Queue previews never mutate real parts or supplies. */
export function projectedVehicle(v: Vehicle, orders = v.workOrders): Vehicle {
  const view = Object.assign(Object.create(Object.getPrototypeOf(v)), v,
    { parts: [], byMount: new Map(), chassis: null, workOrders: [] }) as Vehicle;
  for (const original of v.parts) Object.assign(view.addPart(original.def, original.mx, original.my, original.variant), original);
  for (const order of orders) {
    const def = v.vdata.parts[order.part];
    if (!def) continue;
    if (order.kind === 'install') {
      if (!mountReasons(view, def, order.mx, order.my).length) view.addPart(def, order.mx, order.my);
    } else {
      const p = target(view, order);
      if (!p) continue;
      if (order.kind === 'removal') view.removePart(p);
      else p.hp = p.def.durability;
    }
  }
  return view;
}

export function queueVehicleWork(game: Game, v: Vehicle, order: Omit<VehicleWorkOrder, 'elapsed'>): string {
  const job = { ...order, elapsed: 0 };
  const errors = vehicleWorkReasons(game, projectedVehicle(v), job, true);
  if (errors.length) return errors.join('; ');
  v.workOrders.push(job);
  return `Queued ${job.kind}: ${v.vdata.parts[job.part].name}.`;
}

/** Schedule removable fittings across the body, resolving attachment dependencies first. */
export function queueVehicleStrip(game: Game, v: Vehicle): { queued: number; blocked: string[] } {
  const view = projectedVehicle(v);
  const pending = view.parts.filter(p => p.def.location !== 'structure');
  let queued = 0;
  let changed = true;
  while (changed && pending.length) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      const job: VehicleWorkOrder = { kind: 'removal', part: p.def.id, mx: p.mx, my: p.my, elapsed: 0 };
      if (vehicleWorkReasons(game, view, job, true).length) continue;
      v.workOrders.push(job);
      view.removePart(p);
      pending.splice(i, 1); queued++; changed = true;
    }
  }
  return { queued, blocked: pending.map(p => `${p.def.name} (${p.mx},${p.my}): ${vehicleWorkReasons(game, view,
    { kind: 'removal', part: p.def.id, mx: p.mx, my: p.my, elapsed: 0 }, true).join('; ')}`) };
}

function complete(game: Game, v: Vehicle, order: VehicleWorkOrder): void {
  const def = v.vdata.parts[order.part];
  const removalBroken = order.kind === 'removal' && (target(v, order)?.hp ?? 0) <= 0;
  const inv = workInventory(game, v, order);
  // Item movement transactions restore component locations. Tool ammunition consumption
  // changes the item in place, so retain that state too if a later shared tool group fails.
  const ammunition = new Map(inv.sources.flatMap(source => [...source.item.walk()]).map(item => [item, { charges: item.charges, ammoId: item.ammoId }]));
  let used: ReturnType<typeof consumeRequirements>;
  try { used = transaction(() => consumeRequirements(vehicleWorkRequirement(game, v, order)!, inv)); }
  catch (error) {
    for (const [item, before] of ammunition) { item.charges = before.charges; item.ammoId = before.ammoId; }
    throw error;
  }
  if (order.kind === 'install') {
    const p = v.addPart(def, order.mx, order.my);
    const base = used.items.find(it => it.typeId === def.item);
    if (base) {
      p.hp = Math.max(1, Math.round(def.durability * (1 - Math.max(0, base.damage) / MAX_ITEM_DAMAGE)));
      p.installedItem = base.toJSON();
      // A turret's gun is the installed gun, with whatever it was loaded with (BN: the base).
      if (has(p, 'TURRET')) {
        p.gun = Item.fromJSON(game.data, base.toJSON());
        if (!p.gun.flags.includes('VEHICLE')) p.gun.flags.push('VEHICLE');
      }
    }
  } else {
    const p = target(v, order)!;
    if (order.kind === 'repair') p.hp = def.durability;
    else {
      const [x, y] = v.mountToWorld(p.mx, p.my);
      if (p.hp > 0) {
        // A turret comes off as its gun, rounds and belt still in it (BN vehicle_part::
        // properties_to_item: a copy of the base item, VEHICLE flag dropped).
        const gun = p.gun ? Item.fromJSON(game.data, p.gun.toJSON()) : null;
        if (gun) gun.flags = gun.flags.filter((f) => f !== 'VEHICLE');
        const item = gun ?? (p.installedItem ? Item.fromJSON(game.data, p.installedItem) : createItem(game.data, def.item, { charges: 0 }));
        item.damage = Math.min(MAX_ITEM_DAMAGE - 1, Math.round((1 - p.hp / def.durability) * MAX_ITEM_DAMAGE));
        if (!gun) item.charges = 0;
        spawnOnGround(game.map, Math.floor(x), Math.floor(y), v.z, item);
      } else for (const yieldDef of def.breaksInto ?? []) {
        const amount = game.player.rng.int(yieldDef.count[0], yieldDef.count[1]);
        if (amount <= 0) continue;
        const sample = createItem(game.data, yieldDef.item);
        if (sample.countByCharges) {
          sample.charges = amount;
          spawnOnGround(game.map, Math.floor(x), Math.floor(y), v.z, sample);
        } else for (let i = 0; i < amount; i++) spawnOnGround(game.map, Math.floor(x), Math.floor(y), v.z, i === 0 ? sample : createItem(game.data, yieldDef.item));
      }
      v.removePart(p);
    }
  }
  if (!removalBroken) {
    vehiclePartPractice(game,def,order.kind);
  }
  v.version++;
  v.chassis = null;
  if(v.parts.length) game.vehicles?.reindex(v);
  else game.vehicles?.remove(v);
  game.message(`Finished ${order.kind}: ${def.name}.`, 'c_light_green');
}

/** Saved on the vehicle. Interruption keeps elapsed work; recheck tools/materials per job. */
export function startVehicleWork(game: Game, v: Vehicle): boolean {
  const next = v.workOrders[0];
  if (!next) { game.message('No vehicle work is queued.'); return false; }
  const errors = vehicleWorkReasons(game, v, next);
  if (errors.length) { game.message(errors.join('; '), 'c_yellow'); return false; }
  const req = vehicleWorkRequirement(game, v, next)!;
  let aborted = false;
  return game.activities.start({
    name: `${next.kind}: ${v.vdata.parts[next.part].name}`,
    duration: Math.max(0.01, req.seconds - next.elapsed),
    kind: 'vehicle_work', target: v,
    at: { x: Math.floor(v.x), y: Math.floor(v.y), z: v.z },
    onProgress: dt => {
      const errors = vehicleWorkReasons(game, v, next);
      if (errors.length) { aborted = true; game.activities.cancel(errors.join('; ')); return; }
      next.elapsed = Math.min(req.seconds, next.elapsed + dt);
    },
    onComplete: () => {
      if (aborted || v.workOrders[0] !== next) return;
      const errors = vehicleWorkReasons(game, v, next);
      if (errors.length) { game.message(errors.join('; '), 'c_yellow'); return; }
      try { complete(game, v, next); }
      catch { game.message('Vehicle work stopped: materials or tools changed.', 'c_yellow'); return; }
      v.workOrders.shift();
      if (v.workOrders.length) startVehicleWork(game, v);
    },
    onCancel: () => game.message('Queued vehicle work and progress are kept. Resume from the vehicle panel.'),
  });
}
