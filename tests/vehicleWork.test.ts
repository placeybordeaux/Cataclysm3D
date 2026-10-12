import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadNodeData } from '../tools/lib/node_data';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { VehicleSystem } from '../src/game/vehicles';
import { adoptVehicle, mountReasons, projectedVehicle, queueVehicleStrip, queueVehicleWork, startVehicleWork, vehicleWorkReasons } from '../src/game/vehicleWork';
import { createItem, Item, loadAmmo, MAX_ITEM_DAMAGE } from '../src/game/item';
import { L, spawnItem, consumeItem } from '../src/game/moves';
let data: ReturnType<typeof loadNodeData>['game'];
let vdata: VehicleDataFile;
beforeAll(() => { data = loadNodeData().game; vdata = JSON.parse(readFileSync('public/data/vehicles.json', 'utf8')); });
function setup() {
  const game = new Game(data, 1, { held: new Set(), captured: false, onPress() {}, consumeMouse: () => [0, 0] } as any);
  const v = new Vehicle(vdata, 'car');
  const frameDef = vdata.parts.frame_vertical;
  v.addPart(frameDef, 0, 0);
  const solar = v.addPart(vdata.parts.solar_panel, 0, 0);
  v.x = game.player.x; v.y = game.player.y; v.z = game.player.z;
  game.vehicles = new VehicleSystem(game, vdata);
  game.vehicles.add(v);
  game.player.setSkill('mechanics', 2);
  spawnItem(createItem(data, 'wrench'), L.inv(game.player), { force: true });
  return { game, v, solar };
}
function order(kind: 'install' | 'removal' | 'repair', part = 'solar_panel') { return { kind, part, mx: 0, my: 0, elapsed: 0 }; }
function advance(game: Game, seconds: number) { game.activities.update(game, 1, seconds); }
describe('requirements-aware vehicle work', () => {
  it('schedules distant stripping while retaining frames and reporting loaded parts', () => {
    const { game, v, solar } = setup();
    adoptVehicle(game, v);
    v.addPart(vdata.parts.frame_vertical, 10, 0);
    const distant = v.addPart(vdata.parts.solar_panel, 10, 0);
    const battery = v.addPart(vdata.parts.battery_car, 0, 0); battery.charges = 50;
    const before = v.toJSON();
    const result = queueVehicleStrip(game, v);
    expect(result.queued).toBe(2);
    expect(result.blocked.some(reason => reason.includes('Empty the fuel or battery'))).toBe(true);
    expect(v.parts).toContain(solar); expect(v.parts).toContain(distant);
    expect(v.toJSON().parts).toEqual(before.parts);
    expect(v.workOrders.every(job => v.vdata.parts[job.part].location !== 'structure')).toBe(true);
    expect(vehicleWorkReasons(game, v, v.workOrders.find(job => job.mx === 10)!)).toContain('Move within four metres of this square');
    expect(queueVehicleStrip(game, v).queued).toBe(0);
  });
  it('orders stripping so attached fittings are removed before their mount', () => {
    const { game, v } = setup();
    const attached = { ...vdata.parts.solar_panel, id: 'test_attached_panel', anchors: ['SOLAR_PANEL'] };
    const localData = { ...vdata, parts: { ...vdata.parts, [attached.id]: attached } };
    const vehicle = new Vehicle(localData, 'car');
    vehicle.x = v.x; vehicle.y = v.y; vehicle.z = v.z;
    vehicle.addPart(vdata.parts.frame_vertical, 0, 0);
    // Deliberately put the attached part before the mount in the part array.
    vehicle.addPart(attached, 0, 0);
    vehicle.addPart(vdata.parts.solar_panel, 0, 0);
    adoptVehicle(game, vehicle);
    const result = queueVehicleStrip(game, vehicle);
    expect(result.blocked).toEqual([]);
    expect(vehicle.workOrders.map(job => job.part)).toEqual([attached.id, 'solar_panel']);
  });
  it('projects ordered removals, installs and repairs without changing live state', () => {
    const { v, solar } = setup();
    solar.hp /= 2;
    const before = v.toJSON();
    const repaired = projectedVehicle(v, [order('repair')]);
    expect(repaired.partsAt(0, 0).find(p => p.def.id === 'solar_panel')!.hp).toBe(solar.def.durability);
    const removed = projectedVehicle(v, [order('removal')]);
    expect(mountReasons(removed, vdata.parts.solar_panel, 0, 0)).toEqual([]);
    const replaced = projectedVehicle(v, [order('removal'), order('install')]);
    expect(replaced.parts.filter(p => p.def.id === 'solar_panel')).toHaveLength(1);
    expect(replaced.partsAt(0, 0).find(p => p.def.id === 'solar_panel')!.hp).toBe(solar.def.durability);
    expect(v.toJSON()).toEqual(before);
  });
  it('queues remove-then-replace against planned geometry and completes in order', () => {
    const { game, v, solar } = setup();
    adoptVehicle(game, v);
    game.player.setSkill('mechanics', 4);
    spawnItem(createItem(data, 'solar_panel'), L.inv(game.player), { force: true });
    expect(queueVehicleWork(game, v, order('removal'))).toContain('Queued');
    expect(queueVehicleWork(game, v, order('install'))).toContain('Queued');
    expect(v.parts).toContain(solar);
    expect(startVehicleWork(game, v)).toBe(true);
    advance(game, 10000);
    expect(v.parts).not.toContain(solar);
    expect(v.workOrders).toHaveLength(1);
    advance(game, 10000);
    expect(v.workOrders).toHaveLength(0);
    expect(v.parts.filter(p => p.def.id === 'solar_panel')).toHaveLength(1);
  });
  it('a removed turret comes off as its gun with the rounds still in it (BN properties_to_item)', () => {
    const { game, v } = setup();
    adoptVehicle(game, v);
    v.removePart(v.parts.find(p => p.def.id === 'solar_panel')!);
    const turret = v.addPart(vdata.parts.mounted_browning, 0, 0);
    turret.gun = createItem(data, 'm2browning');
    turret.gun.flags.push('VEHICLE');
    loadAmmo(turret.gun, '50bmg', 37);
    expect(queueVehicleWork(game, v, order('removal', 'mounted_browning'))).toContain('Queued');
    expect(startVehicleWork(game, v)).toBe(true);
    advance(game, 10000);
    expect(v.parts).not.toContain(turret);
    const [x, y] = v.mountToWorld(0, 0);
    const gun = game.map.itemsAt(Math.floor(x), Math.floor(y), v.z).find(i => i.typeId === 'm2browning') as Item;
    expect(gun).toBeDefined();
    expect(gun.ammoRemaining()).toBe(37);
    expect(gun.ammoData()?.id).toBe('50bmg');
    expect(gun.hasFlag('VEHICLE')).toBe(false);
  });
  it('permits a staged remove-install-remove cycle and repeated stripping has meaningful blockers', () => {
    const { game, v } = setup();
    adoptVehicle(game, v); game.player.setSkill('mechanics', 4);
    spawnItem(createItem(data, 'solar_panel'), L.inv(game.player), { force: true });
    expect(queueVehicleWork(game, v, order('removal'))).toContain('Queued');
    expect(queueVehicleWork(game, v, order('install'))).toContain('Queued');
    expect(queueVehicleWork(game, v, order('removal'))).toContain('Queued');
    expect(v.workOrders.map(job => job.kind)).toEqual(['removal', 'install', 'removal']);
    const battery = v.addPart(vdata.parts.battery_car, 0, 0); battery.charges = 5;
    for (let i = 0; i < 2; i++) {
      const result = queueVehicleStrip(game, v);
      expect(result.queued).toBe(0);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0]).toContain('Empty the fuel or battery');
    }
  });
  it('keeps missing anchors blocked until an earlier mounting job provides them', () => {
    const { game, v } = setup();
    adoptVehicle(game, v);
    v.removePart(v.parts.find(p => p.def.id === 'solar_panel')!);
    const before = v.toJSON();
    const missing = mountReasons(projectedVehicle(v), vdata.parts.fusion_gun, 0, 0);
    expect(missing).toContain('Needs an intact turret mount mount');
    const mountJob = order('install', 'turret_mount');
    const view = projectedVehicle(v, [mountJob]);
    expect(mountReasons(view, vdata.parts.fusion_gun, 0, 0)).not.toContain('Needs an intact turret mount mount');
    expect(queueVehicleWork(game, v, order('install', 'fusion_gun'))).toContain('Needs an intact turret mount mount');
    expect(v.toJSON()).toEqual(before);
  });
  it('extracts BN skill, tool, component, time, anchor and salvage data', () => {
    expect(vdata.parts.solar_panel.requirements?.removal?.seconds).toBe(1800);
    expect(vdata.parts.solar_panel.requirements?.removal?.skills).toEqual([['mechanics', 2]]);
    expect(vdata.parts.solar_panel.requirements?.install?.components).toContainEqual([{ id: 'solar_panel', count: 1 }]);
    expect(Object.values(vdata.parts).some(p => p.anchors?.length)).toBe(true);
    expect(vdata.parts.solar_panel.breaksInto?.length).toBeGreaterThan(0);
  });
  it('requires adoption, parking, appropriate skills and intact mount sockets', () => {
    const { game, v } = setup();
    expect(vehicleWorkReasons(game, v, order('removal'))).toContain('Adopt this vehicle first');
    adoptVehicle(game, v);
    game.player.setSkill('mechanics', 0);
    expect(vehicleWorkReasons(game, v, order('removal')).some(s => s.includes('2 required'))).toBe(true);
    v.engineOn = true;
    expect(vehicleWorkReasons(game, v, order('removal')).some(s => s.includes('Park'))).toBe(true);
    expect(mountReasons(v, vdata.parts.solar_panel, 0, 0)).toContain('This location is occupied');
    expect(mountReasons(v, vdata.parts.seat, 10, 10)).toContain('A chassis frame is needed at this square');
  });
  it('saves adoption and interrupted work; resumes without duplicate salvage', () => {
    const { game, v, solar } = setup();
    solar.hp /= 2;
    adoptVehicle(game, v);
    expect(queueVehicleWork(game, v, order('removal'))).toContain('Queued');
    expect(startVehicleWork(game, v)).toBe(true);
    advance(game, 450);
    game.activities.cancel('test interruption');
    expect(v.parts.includes(solar)).toBe(true);
    expect(v.workOrders[0].elapsed).toBe(450);
    const loaded = Vehicle.fromJSON(vdata, data, v.toJSON());
    expect(loaded.adopted).toBe(true);
    expect(loaded.workOrders[0].elapsed).toBe(450);
    game.vehicles!.remove(v); game.vehicles!.add(loaded);
    expect(startVehicleWork(game, loaded)).toBe(true);
    advance(game, 1350);
    expect(loaded.workOrders).toHaveLength(0);
    expect(loaded.parts.some(p => p.def.id === 'solar_panel')).toBe(false);
    const salvaged = game.map.itemsAt(Math.floor(v.x), Math.floor(v.y), v.z).filter(it => it.typeId === 'solar_panel');
    expect(salvaged).toHaveLength(1);
    expect((salvaged[0] as Item).damage).toBe(MAX_ITEM_DAMAGE / 2);
    expect(startVehicleWork(game, loaded)).toBe(false);
    expect(loaded.partsAt(0, 0)).toHaveLength(1);
  });
  it('installs a salvaged part without healing its condition or duplicating materials', () => {
    const { game, v, solar } = setup();
    adoptVehicle(game, v);
    game.player.setSkill('mechanics', 4);
    v.removePart(solar);
    const replacement = createItem(data, 'solar_panel'); replacement.damage = MAX_ITEM_DAMAGE / 2;
    spawnItem(replacement, L.inv(game.player), { force: true });
    expect(queueVehicleWork(game, v, order('install'))).toContain('Queued');
    expect(startVehicleWork(game, v)).toBe(true);
    advance(game, 3600);
    expect(v.partsAt(0, 0).find(p => p.def.id === 'solar_panel')?.hp).toBe(vdata.parts.solar_panel.durability / 2);
    expect(game.player.inv.allItems().includes(replacement)).toBe(false);
    expect(v.workOrders).toHaveLength(0);
  });
  it('refuses removal of loaded fuel/cargo and installation of loaded batteries', () => {
    const { game, v } = setup(); adoptVehicle(game, v);
    const battery = v.addPart(vdata.parts.battery_car, 0, 0); battery.charges = 100;
    expect(vehicleWorkReasons(game, v, order('removal', 'battery_car')).some(s => s.includes('Empty the fuel'))).toBe(true);
    v.removePart(battery);
    const loaded = createItem(data, 'battery_car');
    loadAmmo(loaded, 'battery', 100);
    spawnItem(loaded, L.inv(game.player), { force: true });
    expect(vehicleWorkReasons(game, v, order('install', 'battery_car'))).toContain('Unload and empty the part before installing it');
  });
  it('stops a completing tick when a required tool disappears', () => {
    const { game, v, solar } = setup(); adoptVehicle(game, v);
    queueVehicleWork(game, v, order('removal')); startVehicleWork(game, v);
    const wrench = game.player.inv.allItems().find(it => it.typeId === 'wrench')!;
    consumeItem(wrench, game.player.inv.locOf(wrench)!);
    game.map.itemsAt = () => [];
    // Move beyond the nearby ground tool, while retaining reach of the vehicle.
    game.player.x += 3;
    advance(game, 1800);
    expect(v.parts.includes(solar)).toBe(true);
    expect(v.workOrders).toHaveLength(1);
    expect(game.activities.current).toBeNull();
  });
});

describe('vehicle work conservation and failures', () => {
  it('retains installation metadata through save and removal', () => {
    const { game, v, solar } = setup(); adoptVehicle(game, v); game.player.setSkill('mechanics', 4); v.removePart(solar);
    const replacement = createItem(data, 'solar_panel'); replacement.vars.label = 'roof reserve';
    spawnItem(replacement, L.inv(game.player), { force: true });
    queueVehicleWork(game, v, order('install')); startVehicleWork(game, v); advance(game, 3600);
    const loaded = Vehicle.fromJSON(vdata, data, v.toJSON());
    game.vehicles!.remove(v); game.vehicles!.add(loaded);
    queueVehicleWork(game, loaded, order('removal')); startVehicleWork(game, loaded); advance(game, 1800);
    const item = game.map.itemsAt(Math.floor(v.x), Math.floor(v.y), v.z).find(it => it.typeId === 'solar_panel') as Item;
    expect(item.vars.label).toBe('roof reserve');
    expect(loaded.parts).toHaveLength(1);
  });
  it('rechecks parts moved or removed after a queue is saved', () => {
    const { game, v, solar } = setup(); adoptVehicle(game, v);
    queueVehicleWork(game, v, order('removal'));
    v.removePart(solar);
    expect(startVehicleWork(game, v)).toBe(false);
    expect(v.workOrders).toHaveLength(1);
  });
  it('requires cargo emptied before removal', () => {
    const { game, v } = setup(); adoptVehicle(game, v);
    const cargo = v.addPart(vdata.parts.trunk, 0, 0);
    spawnItem(createItem(data, 'rock'), L.cargo(cargo, v));
    expect(vehicleWorkReasons(game, v, order('removal', 'trunk'))).toContain('Empty the cargo before removing it');
  });
  it('fully repairs with damage-scaled BN material requirements', () => {
    const { game, v, solar } = setup(); adoptVehicle(game, v);
    solar.def = { ...solar.def, requirements: { ...solar.def.requirements, repair: { seconds: 20, skills: [], tools: [], qualities: [], components: [[{ id: 'scrap', count: 1 }]] } } };
    // The definition used by work is shared vehicle data; isolate this fixture's map.
    const localData = { ...vdata, parts: { ...vdata.parts, solar_panel: solar.def } };
    const copy = Vehicle.fromJSON(localData, data, v.toJSON());
    copy.parts.find(p => p.def.id === 'solar_panel')!.hp = solar.def.durability / 2;
    game.vehicles!.remove(v); game.vehicles!.add(copy);
    const scrap = createItem(data, 'scrap'); spawnItem(scrap, L.inv(game.player), { force: true });
    spawnItem(createItem(data, 'scrap'), L.inv(game.player), { force: true });
    expect(queueVehicleWork(game, copy, order('repair'))).toContain('Queued');
    expect(startVehicleWork(game, copy)).toBe(true);
    advance(game, 20);
    expect(copy.parts.find(p => p.def.id === 'solar_panel')!.hp).toBe(solar.def.durability);
    expect(game.player.inv.allItems().includes(scrap)).toBe(false);
  });
});

describe('installation source selection', () => {
  it('uses an empty base when a loaded matching base was gathered earlier', () => {
    const { game, v } = setup(); adoptVehicle(game, v);
    const loaded = createItem(data, 'battery_car'); loadAmmo(loaded, 'battery', 100);
    const empty = createItem(data, 'battery_car');
    expect(spawnItem(loaded, L.inv(game.player), { force: true }).ok).toBe(true);
    expect(spawnItem(empty, L.inv(game.player), { force: true }).ok).toBe(true);
    expect(queueVehicleWork(game, v, order('install', 'battery_car'))).toContain('Queued');
    startVehicleWork(game, v); advance(game, 50);
    expect(v.parts.some(p => p.def.id === 'battery_car')).toBe(true);
    expect(game.player.inv.allItems().includes(loaded)).toBe(true);
    expect(loaded.ammoRemaining()).toBe(100);
    expect(game.player.inv.allItems().includes(empty)).toBe(false);
  });
});

describe('vehicle work learning', () => {
  it('grants BN practice only after successful completion', () => {
    const { game, v } = setup(); adoptVehicle(game, v);
    queueVehicleWork(game, v, order('removal')); startVehicleWork(game, v); advance(game, 450);
    expect(game.player.skills.mechanics.exercise).toBe(0);
    advance(game, 1350);
    expect(game.player.skills.mechanics.exercise).toBeGreaterThan(0);
  });
});

describe('failed work resource rollback', () => {
  it('restores materials and charged tools when shared groups exceed available ammunition', () => {
    const { game, v, solar } = setup(); adoptVehicle(game, v);
    const def = { ...solar.def, requirements: { ...solar.def.requirements, repair: { seconds: 20, skills: [], qualities: [], components: [[{ id: 'scrap', count: 1 }]], tools: [[{ id: 'soldering_iron', count: 10 }], [{ id: 'soldering_iron', count: 10 }]] } } };
    const copy = Vehicle.fromJSON({ ...vdata, parts: { ...vdata.parts, solar_panel: def } }, data, v.toJSON());
    copy.parts.find(p => p.def.id === 'solar_panel')!.hp = def.durability * 0.75;
    game.vehicles!.remove(v); game.vehicles!.add(copy);
    const scrap = createItem(data, 'scrap');
    const iron = createItem(data, 'soldering_iron', { ammo: 'battery', ammoCount: 15 });
    expect(spawnItem(scrap, L.inv(game.player), { force: true }).ok).toBe(true);
    expect(spawnItem(iron, L.inv(game.player), { force: true }).ok).toBe(true);
    expect(iron.ammoRemaining()).toBe(15);
    expect(queueVehicleWork(game, copy, order('repair'))).toContain('Queued');
    expect(startVehicleWork(game, copy)).toBe(true);
    advance(game, 5);
    expect(copy.parts.find(p => p.def.id === 'solar_panel')!.hp).toBe(def.durability * 0.75);
    expect(copy.workOrders).toHaveLength(1);
    expect(game.player.inv.allItems().includes(scrap)).toBe(true);
    expect(iron.ammoRemaining()).toBe(15);
  });
});

describe('chassis integrity', () => {
  it('requires an intact structural frame before fitting parts', () => {
    const { v, solar } = setup();
    v.removePart(solar);
    v.parts[0].hp = 0;
    expect(mountReasons(v, vdata.parts.solar_panel, 0, 0)).toContain('A chassis frame is needed at this square');
  });
});
