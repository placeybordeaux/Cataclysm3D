import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Vehicle } from '../src/game/vehicle';
import type { VehicleDataFile } from '../src/game/vehicle_data';
import { mountReasons, projectedVehicle } from '../src/game/vehicleWork';
let vd:VehicleDataFile;
beforeAll(()=>{vd=JSON.parse(readFileSync('public/data/vehicles.json','utf8'));});
function setup(){const v=new Vehicle(vd,'car');v.template='frame';v.addPart(vd.parts.frame_vertical,0,0);return v;}
describe('BN mounting exclusions',()=>{
  it('extracts source engine exclusion classes and enforces them vehicle-wide',()=>{
    const v=setup();v.addPart(vd.parts.sail,0,0);v.addPart(vd.parts.frame_vertical,1,0);
    expect(vd.parts.sail.engineExcludes).toEqual(['wind']);expect(vd.parts.sail_large.engineExcludes).toEqual(['wind']);
    expect(mountReasons(v,vd.parts.sail_large,1,0).some(r=>r.includes('wind engine class'))).toBe(true);
    const projected=projectedVehicle(v,[{kind:'removal',part:'sail',mx:0,my:0,elapsed:0}]);
    expect(mountReasons(projected,vd.parts.sail_large,1,0).some(r=>r.includes('engine class'))).toBe(false);
    expect(v.parts.some(p=>p.def.id==='sail')).toBe(true);
  });
  it('rejects mirrors on opaque parts and opaque parts on mirrors',()=>{
    const v=setup();v.addPart(vd.parts.door_opaque,0,0);
    expect(mountReasons(v,vd.parts.wing_mirror,0,0)).toContain('A mirror cannot share a square with an opaque part');
    const inverse=setup();inverse.addPart(vd.parts.wing_mirror,0,0);
    expect(mountReasons(inverse,vd.parts.door_opaque,0,0)).toContain('An opaque part cannot share a square with a mirror');
  });
  it('permits the BN camera exception to mirror/opaque exclusions',()=>{
    const v=setup();v.addPart(vd.parts.omnicam,0,0);
    expect(mountReasons(v,vd.parts.door_opaque,0,0)).not.toContain('An opaque part cannot share a square with a mirror');
    const inverse=setup();inverse.addPart(vd.parts.door_opaque,0,0);
    expect(mountReasons(inverse,vd.parts.omnicam,0,0)).not.toContain('A mirror cannot share a square with an opaque part');
  });
  it('prevents stacking different turret mounts and powered controls on manual mounts',()=>{
    const v=setup();v.addPart(vd.parts.turret_mount_manual_wood,0,0);
    expect(mountReasons(v,vd.parts.turret_mount,0,0)).toContain('This square already has a turret mount');
    for(const id of ['controls_turret','laser_designator_part']) expect(mountReasons(v,vd.parts[id],0,0)).toContain('Manual-only turrets cannot use turret controls or laser designators');
  });
  it('prevents attachments on an existing EXTENDABLE buoyancy cell',()=>{
    const v=setup();v.addPart(vd.parts.gas_sac_buoyancy_cell_external,0,0);
    expect(mountReasons(v,vd.parts.solar_panel,0,0)).toContain('This square cannot hold attachments');
  });
});
